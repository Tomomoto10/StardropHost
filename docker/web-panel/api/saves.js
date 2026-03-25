/**
 * StardropHost | web-panel/api/saves.js
 * Save file listing, selection, backup and restore
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../server');

const BACKUP_STATUS_FILE = path.join(config.DATA_DIR, 'backup-status.json');
const STARTUP_PREFS_FILE = path.join(config.CONFIG_DIR, 'startup_preferences');
let activeBackup = null;

// -- Helpers --

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function isSuccessful(result) {
  return result && result.status === 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options });
  if (!isSuccessful(result)) {
    const reason = result.error
      ? result.error.message
      : (result.stderr || result.stdout || 'unknown error').trim();
    throw new Error(`${command} failed: ${reason}`);
  }
  return result.stdout || '';
}

function removePath(targetPath) {
  if (fs.existsSync(targetPath)) runCommand('rm', ['-rf', targetPath]);
}

function getBackupCompressionLevel() {
  const raw = parseInt(process.env.BACKUP_COMPRESSION_LEVEL || '1', 10);
  return Number.isNaN(raw) ? 1 : Math.min(9, Math.max(1, raw));
}

function getTarGzipArgs(outputPath, sourceBaseDir, sourceNames, verbose) {
  const level = getBackupCompressionLevel();
  const args  = ['-I', `gzip -${level}`, verbose ? '-cvf' : '-cf', outputPath, '-C', sourceBaseDir];
  return args.concat(sourceNames);
}

// -- Save selection --
// Source of truth: startup_preferences saveFolderName= (read by AlwaysOnServer/ServerAutoLoad)
// Secondary:       .selected_save marker (used by save-selector.sh)

function getSelectedSaveName() {
  // Primary: startup_preferences (XML: <saveFolderName>...</saveFolderName>)
  try {
    if (fs.existsSync(STARTUP_PREFS_FILE)) {
      const content = fs.readFileSync(STARTUP_PREFS_FILE, 'utf-8');
      const match   = content.match(/<saveFolderName>([^<]+)<\/saveFolderName>/);
      if (match && match[1].trim()) return match[1].trim();
    }
  } catch {}

  // Fallback: .selected_save marker
  try {
    const markerPath = path.join(config.SAVES_DIR, '.selected_save');
    if (fs.existsSync(markerPath)) {
      const selected = fs.readFileSync(markerPath, 'utf-8').trim();
      if (selected) return selected;
    }
  } catch {}

  return '';
}

function setSelectedSaveName(saveName) {
  if (!saveName) throw new Error('Save name is required');

  ensureDir(config.SAVES_DIR);

  const saveDir = path.join(config.SAVES_DIR, saveName);
  if (!fs.existsSync(saveDir)) throw new Error('Selected save does not exist');

  // Write startup_preferences (XML: <saveFolderName>, read by AlwaysOnServer/ServerAutoLoad)
  try {
    ensureDir(path.dirname(STARTUP_PREFS_FILE));
    let content = '';
    if (fs.existsSync(STARTUP_PREFS_FILE)) {
      content = fs.readFileSync(STARTUP_PREFS_FILE, 'utf-8');
    }
    if (content.match(/<saveFolderName>/)) {
      content = content.replace(/<saveFolderName>[^<]*<\/saveFolderName>/, `<saveFolderName>${saveName}</saveFolderName>`);
    } else {
      // Insert before closing tag
      content = content.replace('</StartupPreferences>', `  <saveFolderName>${saveName}</saveFolderName>\n</StartupPreferences>`);
    }
    fs.writeFileSync(STARTUP_PREFS_FILE, content, 'utf-8');
  } catch {}

  // Write .selected_save marker (read by save-selector.sh)
  fs.writeFileSync(path.join(config.SAVES_DIR, '.selected_save'), `${saveName}\n`, 'utf-8');
}

// -- Save metadata --

function parseSaveGameInfo(savePath) {
  const meta = {
    farmName:   null,
    playerName: null,
    year:       null,
    season:     null,
    day:        null,
    playtimeHours: null,
  };

  try {
    const infoPath = path.join(savePath, 'SaveGameInfo');
    if (!fs.existsSync(infoPath)) return meta;

    const xml = fs.readFileSync(infoPath, 'utf-8');

    const farmName   = xml.match(/<farmName>([^<]+)<\/farmName>/);
    const playerName = xml.match(/<name>([^<]+)<\/name>/);
    const year       = xml.match(/<year>([^<]+)<\/year>/);
    const season     = xml.match(/<currentSeason>([^<]+)<\/currentSeason>/);
    const day        = xml.match(/<dayOfMonth>([^<]+)<\/dayOfMonth>/);
    const playtime   = xml.match(/<millisecondsPlayed>([^<]+)<\/millisecondsPlayed>/);

    if (farmName)   meta.farmName   = farmName[1];
    if (playerName) meta.playerName = playerName[1];
    if (year)       meta.year       = parseInt(year[1], 10);
    if (season)     meta.season     = season[1];
    if (day)        meta.day        = parseInt(day[1], 10);
    if (playtime)   meta.playtimeHours = Math.floor(parseInt(playtime[1], 10) / 3600000);
  } catch {}

  return meta;
}

// -- Save validation --

function isValidSaveDirectory(saveDir) {
  if (!fs.existsSync(saveDir)) return false;
  const folderName = path.basename(saveDir);
  return fs.existsSync(path.join(saveDir, 'SaveGameInfo')) &&
         fs.existsSync(path.join(saveDir, folderName));
}

function findSaveDirectories(rootDir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(rootDir)) return [];
  if (isValidSaveDirectory(rootDir)) return [rootDir];

  const found = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    found.push(...findSaveDirectories(path.join(rootDir, entry.name), maxDepth, depth + 1));
  }
  return found;
}

// -- Backup helpers --

function createOverwriteBackup(saveNames) {
  if (!saveNames || saveNames.length === 0) return '';

  ensureDir(config.BACKUPS_DIR);

  const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName  = `stardrop-pre-overwrite-${timestamp}.tar.gz`;
  const backupPath  = path.join(config.BACKUPS_DIR, backupName);
  const existing    = saveNames.filter(name => fs.existsSync(path.join(config.SAVES_DIR, name)));

  if (existing.length === 0) return '';

  runCommand('tar', getTarGzipArgs(backupPath, config.SAVES_DIR, existing, false), { timeout: 30000 });
  return backupName;
}

function installSaveArchive(zipPath, setAsDefault) {
  ensureDir(config.SAVES_DIR);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stardrop-save-'));
  try {
    runCommand('unzip', ['-q', '-o', zipPath, '-d', tempRoot], { timeout: 30000 });

    const saveDirs = findSaveDirectories(tempRoot);
    if (saveDirs.length === 0) {
      throw new Error('No valid Stardew Valley save folders found in the archive');
    }

    const collidingNames  = saveDirs
      .map(d => path.basename(d))
      .filter(name => fs.existsSync(path.join(config.SAVES_DIR, name)));

    const overwriteBackup = createOverwriteBackup(collidingNames);

    const importedSaves   = [];
    const overwrittenSaves = [];

    for (const saveDir of saveDirs) {
      const saveName = path.basename(saveDir);
      const destDir  = path.join(config.SAVES_DIR, saveName);

      if (fs.existsSync(destDir)) {
        overwrittenSaves.push(saveName);
        removePath(destDir);
      }

      runCommand('cp', ['-a', saveDir, destDir], { timeout: 30000 });
      importedSaves.push(saveName);
    }

    let defaultSaveName = '';
    let defaultApplied  = false;
    let defaultSkipped  = false;

    if (setAsDefault && importedSaves.length === 1) {
      defaultSaveName = importedSaves[0];
      setSelectedSaveName(defaultSaveName);
      defaultApplied = true;
    } else if (setAsDefault) {
      defaultSkipped = true;
    }

    return { importedSaves, overwrittenSaves, overwriteBackup, defaultSaveName, defaultApplied, defaultSkipped };
  } finally {
    removePath(tempRoot);
  }
}

// -- Backup job tracking --

function createEmptyStatus() {
  return {
    id: null, state: 'idle', progress: 0,
    processedEntries: 0, totalEntries: 0,
    backupName: '', backupPath: '',
    startedAt: null, completedAt: null,
    message: '', error: '', pid: null, size: 0,
  };
}

function readBackupStatus() {
  try {
    if (!fs.existsSync(BACKUP_STATUS_FILE)) return createEmptyStatus();
    return { ...createEmptyStatus(), ...JSON.parse(fs.readFileSync(BACKUP_STATUS_FILE, 'utf-8')) };
  } catch {
    return createEmptyStatus();
  }
}

function writeBackupStatus(status) {
  ensureDir(config.DATA_DIR);
  fs.writeFileSync(BACKUP_STATUS_FILE, JSON.stringify({ ...createEmptyStatus(), ...status }, null, 2));
}

function isProcessRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function countEntries(rootDir) {
  let total = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      total++;
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return total;
}

function cleanupOldBackups() {
  const maxBackups = parseInt(process.env.MAX_BACKUPS || '7', 10);
  if (!maxBackups || maxBackups < 1 || !fs.existsSync(config.BACKUPS_DIR)) return;

  fs.readdirSync(config.BACKUPS_DIR)
    .filter(f => f.endsWith('.tar.gz') || f.endsWith('.zip'))
    .map(f => {
      const fp = path.join(config.BACKUPS_DIR, f);
      return { fp, mtimeMs: fs.statSync(fp).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(maxBackups)
    .forEach(item => { try { fs.unlinkSync(item.fp); } catch {} });
}

function getBackupStatusSnapshot() {
  const status = readBackupStatus();

  if (status.state === 'running' && status.pid && !isProcessRunning(status.pid)) {
    if (status.backupPath && fs.existsSync(status.backupPath)) {
      const completedStatus = {
        ...status,
        state: 'completed', progress: 100,
        completedAt: status.completedAt || new Date().toISOString(),
        message: 'Backup completed',
        size: fs.statSync(status.backupPath).size,
        pid: null, error: '',
      };
      writeBackupStatus(completedStatus);
      return completedStatus;
    }

    const failedStatus = {
      ...status,
      state: 'failed', progress: status.progress || 0,
      completedAt: new Date().toISOString(),
      message: 'Backup process stopped unexpectedly',
      error: status.error || 'Backup process stopped unexpectedly',
      pid: null,
    };
    writeBackupStatus(failedStatus);
    return failedStatus;
  }

  return status;
}

function startBackupJob() {
  if (!fs.existsSync(config.SAVES_DIR)) throw new Error('Save directory not found');

  ensureDir(config.BACKUPS_DIR);
  ensureDir(config.DATA_DIR);

  const timestamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName   = `stardrop-manual-backup-${timestamp}.tar.gz`;
  const backupPath   = path.join(config.BACKUPS_DIR, backupName);
  const totalEntries = Math.max(1, countEntries(config.SAVES_DIR) + 1);
  const taskId       = `backup-${Date.now()}`;

  const initialStatus = {
    id: taskId, state: 'running', progress: 1,
    processedEntries: 0, totalEntries,
    backupName, backupPath,
    startedAt: new Date().toISOString(),
    completedAt: null, message: 'Preparing backup',
    error: '', pid: null, size: 0,
  };
  writeBackupStatus(initialStatus);

  const tarProc = spawn('tar', getTarGzipArgs(
    backupPath,
    path.dirname(config.SAVES_DIR),
    [path.basename(config.SAVES_DIR)],
    true
  ), { stdio: ['ignore', 'pipe', 'pipe'] });

  activeBackup = { id: taskId, pid: tarProc.pid, backupPath };
  writeBackupStatus({ ...initialStatus, pid: tarProc.pid, message: 'Archiving save files' });

  let processedEntries = 0;
  let stdoutBuffer     = '';
  let stderrOutput     = '';
  let lastPersistAt    = 0;

  function persistRunningStatus(force) {
    const now = Date.now();
    if (!force && now - lastPersistAt < 250) return;
    lastPersistAt = now;
    writeBackupStatus({
      ...initialStatus, pid: tarProc.pid, state: 'running',
      processedEntries, totalEntries,
      progress: Math.min(99, Math.max(1, Math.round((processedEntries / totalEntries) * 100))),
      message: 'Archiving save files',
    });
  }

  tarProc.stdout.on('data', chunk => {
    stdoutBuffer += chunk.toString();
    const lines  = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) { if (line.trim()) processedEntries++; }
    persistRunningStatus(false);
  });

  tarProc.stderr.on('data', chunk => {
    stderrOutput += chunk.toString();
    if (stderrOutput.length > 4000) stderrOutput = stderrOutput.slice(-4000);
  });

  tarProc.on('error', error => {
    activeBackup = null;
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    writeBackupStatus({
      ...initialStatus, state: 'failed', progress: 0,
      completedAt: new Date().toISOString(),
      message: 'Backup failed to start', error: error.message, pid: null,
    });
  });

  tarProc.on('close', code => {
    if (stdoutBuffer.trim()) processedEntries++;
    activeBackup = null;

    if (code === 0 && fs.existsSync(backupPath)) {
      cleanupOldBackups();
      writeBackupStatus({
        ...initialStatus, state: 'completed', progress: 100,
        processedEntries: totalEntries, totalEntries,
        completedAt: new Date().toISOString(), message: 'Backup completed',
        pid: null, size: fs.statSync(backupPath).size, error: '',
      });
      return;
    }

    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    writeBackupStatus({
      ...initialStatus, state: 'failed',
      progress: Math.min(99, Math.max(0, Math.round((processedEntries / totalEntries) * 100))),
      processedEntries, totalEntries,
      completedAt: new Date().toISOString(), message: 'Backup failed',
      error: stderrOutput.trim() || `tar exited with code ${code}`, pid: null,
    });
  });

  return getBackupStatusSnapshot();
}

// -- Route Handlers --

function getSaves(req, res) {
  try {
    if (!fs.existsSync(config.SAVES_DIR)) {
      return res.json({ saves: [], selectedSave: '' });
    }

    const selectedSave = getSelectedSaveName();
    const saves = [];

    for (const entry of fs.readdirSync(config.SAVES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const saveDir  = path.join(config.SAVES_DIR, entry.name);
      const saveFile = path.join(saveDir, entry.name);
      const gameMeta = parseSaveGameInfo(saveDir);

      const info = {
        name:       entry.name,
        isSelected: entry.name === selectedSave,
        size:       0,
        lastModified: null,
        files:      0,
        ...gameMeta,
      };

      try {
        if (fs.existsSync(saveFile)) {
          const stat      = fs.statSync(saveFile);
          info.size        = stat.size;
          info.lastModified = stat.mtime.toISOString();
        }
        info.files = fs.readdirSync(saveDir).length;
      } catch {}

      saves.push(info);
    }

    saves.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return new Date(b.lastModified) - new Date(a.lastModified);
    });

    res.json({ saves, selectedSave });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list saves', details: e.message });
  }
}

function getBackups(req, res) {
  try {
    if (!fs.existsSync(config.BACKUPS_DIR)) {
      return res.json({ backups: [] });
    }

    const backups = fs.readdirSync(config.BACKUPS_DIR)
      .filter(f => f.endsWith('.tar.gz') || f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(config.BACKUPS_DIR, f));
        return { filename: f, size: stat.size, date: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ backups });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list backups', details: e.message });
  }
}

function getBackupStatus(req, res) {
  try {
    res.json(getBackupStatusSnapshot());
  } catch (e) {
    res.status(500).json({ error: 'Failed to read backup status', details: e.message });
  }
}

function createBackup(req, res) {
  try {
    const current = getBackupStatusSnapshot();
    if (current.state === 'running') {
      return res.status(202).json({
        success: true, alreadyRunning: true,
        message: 'Backup already in progress', status: current,
      });
    }

    const status = startBackupJob();
    res.status(202).json({ success: true, accepted: true, message: 'Backup started', status });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create backup', details: e.message });
  }
}

function uploadSave(req, res) {
  try {
    const body         = req.body || {};
    let   filename     = body.filename;
    const data         = body.data;
    const setAsDefault = body.setAsDefault === true || body.setAsDefault === 'true';

    if (!filename || !data) {
      return res.status(400).json({ error: 'Missing filename or data' });
    }

    filename = path.basename(filename);
    if (!/\.zip$/i.test(filename)) {
      return res.status(400).json({ error: 'Only .zip save archives are supported' });
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Invalid archive data' });
    if (buffer.length > 40 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 40MB)' });

    const tempZip = path.join(os.tmpdir(), `stardrop-save-upload-${Date.now()}.zip`);
    fs.writeFileSync(tempZip, buffer);

    try {
      const result = installSaveArchive(tempZip, setAsDefault);
      const parts  = [
        result.importedSaves.length === 1
          ? `Imported save ${result.importedSaves[0]}`
          : `Imported ${result.importedSaves.length} save folders`,
      ];

      if (result.overwrittenSaves.length > 0)
        parts.push(`overwrote ${result.overwrittenSaves.length} existing save(s)`);
      if (result.overwriteBackup)
        parts.push(`backup created: ${result.overwriteBackup}`);
      if (result.defaultApplied)
        parts.push(`selected save set to ${result.defaultSaveName}`);
      else if (result.defaultSkipped)
        parts.push('selected save unchanged — archive contained multiple saves');

      res.json({
        success: true, message: parts.join(', '),
        importedSaves:   result.importedSaves,
        overwrittenSaves: result.overwrittenSaves,
        overwriteBackup: result.overwriteBackup,
        defaultSaveName: result.defaultSaveName,
        defaultApplied:  result.defaultApplied,
        defaultSkipped:  result.defaultSkipped,
        needsRestart: true,
      });
    } finally {
      removePath(tempZip);
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to upload save', details: e.message });
  }
}

function selectSave(req, res) {
  try {
    const saveName = typeof req.body?.saveName === 'string'
      ? req.body.saveName.trim()
      : '';

    if (!saveName) return res.status(400).json({ error: 'Missing saveName' });
    if (saveName.includes('..') || saveName.includes('/')) {
      return res.status(400).json({ error: 'Invalid save name' });
    }

    setSelectedSaveName(saveName);
    res.json({ success: true, message: `Selected save set to ${saveName}`, saveName, needsRestart: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to select save', details: e.message });
  }
}

function downloadBackup(req, res) {
  const { filename } = req.params;

  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(config.BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });

  res.download(filePath, filename);
}

function deleteBackup(req, res) {
  const { filename } = req.params;

  if (filename.includes('..') || filename.includes('/')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filePath = path.join(config.BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });

  try {
    fs.unlinkSync(filePath);
    res.json({ success: true, message: `Deleted ${filename}` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete backup', details: e.message });
  }
}

function deleteSave(req, res) {
  try {
    const saveName = typeof req.params?.name === 'string' ? req.params.name.trim() : '';
    if (!saveName) return res.status(400).json({ error: 'Save name is required' });
    if (saveName.includes('..') || saveName.includes('/')) {
      return res.status(400).json({ error: 'Invalid save name' });
    }

    const saveDir = path.join(config.SAVES_DIR, saveName);
    if (!fs.existsSync(saveDir)) {
      return res.status(404).json({ error: 'Save not found' });
    }

    fs.rmSync(saveDir, { recursive: true, force: true });

    // Clear selection if this was the active save
    try {
      if (getSelectedSaveName() === saveName) {
        const markerPath = path.join(config.SAVES_DIR, '.selected_save');
        if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
        if (fs.existsSync(STARTUP_PREFS_FILE)) {
          const content = fs.readFileSync(STARTUP_PREFS_FILE, 'utf-8')
            .replace(/<saveFolderName>[^<]*<\/saveFolderName>/, '<saveFolderName></saveFolderName>');
          fs.writeFileSync(STARTUP_PREFS_FILE, content, 'utf-8');
        }
      }
    } catch {}

    res.json({ success: true, message: `Save '${saveName}' deleted` });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete save', details: e.message });
  }
}

module.exports = {
  getSaves,
  getBackups,
  getBackupStatus,
  createBackup,
  uploadSave,
  selectSave,
  downloadBackup,
  deleteBackup,
  deleteSave,
};