/**
 * StardropHost | web-panel/api/game-update.js
 * Game update availability check and Steam-based game download trigger.
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { spawn } = require('child_process');
const config  = require('../server');

const CHECK_FILE   = path.join(config.DATA_DIR, 'game-update-available.json');
const STATUS_FILE  = path.join(config.DATA_DIR, 'game-update-status.json');
const LOG_FILE     = path.join(config.DATA_DIR, 'game-update.log');
const CREDS_FILE   = path.join(config.DATA_DIR, 'game-update-creds.json');
const MANIFEST     = path.join(config.GAME_DIR, 'steamapps', 'appmanifest_413150.acf');
const UPDATE_SCRIPT = '/home/steam/scripts/game-update.sh';

// Track the running update process
let updateProcess = null;

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function getInstalledBuildId() {
  try {
    const manifest = fs.readFileSync(MANIFEST, 'utf-8');
    return manifest.match(/"buildid"\s+"(\d+)"/)?.[1] || null;
  } catch { return null; }
}

function fetchLatestBuildId() {
  return new Promise((resolve) => {
    const req = https.get(
      'https://api.steamcmd.net/v1/info/413150',
      { headers: { 'User-Agent': 'StardropHost/1.0' }, timeout: 12000 },
      (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json?.data?.['413150']?.appinfo?.depots?.branches?.public?.buildid || null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// GET /api/game-update/status
function getStatus(req, res) {
  const check  = readJsonSafe(CHECK_FILE);
  const update = readJsonSafe(STATUS_FILE);

  let logLines = [];
  try {
    logLines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean).slice(-150);
  } catch {}

  res.json({
    available:     check?.available     ?? false,
    currentBuild:  check?.currentBuild  || getInstalledBuildId(),
    latestBuild:   check?.latestBuild   || null,
    checkedAt:     check?.checkedAt     || null,
    reason:        check?.reason        || null,
    update:        update               || null,
    log:           logLines,
    running:       updateProcess !== null,
  });
}

// POST /api/game-update/check  — force a build-ID check right now
async function checkNow(req, res) {
  const installedBuild = getInstalledBuildId();

  if (!installedBuild) {
    const result = { available: false, reason: 'no_manifest', checkedAt: new Date().toISOString() };
    try { fs.writeFileSync(CHECK_FILE, JSON.stringify(result)); } catch {}
    return res.json(result);
  }

  const latestBuild = await fetchLatestBuildId();

  if (!latestBuild) {
    const result = { available: false, reason: 'check_failed', checkedAt: new Date().toISOString() };
    try { fs.writeFileSync(CHECK_FILE, JSON.stringify(result)); } catch {}
    return res.json(result);
  }

  const available = installedBuild !== latestBuild;
  const result = { available, currentBuild: installedBuild, latestBuild, checkedAt: new Date().toISOString() };
  try { fs.writeFileSync(CHECK_FILE, JSON.stringify(result)); } catch {}
  res.json(result);
}

// POST /api/game-update/start  — begin download with credentials
function startUpdate(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Steam username and password are required' });
  }
  if (updateProcess) {
    return res.status(409).json({ error: 'An update is already in progress' });
  }

  // Write credentials to a locked temp file — cleared by game-update.sh after use
  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify({ username: username.trim(), password, guardCode: '' }), { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save credentials', details: e.message });
  }

  // Reset log and status
  try { fs.writeFileSync(LOG_FILE, ''); } catch {}
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'starting', message: 'Starting...' })); } catch {}

  updateProcess = spawn('bash', [UPDATE_SCRIPT], { stdio: 'ignore', detached: false });
  updateProcess.on('exit', () => { updateProcess = null; });

  res.json({ success: true, message: 'Update started' });
}

// POST /api/game-update/guard  — retry with Steam Guard code
function submitGuard(req, res) {
  const { username, password, guardCode } = req.body || {};

  if (!username || !password || !guardCode) {
    return res.status(400).json({ error: 'username, password and guardCode are required' });
  }
  if (updateProcess) {
    return res.status(409).json({ error: 'An update is already in progress' });
  }

  try {
    fs.writeFileSync(CREDS_FILE, JSON.stringify({ username: username.trim(), password, guardCode: guardCode.trim() }), { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: 'Could not save credentials', details: e.message });
  }

  try { fs.writeFileSync(STATUS_FILE, JSON.stringify({ state: 'starting', message: 'Retrying with Guard code...' })); } catch {}

  updateProcess = spawn('bash', [UPDATE_SCRIPT], { stdio: 'ignore', detached: false });
  updateProcess.on('exit', () => { updateProcess = null; });

  res.json({ success: true, message: 'Retrying with Guard code' });
}

module.exports = { getStatus, checkNow, startUpdate, submitGuard };
