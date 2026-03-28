/**
 * StardropHost | web-panel/api/remote.js
 * Remote play tunnel management (playit.gg).
 * The secret key is held in memory only — never written to disk.
 * It is lost when the panel container restarts; the user re-enters it
 * and the playit container is restarted with the new key.
 */

const http = require('http');

const MANAGER_URL = process.env.MANAGER_URL || 'http://stardrop-manager:18700';

// In-memory only — same pattern as Steam auth credentials
let _activeKey = null;

// -- Manager proxy --

function callManager(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url     = new URL(path, MANAGER_URL);

    const options = {
      hostname: url.hostname,
      port:     url.port || 80,
      path:     url.pathname,
      method,
      headers:  { 'Content-Type': 'application/json' },
      timeout:  10000,
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

    req.on('timeout', () => req.destroy(new Error('manager timeout')));
    req.on('error',   reject);

    if (payload) req.write(payload);
    req.end();
  });
}

// -- Route Handlers --

async function getStatus(req, res) {
  try {
    const { body } = await callManager('GET', '/playit/status');
    res.json({
      ...body,
      hasKey: !!_activeKey,
    });
  } catch {
    res.json({
      running:  false,
      hasKey:   !!_activeKey,
      error:    'Manager not reachable',
    });
  }
}

async function setKey(req, res) {
  const { secretKey } = req.body || {};

  if (!secretKey || typeof secretKey !== 'string' || !secretKey.trim()) {
    return res.status(400).json({ error: 'secretKey is required' });
  }

  _activeKey = secretKey.trim();

  try {
    const { status, body } = await callManager('POST', '/playit/start', { secretKey: _activeKey });
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to start playit: ${e.message}` });
  }
}

async function clearKey(req, res) {
  _activeKey = null;

  try {
    const { status, body } = await callManager('POST', '/playit/stop');
    res.status(status).json(body);
  } catch (e) {
    res.status(500).json({ error: `Failed to stop playit: ${e.message}` });
  }
}

module.exports = { getStatus, setKey, clearKey };
