/**
 * StardropHost | web-panel/api/mods.js
 * Mod listing, upload and deletion
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../server');

// -- Paths --
// CUSTOM_MODS_DIR  — user-uploaded mods, persisted across container rebuilds
// GAME_MODS_DIR    — active Mods/ folder read by SMAPI at runtime
// BUNDLED_MODS_DIR — mods baked into the image (AlwaysOnServer, ServerAutoLoad, etc.)

const CUSTOM_MODS_DIR  = '/home/steam/custom-mods';
const GAME_MODS_DIR    = path.join(config.GAME_DIR, 'Mods');
const BUNDLED_MODS_DIR = '/home/steam/preinstalled-mods';
const METADATA_SUFFIX  = '.panel-meta.json';

// -- Helpers --

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf-8', ...options });
  if (!result || result.status !== 0) {
    const reason = result.error
      ? result.error.message
      : (result.stderr || result.stdout || 'unknown error').trim();
    throw new Error(`${command} failed: ${reason}`);
  }
  return result.stdout || '';
}

// -- Manifest reading --

function readManifest(modDir, fallbackName) {
  const manifestPath = path.join(modDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return {
      id:          manifest.UniqueID   || fallbackName,
      name:        manifest.Name       || fallbackName,
      version:     manifest.Version    || 'unknown',
      author:      manifest.Author     || 'unknown',
      description: manifest.Description || '',
    };
  } catch {
    return { id: fallbackName, name: fallbackName, version: 'unknown', author: 'unknown', description: '' };
  }
}

function findManifestDirectories(rootDir, maxDepth = 3, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(rootDir)) return [];
  if (fs.existsSync(path.join(rootDir, 'manifest.json'))) return [rootDir];

  const found = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...findManifestDirectories(path.join(rootDir, entry.name), maxDepth, depth + 1));
    }
  }
  return found;
}

// -- Bundled mod detection --
// Mods in BUNDLED_MODS_DIR are baked into the image and cannot be deleted via the panel.

function getBundledModFolders() {
  const folders = new Set();
  if (!fs.existsSync(BUNDLED_MODS_DIR)) return folders;
  for (const entry of fs.readdirSync(BUNDLED_MODS_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) folders.add(entry.name);
  }
  return folders;
}

// -- Upload metadata --
// Each uploaded .zip gets a sidecar .panel-meta.json recording which game Mod/ folders it produced.

function getMetadataPath(baseName) {
  return path.join(CUSTOM_MODS_DIR, `${baseName}${METADATA_SUFFIX}`);
}

function loadMetadata(baseName) {
  const metaPath = getMetadataPath(baseName);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const data  = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    data._path  = metaPath;
    return data;
  } catch {
    return null;
  }
}

function loadAllMetadata() {
  if (!fs.existsSync(CUSTOM_MODS_DIR)) return [];
  return fs.readdirSync(CUSTOM_MODS_DIR)
    .filter(f => f.endsWith(METADATA_SUFFIX))
    .map(f => loadMetadata(f.slice(0, -METADATA_SUFFIX.length)))
    .filter(Boolean);
}

// -- Archive installation --

function installArchiveToGameMods(zipPath) {
  ensureDir(GAME_MODS_DIR);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stardrop-mod-'));
  try {
    runCommand('unzip', ['-q', '-o', zipPath, '-d', tempRoot], { timeout: 30000 });

    const manifestDirs     = findManifestDirectories(tempRoot);
    const installedFolders = [];

    for (const manifestDir of manifestDirs) {
      const folderName = path.basename(manifestDir);
      const destDir    = path.join(GAME_MODS_DIR, folderName);
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.cpSync(manifestDir, destDir, { recursive: true });
      installedFolders.push(folderName);
    }

    return { installedFolders, hasManifest: installedFolders.length > 0 };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

// -- Route Handlers --

function getMods(req, res) {
  const mods           = [];
  const seenFolders    = new Set();
  const bundledFolders = getBundledModFolders();

  // Scan active game Mods/ directory
  try {
    if (fs.existsSync(GAME_MODS_DIR)) {
      for (const entry of fs.readdirSync(GAME_MODS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;

        const manifest = readManifest(path.join(GAME_MODS_DIR, entry.name), entry.name);
        if (!manifest) continue;

        mods.push({
          ...manifest,
          enabled:   true,
          isBundled: bundledFolders.has(entry.name),
          isCustom:  !bundledFolders.has(entry.name),
          folder:    entry.name,
        });
        seenFolders.add(entry.name);
      }
    }
  } catch {}

  // If game is not installed yet, show bundled mods directly from BUNDLED_MODS_DIR
  if (!fs.existsSync(GAME_MODS_DIR) && fs.existsSync(BUNDLED_MODS_DIR)) {
    try {
      for (const entry of fs.readdirSync(BUNDLED_MODS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (seenFolders.has(entry.name)) continue;

        const manifest = readManifest(path.join(BUNDLED_MODS_DIR, entry.name), entry.name);
        if (!manifest) continue;

        mods.push({
          ...manifest,
          enabled:       false,
          isBundled:     true,
          isCustom:      false,
          folder:        entry.name,
          pendingInstall: true,
        });
        seenFolders.add(entry.name);
      }
    } catch {}
  }

  // Scan custom-mods/ for uploads not yet installed (pending restart)
  try {
    if (fs.existsSync(CUSTOM_MODS_DIR)) {
      for (const entry of fs.readdirSync(CUSTOM_MODS_DIR, { withFileTypes: true })) {
        // Skip metadata sidecars
        if (entry.name.endsWith(METADATA_SUFFIX)) continue;

        if (entry.isDirectory()) {
          if (seenFolders.has(entry.name)) continue;

          const manifest = readManifest(path.join(CUSTOM_MODS_DIR, entry.name), entry.name);
          if (!manifest) continue;

          mods.push({ ...manifest, enabled: true, isBundled: false, isCustom: true, folder: entry.name });
          seenFolders.add(entry.name);

        } else if (entry.name.endsWith('.zip')) {
          const baseName = entry.name.replace(/\.zip$/i, '');
          const metadata = loadMetadata(baseName);

          // Skip if all installed folders are already listed
          if (metadata?.installedFolders?.every(f => seenFolders.has(f))) continue;

          mods.push({
            id: entry.name, name: baseName,
            version: 'zip', author: '', folder: baseName,
            description: 'Uploaded mod archive — pending restart',
            enabled: true, isBundled: false, isCustom: true,
          });
        }
      }
    }
  } catch {}

  res.json({ mods, total: mods.length });
}

function uploadMod(req, res) {
  try {
    const body     = req.body || {};
    let   filename = body.filename;
    const data     = body.data;

    if (!filename || !data) {
      return res.status(400).json({ error: 'Missing filename or data' });
    }

    filename = path.basename(filename);
    if (!filename.endsWith('.zip')) {
      return res.status(400).json({ error: 'Only .zip files are supported' });
    }

    try {
      ensureDir(CUSTOM_MODS_DIR);
      ensureDir(GAME_MODS_DIR);
    } catch (e) {
      return res.status(500).json({ error: 'Cannot create mods directory', details: e.message });
    }

    const destPath     = path.join(CUSTOM_MODS_DIR, filename);
    const metadataPath = getMetadataPath(filename.replace(/\.zip$/i, ''));

    if (fs.existsSync(destPath) || fs.existsSync(metadataPath)) {
      return res.status(409).json({ error: 'A mod with this filename already exists' });
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Invalid archive data' });
    if (buffer.length > 50 * 1024 * 1024) return res.status(413).json({ error: 'File too large (max 50MB)' });

    fs.writeFileSync(destPath, buffer);

    try {
      const result = installArchiveToGameMods(destPath);

      if (result.installedFolders.length > 0) {
        fs.writeFileSync(metadataPath, JSON.stringify({
          filename,
          installedFolders: result.installedFolders,
          uploadedAt: new Date().toISOString(),
        }, null, 2));
      }

      res.json({
        success:          true,
        message:          result.hasManifest
                            ? 'Mod installed. Restart the server to load it.'
                            : 'Archive uploaded but no manifest.json found — check the archive structure.',
        filename,
        extracted:        result.hasManifest,
        hasManifest:      result.hasManifest,
        autoInstallFailed: false,
        needsRestart:     true,
        installedFolders: result.installedFolders,
      });
    } catch (e) {
      fs.rmSync(metadataPath, { force: true });
      res.json({
        success:          true,
        message:          'Archive uploaded but automatic installation failed. A restart may still install it.',
        filename,
        extracted:        false,
        hasManifest:      false,
        autoInstallFailed: true,
        needsRestart:     true,
        installedFolders: [],
      });
    }
  } catch (e) {
    res.status(500).json({ error: 'Upload failed', details: e.message });
  }
}

function deleteMod(req, res) {
  let folder = req.params.folder;
  if (!folder) return res.status(400).json({ error: 'Mod folder name is required' });

  folder = path.basename(folder);

  // Protect bundled mods
  if (getBundledModFolders().has(folder)) {
    return res.status(403).json({ error: 'Bundled mods cannot be deleted via the web panel' });
  }

  // Collect all paths to remove (source archive + metadata + installed game folders)
  const allMetadata = loadAllMetadata();
  const matching    = allMetadata.filter(m =>
    m.filename === `${folder}.zip` ||
    (Array.isArray(m.installedFolders) && m.installedFolders.includes(folder))
  );

  const toRemove = new Set([
    path.join(CUSTOM_MODS_DIR, folder),
    path.join(CUSTOM_MODS_DIR, `${folder}.zip`),
    path.join(GAME_MODS_DIR, folder),
  ]);

  for (const meta of matching) {
    toRemove.add(path.join(CUSTOM_MODS_DIR, meta.filename));
    toRemove.add(meta._path);
    if (Array.isArray(meta.installedFolders)) {
      for (const f of meta.installedFolders) toRemove.add(path.join(GAME_MODS_DIR, f));
    }
  }

  if (![...toRemove].some(p => fs.existsSync(p))) {
    return res.status(404).json({ error: 'Custom mod not found' });
  }

  try {
    for (const p of toRemove) fs.rmSync(p, { recursive: true, force: true });
    res.json({ success: true, message: 'Mod deleted', needsRestart: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete mod', details: e.message });
  }
}

module.exports = { getMods, uploadMod, deleteMod };