/**
 * StardropHost | web-panel/api/steam.js
 * Proxy to the steam-auth container for wizard game download (login/guard/logout).
 * The web panel never handles Steam credentials directly — it passes them
 * straight through to the isolated steam-auth service.
 */

const http   = require('http');

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
      state:   'unavailable',
      loggedIn: false,
      hasToken: false,
      message:  'Steam auth service is not running',
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

module.exports = { getStatus, login, submitGuardCode, logout };
