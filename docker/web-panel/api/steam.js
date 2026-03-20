/**
 * StardropHost | web-panel/api/steam.js
 * Proxy to the steam-auth container for wizard game download (login/guard/logout).
 * The web panel never handles Steam credentials directly — it passes them
 * straight through to the isolated steam-auth service.
 *
 * Invite code is read directly from the ServerDashboard SMAPI mod output —
 * no Steam login is required for that.
 */

const http   = require('http');
const fs     = require('fs');
const config = require('../server');

const STEAM_AUTH_URL = process.env.STEAM_AUTH_URL || 'http://stardrop-steam-auth:18700';

// -- Forward a request to steam-auth container --
function callSteamAuth(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(path, STEAM_AUTH_URL);

    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  8000,
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data } }); }
      });
    });

    req.on('timeout', () => req.destroy(new Error('steam-auth timeout')));
    req.on('error',   reject);

    if (payload) req.write(payload);
    req.end();
  });
}

// -- Route Handlers --

async function getStatus(req, res) {
  try {
    const { status, body } = await callSteamAuth('GET', '/status');
    res.status(status).json(body);
  } catch (e) {
    // steam-auth container not running — that's fine, it's optional
    res.json({
      state:     'unavailable',
      loggedIn:  false,
      hasToken:  false,
      inviteCode: null,
      message:   'Steam auth service is not running',
    });
  }
}

async function login(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    // Credentials pass through in-memory only — never logged or stored here
    const { status, body } = await callSteamAuth('POST', '/login', { username, password });
    res.status(status).json(body);
  } catch (e) {
    res.status(503).json({ error: 'Steam auth service unavailable', details: e.message });
  }
}

async function submitGuardCode(req, res) {
  const { code } = req.body || {};

  if (!code) {
    return res.status(400).json({ error: 'Steam Guard code is required' });
  }

  try {
    const { status, body } = await callSteamAuth('POST', '/guard', { code });
    res.status(status).json(body);
  } catch (e) {
    res.status(503).json({ error: 'Steam auth service unavailable', details: e.message });
  }
}

async function logout(req, res) {
  try {
    const { status, body } = await callSteamAuth('POST', '/logout');
    res.status(status).json(body);
  } catch (e) {
    res.status(503).json({ error: 'Steam auth service unavailable', details: e.message });
  }
}

async function getInviteCode(req, res) {
  // Invite code is written by the ServerDashboard SMAPI mod via Game1.server.getInviteCode()

  // 1. Try dedicated invite-code file (written immediately when code is generated)
  try {
    const code = fs.readFileSync('/tmp/invite-code.txt', 'utf-8').trim();
    if (code) return res.json({ inviteCode: code });
  } catch {}

  // 2. Fall back to live-status.json
  try {
    const liveFile = process.env.LIVE_FILE || '/home/steam/.local/share/stardrop/live-status.json';
    if (fs.existsSync(liveFile)) {
      const live = JSON.parse(fs.readFileSync(liveFile, 'utf-8'));
      if (live.inviteCode) return res.json({ inviteCode: live.inviteCode });
    }
  } catch {}

  res.json({ inviteCode: null });
}

// ── Server-side Steam auth (steamcmd, for invite codes) ───────────────────────
// Separate from the steam-auth proxy above (which is only for the download wizard).
// Credentials are never written to disk — the ~/.steam/ session lives in the
// container's ephemeral filesystem and is cleared on logout.

let _pendingAuth = null; // { username, password } held between guard_required and code submit

// Read SERVER_MODE from runtime.env fresh on each request so dashboard/wizard changes
// take effect without needing a process restart.
function _readServerMode() {
  const candidates = [
    process.env.ENV_FILE,
    '/home/steam/web-panel/data/runtime.env',
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    const line = fs.readFileSync(p, 'utf-8').split('\n')
      .find(l => /^SERVER_MODE=/.test(l));
    if (line) {
      const val = line.replace(/^SERVER_MODE=/, '').replace(/['"]/g, '').trim();
      if (val) return val;
    }
  }
  // Default to lan — runtime.env is authoritative after wizard runs.
  // process.env.SERVER_MODE from host .env is only for the entrypoint's
  // Step 8.5 wait; the panel always defaults to lan if not explicitly set.
  return 'lan';
}

function serverAuthStatus(req, res) {
  const steamMode = _readServerMode() === 'steam';
  const ready     = fs.existsSync('/tmp/steam-ready');
  const skipped   = fs.existsSync('/tmp/steam-skip');
  res.json({
    steamMode,
    state: _pendingAuth  ? 'guard_required'
         : ready         ? 'authenticated'
         : skipped       ? 'skipped'
         :                 'unauthenticated',
  });
}

function _runSteamcmd(args) {
  return new Promise((resolve) => {
    let output = '';
    const proc = require('child_process').spawn(
      '/home/steam/steamcmd/steamcmd.sh', args,
      { env: { ...process.env, HOME: '/home/steam' }, timeout: 90000 }
    );
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', code => {
      const lc = output.toLowerCase();
      resolve({
        success:      /logged in ok|login successful/i.test(output),
        guardRequired: /two.factor|steam.guard|invalid.*auth.*code|enter.*code|steamguard/i.test(lc),
        wrongPassword: /invalid password|incorrect password|invalid login/i.test(lc),
        rateLimit:    /rate.limit|too many.*attempt/i.test(lc),
        output,
      });
    });
    proc.on('error', err => resolve({ success: false, error: err.message, output }));
  });
}

async function serverAuth(req, res) {
  const { username, password, guardCode } = req.body || {};

  let user, pass;
  if (guardCode && _pendingAuth) {
    // If a guard code is present, we must have the username from the original
    // request, which is stored in _pendingAuth. The user does not re-enter it.
    ({ password: pass } = _pendingAuth);
    user = _pendingAuth.username;
  } else {
    user = username;
    pass = password;
    _pendingAuth = null;
  }

  if (!user || !pass) return res.status(400).json({ error: 'username and password are required' });

  const args = [];
  if (guardCode) args.push('+set_steam_guard_code', guardCode.trim());
  args.push('+login', user, pass, '+quit');

  const result = await _runSteamcmd(args);

  if (result.guardRequired && !guardCode) {
    _pendingAuth = { username: user, password: pass };
    return res.json({ state: 'guard_required' });
  }
  _pendingAuth = null;

  if (result.success) {
    try { fs.writeFileSync('/tmp/steam-ready', 'ok'); } catch {}
    try { fs.unlinkSync('/tmp/steam-skip'); } catch {}
    return res.json({ success: true, state: 'authenticated' });
  }
  if (result.wrongPassword) return res.status(401).json({ error: 'Invalid Steam credentials' });
  if (result.rateLimit)     return res.status(429).json({ error: 'Steam rate limited — wait a few minutes and try again' });
  return res.status(500).json({ error: 'Steam authentication failed', details: result.output?.slice(-300) });
}

async function serverLogout(req, res) {
  _pendingAuth = null;
  try { fs.unlinkSync('/tmp/steam-ready'); } catch {}
  try { fs.unlinkSync('/tmp/invite-code.txt'); } catch {}
  // Clear Steam session files — these live in the container's ephemeral fs, not on any volume
  const { execSync } = require('child_process');
  try { execSync('rm -f /home/steam/.steam/steam/config/loginusers.vdf', { timeout: 3000 }); } catch {}
  try { execSync('find /home/steam/.steam -name "ssfn*" -delete 2>/dev/null', { timeout: 3000 }); } catch {}
  // Kill the game so it restarts without the authenticated session
  try { execSync('pkill -f StardewModdingAPI', { timeout: 3000 }); } catch {}
  res.json({ success: true, state: 'unauthenticated' });
}

function serverSkip(req, res) {
  _pendingAuth = null;
  try { fs.writeFileSync('/tmp/steam-skip', 'ok'); } catch {}
  res.json({ success: true, state: 'skipped' });
}

module.exports = { getStatus, login, submitGuardCode, logout, getInviteCode, serverAuthStatus, serverAuth, serverLogout, serverSkip };
