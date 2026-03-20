// steam-auth/server.js
/**
 * StardropHost | steam-auth/server.js
 * Lightweight Steam authentication service.
 * Handles login, Steam Guard, session tokens,
 * and invite code generation for the game server.
 * Credentials never touch the game container.
 */

const express    = require('express');
const SteamUser  = require('steam-user');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = parseInt(process.env.STEAM_AUTH_PORT || '18700', 10);

const SESSION_FILE = '/data/session.json';
const STATUS_FILE  = '/data/status.json';

app.use(express.json());

// -- Session state --
let client       = null;
let sessionData  = null;
let inviteCode   = null;
let authState    = 'offline'; // offline | logging_in | guard_required | online | error
let lastError    = '';
let guardResolver = null;

// -- Persist/load session --
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveSession(data) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

function clearSession() {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}

function writeStatus() {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      state:       authState,
      loggedIn:    authState === 'online',
      inviteCode,
      lastError,
      updatedAt:   new Date().toISOString(),
    }, null, 2));
  } catch {}
}

// -- Create a fresh SteamUser client --
function createClient() {
  if (client) {
    try { client.logOff(); } catch {}
    client = null;
  }

  client = new SteamUser({ autoRelogin: false });

  client.on('loggedOn', () => {
    console.log('[steam-auth] Logged in to Steam');
    authState = 'online';
    lastError = '';
    _inviteCodePollFast = true; // restart fast-poll on each login

    // Save refresh token for future logins
    if (client.steamID) {
      const existing = loadSession() || {};
      saveSession({ ...existing, steamID: client.steamID.toString() });
    }

    writeStatus();
    generateInviteCode();
  });

  client.on('refreshToken', (token) => {
    console.log('[steam-auth] Received refresh token');
    const existing = loadSession() || {};
    saveSession({ ...existing, refreshToken: token });
  });

  client.on('steamGuard', (domain, callback, lastCodeWrong) => {
    console.log(`[steam-auth] Steam Guard required (domain: ${domain || 'mobile'})`);
    authState     = 'guard_required';
    lastError     = lastCodeWrong ? 'Incorrect Steam Guard code' : '';
    guardResolver = callback;
    writeStatus();
  });

  client.on('error', (err) => {
    console.error('[steam-auth] Error:', err.message);
    authState = 'error';
    lastError = err.message;
    writeStatus();
  });

  client.on('disconnected', (eresult, msg) => {
    console.log(`[steam-auth] Disconnected: ${msg}`);
    if (authState === 'online') {
      authState  = 'offline';
      inviteCode = null;
      writeStatus();
    }
  });

  return client;
}

// -- Generate invite code --
// The game server (SMAPI) exposes its invite code in the SMAPI log.
// We read it from the shared log volume.
function generateInviteCode() {
  try {
    const logPath = process.env.SMAPI_LOG
      || '/game-logs/SMAPI-latest.txt';

    if (!fs.existsSync(logPath)) {
      inviteCode = null;
      writeStatus();
      return;
    }

    const content = fs.readFileSync(logPath, 'utf-8');
    // SMAPI logs the Steam invite code as:
    //   Invite code: S-XXXXXXXX
    const match = content.match(/[Ii]nvite\s+code[:\s]+([A-Za-z0-9\-_]+)/);
    if (match) {
      inviteCode = match[1];
      console.log(`[steam-auth] Invite code found: ${inviteCode}`);
    } else {
      inviteCode = null;
    }
  } catch {
    inviteCode = null;
  }
  writeStatus();
}

// Poll for invite code: every 5s until we find one, then every 30s
let _inviteCodePollFast = true;
setInterval(() => {
  if (authState === 'online' && _inviteCodePollFast) {
    generateInviteCode();
    if (inviteCode) _inviteCodePollFast = false;
  }
}, 5000);
setInterval(() => {
  if (authState === 'online' && !_inviteCodePollFast) generateInviteCode();
}, 30000);

// -- Auto-login with refresh token on startup --
function tryAutoLogin() {
  const session = loadSession();
  if (!session?.refreshToken) return;

  console.log('[steam-auth] Attempting auto-login with refresh token...');
  authState = 'logging_in';
  writeStatus();

  createClient();
  client.logOn({ refreshToken: session.refreshToken });
}

// ===========================================
// API Routes
// ===========================================

// GET /status
app.get('/status', (req, res) => {
  const session = loadSession();
  res.json({
    state:       authState,
    loggedIn:    authState === 'online',
    hasToken:    !!(session?.refreshToken),
    inviteCode,
    lastError,
  });
});

// POST /login  { username, password }
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (authState === 'online') {
    return res.json({ success: true, message: 'Already logged in', state: authState });
  }

  console.log(`[steam-auth] Login attempt for: ${username}`);
  authState  = 'logging_in';
  lastError  = '';
  inviteCode = null;
  writeStatus();

  createClient();
  client.logOn({ accountName: username, password });

  res.json({ success: true, message: 'Login initiated', state: authState });
});

// POST /guard  { code }
app.post('/guard', (req, res) => {
  const { code } = req.body || {};

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Steam Guard code is required' });
  }

  if (authState !== 'guard_required' || !guardResolver) {
    return res.status(400).json({ error: 'No Steam Guard prompt is active' });
  }

  console.log('[steam-auth] Submitting Steam Guard code...');
  authState = 'logging_in';
  lastError = '';
  writeStatus();

  const resolver  = guardResolver;
  guardResolver   = null;
  resolver(code);

  res.json({ success: true, message: 'Steam Guard code submitted' });
});

// POST /logout
app.post('/logout', (req, res) => {
  if (client) {
    try { client.logOff(); } catch {}
    client = null;
  }

  clearSession();
  authState  = 'offline';
  inviteCode = null;
  lastError  = '';
  writeStatus();

  console.log('[steam-auth] Logged out and session cleared');
  res.json({ success: true, message: 'Logged out' });
});

// GET /invitecode  — force refresh
app.get('/invitecode', (req, res) => {
  generateInviteCode();
  res.json({ inviteCode, loggedIn: authState === 'online' });
});

// GET /health  — no auth, used by docker healthcheck
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ===========================================
// Start
// ===========================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[steam-auth] ✅ Running on port ${PORT}`);
  writeStatus();
  tryAutoLogin();
});