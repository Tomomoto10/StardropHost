/**
 * StardropHost | web-panel/api/panel-update.js
 * Checks GitHub for StardropHost updates by comparing the latest commit
 * timestamp against the image build timestamp baked in at docker build time.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const config = require('../server');

const CHECK_FILE       = path.join(config.DATA_DIR, 'panel-update-available.json');
const BUILD_STAMP_FILE = path.join(__dirname, '..', 'build-timestamp.txt');

const GITHUB_REPO   = 'Tomomoto10/StardropHost-dev';
const GITHUB_BRANCH = 'main';

let _checkTimer = null;

// ── Helpers ──────────────────────────────────────────────────────

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function getBuildTimestamp() {
  try {
    const raw = fs.readFileSync(BUILD_STAMP_FILE, 'utf-8').trim();
    const ts  = parseInt(raw, 10);
    return isNaN(ts) ? null : ts;
  } catch { return null; }
}

function fetchLatestCommit() {
  return new Promise((resolve) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`;
    const req = https.get(url, {
      headers: { 'User-Agent': 'StardropHost/1.0', 'Accept': 'application/vnd.github.v3+json' },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const sha     = json.sha || null;
          const dateStr = json.commit?.committer?.date || json.commit?.author?.date || null;
          const ts      = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : null;
          const message = json.commit?.message?.split('\n')[0] || null;
          resolve({ sha, ts, message });
        } catch { resolve(null); }
      });
    });
    req.on('error',   () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function getCheckIntervalMs() {
  const hours = parseFloat(process.env.PANEL_UPDATE_CHECK_HOURS || '24');
  return Math.max(1, hours) * 60 * 60 * 1000;
}

// ── Core check ───────────────────────────────────────────────────

async function runCheck() {
  const buildTs = getBuildTimestamp();
  const latest  = await fetchLatestCommit();

  if (!latest) {
    // Can't reach GitHub — preserve existing result
    return readJsonSafe(CHECK_FILE);
  }

  const available = buildTs !== null && latest.ts !== null && latest.ts > buildTs;
  const result = {
    available,
    buildTimestamp:  buildTs,
    latestCommitSha: latest.sha,
    latestCommitTs:  latest.ts,
    latestMessage:   latest.message,
    checkedAt:       new Date().toISOString(),
  };

  try { fs.writeFileSync(CHECK_FILE, JSON.stringify(result)); } catch {}
  return result;
}

// ── Background loop ──────────────────────────────────────────────

function startBackgroundCheck() {
  // Run once shortly after startup (5s delay — let panel settle)
  setTimeout(async () => {
    await runCheck();
    scheduleNext();
  }, 5000);
}

function scheduleNext() {
  const ms = getCheckIntervalMs();
  _checkTimer = setTimeout(async () => {
    await runCheck();
    scheduleNext();
  }, ms);
}

// ── API handlers ─────────────────────────────────────────────────

// GET /api/panel-update/status
function getStatus(req, res) {
  const check = readJsonSafe(CHECK_FILE);
  res.json({
    available:       check?.available       ?? false,
    buildTimestamp:  check?.buildTimestamp  ?? getBuildTimestamp(),
    latestCommitSha: check?.latestCommitSha ?? null,
    latestMessage:   check?.latestMessage   ?? null,
    checkedAt:       check?.checkedAt       ?? null,
  });
}

// POST /api/panel-update/check  — force a check right now
async function checkNow(req, res) {
  const result = await runCheck();
  if (!result) return res.json({ available: false, reason: 'check_failed' });
  res.json(result);
}

module.exports = { getStatus, checkNow, startBackgroundCheck };
