/**
 * StardropHost | web-panel/api/vnc.js
 * VNC session management — enable/disable, one-time password, status
 *
 * VNC is off by default (DISABLE_RENDERING=true, ENABLE_VNC=false).
 * The panel can toggle it on for debugging, optionally with a one-time
 * password that resets to the configured VNC_PASSWORD after first use.
 */

const fs   = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const config = require('../server');

const VNC_PORT         = parseInt(process.env.VNC_PORT || '5900', 10);
const VNC_STATE_FILE   = path.join(config.DATA_DIR, 'vnc-state.json');
const DEFAULT_PASSWORD = process.env.VNC_PASSWORD || 'stardew1';

// Auto-shutoff: VNC disables itself after this many ms of no connections
const AUTO_SHUTOFF_MS  = 30 * 60 * 1000; // 30 minutes

let shutoffTimer = null;

// -- State helpers --

function readState() {
  try {
    if (fs.existsSync(VNC_STATE_FILE)) {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(VNC_STATE_FILE, 'utf-8')) };
    }
  } catch {}
  return defaultState();
}

function defaultState() {
  return {
    enabled:        false,
    oneTimePassword: null,    // Set when a one-time password is active
    oneTimeUsed:    false,
    enabledAt:      null,
    autoShutoffAt:  null,
  };
}

function writeState(state) {
  try {
    const dir = path.dirname(VNC_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(VNC_STATE_FILE, JSON.stringify({ ...defaultState(), ...state }, null, 2));
  } catch {}
}

// -- VNC process helpers --

function isVncRunning() {
  try {
    const result = spawnSync('pgrep', ['-f', 'x11vnc'], { encoding: 'utf-8' });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function setVncPassword(password) {
  try {
    // x11vnc style — write password via vncpasswd
    spawnSync('x11vnc', ['-storepasswd', password, '/tmp/vncpasswd'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch {}
}

function isXvfbRunning() {
  try {
    const xvfb = spawnSync('pgrep', ['-x', 'Xvfb'], { encoding: 'utf-8' });
    if (xvfb.status === 0) return true;
    const xorg = spawnSync('pgrep', ['-x', 'Xorg'], { encoding: 'utf-8' });
    return xorg.status === 0;
  } catch { return false; }
}

function ensureDisplayRunning() {
  if (isXvfbRunning()) return true;

  const width  = process.env.RESOLUTION_WIDTH  || '1280';
  const height = process.env.RESOLUTION_HEIGHT || '720';

  // Remove stale lock files
  spawnSync('rm', ['-f', '/tmp/.X99-lock', '/tmp/.X11-unix/X99'], { encoding: 'utf-8' });

  // Start Xvfb detached
  const { spawn } = require('child_process');
  const xvfb = spawn('Xvfb', [
    ':99', '-screen', '0', `${width}x${height}x24`,
    '-ac', '+extension', 'GLX', '+render', '-noreset',
  ], { detached: true, stdio: 'ignore' });
  xvfb.unref();

  // Wait up to 5 s for it to appear
  for (let i = 0; i < 10; i++) {
    spawnSync('sleep', ['0.5']);
    if (isXvfbRunning()) {
      process.env.DISPLAY = ':99';
      return true;
    }
  }
  return false;
}

function startVnc(password) {
  try {
    // Ensure a display is available before x11vnc tries to attach
    if (!ensureDisplayRunning()) {
      console.error('[vnc] Could not start Xvfb — x11vnc will likely fail');
    }

    setVncPassword(password || DEFAULT_PASSWORD);
    spawnSync('sh', ['-c', '/home/steam/scripts/vnc-monitor.sh start 2>/dev/null &'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function stopVnc() {
  try {
    // Kill the monitor first so it can't restart x11vnc
    spawnSync('pkill', ['-9', '-f', 'vnc-monitor'], { encoding: 'utf-8' });
    spawnSync('sleep', ['1']);
    // Force-kill x11vnc — use SIGKILL because -bg daemonizes it and it may ignore SIGTERM
    spawnSync('pkill', ['-9', '-f', 'x11vnc'], { encoding: 'utf-8' });
    spawnSync('sleep', ['1']);
    // Verify it's dead
    const still = spawnSync('pgrep', ['-f', 'x11vnc'], { encoding: 'utf-8' });
    if (still.status === 0) {
      // Last resort: kill by PID list
      const pids = still.stdout.trim().split('\n').filter(Boolean);
      for (const pid of pids) {
        spawnSync('kill', ['-9', pid], { encoding: 'utf-8' });
      }
    }
    return true;
  } catch {
    return false;
  }
}

// -- Auto-shutoff timer --

function scheduleAutoShutoff() {
  if (shutoffTimer) clearTimeout(shutoffTimer);
  shutoffTimer = setTimeout(() => {
    const state = readState();
    if (state.enabled) {
      stopVnc();
      writeState({ ...state, enabled: false, autoShutoffAt: null });
    }
    shutoffTimer = null;
  }, AUTO_SHUTOFF_MS);
}

function cancelAutoShutoff() {
  if (shutoffTimer) { clearTimeout(shutoffTimer); shutoffTimer = null; }
}

// -- Route Handlers --

function getVncStatus(req, res) {
  const state   = readState();
  const running = isVncRunning();

  // Reconcile state with reality — if process died unexpectedly, reflect that
  if (state.enabled && !running) {
    writeState({ ...state, enabled: false });
    state.enabled = false;
  }

  res.json({
    enabled:         state.enabled,
    running,
    port:            VNC_PORT,
    host:            process.env.PUBLIC_IP || null,
    hasOneTimePass:  !!(state.oneTimePassword && !state.oneTimeUsed),
    autoShutoffAt:   state.autoShutoffAt,
    autoShutoffMins: AUTO_SHUTOFF_MS / 60000,
  });
}

function enableVnc(req, res) {
  const state = readState();

  if (state.enabled && isVncRunning()) {
    return res.json({
      success: true,
      alreadyRunning: true,
      message: 'VNC is already running',
      port: VNC_PORT,
    });
  }

  const password    = DEFAULT_PASSWORD;
  const shutoffTime = new Date(Date.now() + AUTO_SHUTOFF_MS).toISOString();

  const ok = startVnc(password);
  if (!ok) {
    return res.status(500).json({ error: 'Failed to start VNC process' });
  }

  writeState({
    enabled:        true,
    oneTimePassword: null,
    oneTimeUsed:    false,
    enabledAt:      new Date().toISOString(),
    autoShutoffAt:  shutoffTime,
  });

  scheduleAutoShutoff();

  res.json({
    success:       true,
    message:       'VNC enabled',
    port:          VNC_PORT,
    autoShutoffAt: shutoffTime,
  });
}

function disableVnc(req, res) {
  cancelAutoShutoff();
  stopVnc();

  writeState({ ...defaultState(), enabled: false });

  res.json({ success: true, message: 'VNC disabled' });
}

function setOneTimePassword(req, res) {
  const { password } = req.body || {};

  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  if (password.length > 8) {
    // VNC passwords are capped at 8 characters
    return res.status(400).json({ error: 'VNC passwords cannot exceed 8 characters' });
  }

  const state = readState();
  if (!state.enabled || !isVncRunning()) {
    return res.status(400).json({ error: 'VNC is not running. Enable VNC first.' });
  }

  setVncPassword(password);

  writeState({
    ...state,
    oneTimePassword: password,
    oneTimeUsed:     false,
  });

  // Extend auto-shutoff from now — a one-time password implies someone is about to connect
  const shutoffTime = new Date(Date.now() + AUTO_SHUTOFF_MS).toISOString();
  writeState({
    ...state,
    oneTimePassword: password,
    oneTimeUsed:     false,
    autoShutoffAt:   shutoffTime,
  });
  scheduleAutoShutoff();

  res.json({
    success:       true,
    message:       'One-time VNC password set. It will reset to the default password after first use.',
    autoShutoffAt: shutoffTime,
  });
}

// Called by vnc-monitor.sh (or a future connection hook) when a client connects
// POST /api/vnc/connected  (internal, not exposed to the browser UI directly)
function notifyConnected(req, res) {
  const state = readState();

  if (state.oneTimePassword && !state.oneTimeUsed) {
    // Reset to default password after first use
    setVncPassword(DEFAULT_PASSWORD);
    writeState({ ...state, oneTimePassword: null, oneTimeUsed: true });
  }

  // Extend auto-shutoff on active connection
  scheduleAutoShutoff();

  res.json({ success: true });
}

module.exports = {
  getVncStatus,
  enableVnc,
  disableVnc,
  setOneTimePassword,
  notifyConnected,
};