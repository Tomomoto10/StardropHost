/**
 * StardropHost | web-panel/api/status.js
 * Server status, metrics and control
 */

const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const http  = require('http');
const https = require('https');
const config = require('../server');

// -- Status history (last 1 hour at 15s intervals = 240 entries) --
const statusHistory = [];
const MAX_HISTORY = 240;

// -- WebSocket subscribers --
const statusSubscribers = new Set();

// -- Cache --
let cachedStatus = null;
let cacheTime = 0;
const CACHE_TTL = 3000;

// -- Read SMAPI log lines --
function readRecentLogLines(limit = 400) {
  try {
    if (!fs.existsSync(config.SMAPI_LOG)) return [];
    return fs.readFileSync(config.SMAPI_LOG, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit);
  } catch {
    return [];
  }
}

// -- Extract hints from SMAPI log --
// BUG FIX: Player IDs are numeric (e.g. -3472295406447050512)
// Updated regex from [A-Za-z0-9_]+ to [-0-9]+ to match actual IDs
function extractLogHints() {
  const lines = readRecentLogLines(500);
  let day = '';
  const connectedPlayers = new Set();
  let paused = false;

  const addPlayer = (id) => {
    if (id && id !== 'Server' && id !== 'SMAPI') connectedPlayers.add(id);
  };

  const removePlayer = (id) => {
    if (id) connectedPlayers.delete(id);
  };

  for (const line of lines) {
    const contextMatch = line.match(/Context:\s+loaded save '.*?', starting ([a-z]+ \d+ Y\d+)/i);
    if (contextMatch) day = contextMatch[1];

    const seasonMatch = line.match(/Season:\s*([a-z]+, Day \d+, Year \d+)/i);
    if (seasonMatch) day = seasonMatch[1];

    if (/Disconnected:\s*ServerOfflineMode/i.test(line)) {
      paused = true;
      connectedPlayers.clear();
    }

    if (/Starting LAN server|Starting server\. Protocol/i.test(line)) {
      paused = false;
    }

    // Join patterns - IDs are numeric
    let match =
      line.match(/Received connection for vanilla player ([-0-9]+)/i) ||
      line.match(/Approved request for farmhand ([-0-9]+)/i) ||
      line.match(/farmhand ([-0-9]+) connected/i) ||
      line.match(/client ([-0-9]+) connected/i) ||
      line.match(/peer ([-0-9]+) joined/i);
    if (match) {
      addPlayer(match[1]);
      paused = false;
      continue;
    }

    // Leave patterns
    match =
      line.match(/farmhand ([-0-9]+) disconnected/i) ||
      line.match(/client ([-0-9]+) disconnected/i) ||
      line.match(/peer ([-0-9]+) left/i) ||
      line.match(/connection ([-0-9]+) disconnected/i) ||
      line.match(/player ([-0-9]+) disconnected/i);
    if (match) {
      removePlayer(match[1]);
      if (connectedPlayers.size === 0) paused = true;
    }
  }

  return { day, players: connectedPlayers.size, paused };
}

// -- Network info --
function normalizeJoinHost(host) {
  if (!host) return '';
  const firstHost = host.split(',')[0].trim();
  const match = firstHost.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (match) return match[1];
  return firstHost.replace(/:\d+$/, '');
}

function getNetworkInfo(requestHost = '') {
  const configuredPublicIp = process.env.PUBLIC_IP || '';
  let localIps = [];

  try {
    localIps = execSync('hostname -I 2>/dev/null', { encoding: 'utf-8' })
      .trim()
      .split(/\s+/)
      .filter(ip => ip && ip !== '127.0.0.1' && ip !== '::1');
  } catch {}

  const hostFromRequest = normalizeJoinHost(requestHost);
  const derivedJoinIp = hostFromRequest && hostFromRequest !== 'localhost' && hostFromRequest !== '127.0.0.1'
    ? hostFromRequest : '';

  return {
    joinIp: configuredPublicIp || derivedJoinIp || localIps[0] || '',
    localIps,
    joinPort: 24642,
    metricsPort: parseInt(process.env.METRICS_PORT || '9090', 10),
  };
}

// -- Get CPU core count for normalisation --
// BUG FIX: ps reports CPU per-core so divide by nproc to get true %
function getCoreCount() {
  try {
    return parseInt(execSync('nproc', { encoding: 'utf-8' }).trim(), 10) || 1;
  } catch {
    return 1;
  }
}

// -- Collect full status --
function collectStatus(req = null) {
  const now = Date.now();
  if (cachedStatus && now - cacheTime < CACHE_TTL) return cachedStatus;

  const requestHost = req?.headers?.['x-forwarded-host'] || req?.headers?.['host'] || '';

  const status = {
    timestamp: new Date().toISOString(),
    gameRunning: false,
    uptime: 0,
    players: { online: 0, max: 4 },
    cpu: 0,
    memory: { used: 0, limit: 2048 },
    day: 'Unknown',
    season: 'Unknown',
    backupCount: 0,
    modCount: 0,
    scriptsHealthy: false,
    paused: false,
    events: { passout: 0, readycheck: 0, offline: 0 },
    network: getNetworkInfo(requestHost),
    live: null,
  };

  // -- Read status.json from status-reporter.sh --
  try {
    if (fs.existsSync(config.STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.STATUS_FILE, 'utf-8'));

      if (data.server) {
        status.gameRunning = data.server.game_running === true || data.server.game_running === 1;
        status.uptime = data.server.uptime_seconds || 0;
      }
      if (data.game) {
        status.players.online = data.game.players_online || 0;
        if (data.game.day) status.day = data.game.day;
        if (typeof data.game.paused === 'boolean') status.paused = data.game.paused;
      }
      if (data.resources) {
        status.cpu = parseFloat(data.resources.cpu_percent) || 0;
        status.memory.used = data.resources.memory_mb || 0;
      }
      if (data.events) {
        status.events.passout = data.events.passout || 0;
        status.events.readycheck = data.events.readycheck || 0;
        status.events.offline = data.events.offline || 0;
      }
      if (typeof data.scripts_healthy === 'boolean') {
        status.scriptsHealthy = data.scripts_healthy;
      }
    }
  } catch {}

  // -- Read live-status.json from ServerDashboard mod --
  try {
    if (fs.existsSync(config.LIVE_FILE)) {
      const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
      status.live = live;

      // Use live data to fill gaps or override stale status.json data
      if (live.players?.length > 0) {
        status.players.online = live.players.filter(p => p.isOnline && !p.isHost).length;
      }
      if (live.season) status.season = live.season;
      if (live.day) {
        const season = live.season ? live.season.charAt(0).toUpperCase() + live.season.slice(1).toLowerCase() : live.season;
        status.day = `${season} ${live.day}, Year ${live.year}`;
      }
      if (live.serverState === 'running') status.gameRunning = true;
    }
  } catch {}

  // -- Live process metrics (pgrep is authoritative for gameRunning) --
  // Use spawnSync (not execSync) to avoid sh -c wrapper — execSync spawns
  // "sh -c 'pgrep -f StardewModdingAPI'" whose cmdline matches the pattern,
  // causing pgrep to always find a process even when SMAPI is not running.
  const _pgrep = spawnSync('pgrep', ['-f', 'StardewModdingAPI'], { encoding: 'utf-8' });
  const pidStr = _pgrep.status === 0 ? _pgrep.stdout.trim().split('\n')[0] : '';

  if (_pgrep.status === 0 && pidStr) {
    status.gameRunning = true;

    if (status.cpu === 0) {
      try {
        const cpuRaw = parseFloat(execSync(`ps -p ${pidStr} -o %cpu= 2>/dev/null`, { encoding: 'utf-8' }).trim()) || 0;
        // BUG FIX: Divide by core count to get true % of total capacity
        const cores = getCoreCount();
        status.cpu = Math.round((cpuRaw / cores) * 10) / 10;
      } catch {}
    }

    if (status.memory.used === 0) {
      try {
        const rssStr = execSync(`grep VmRSS /proc/${pidStr}/status 2>/dev/null | awk '{print $2}'`, { encoding: 'utf-8' }).trim();
        if (rssStr) status.memory.used = Math.round(parseInt(rssStr, 10) / 1024);
      } catch {}
    }

    if (status.uptime === 0) {
      try {
        const startTime = execSync(`stat -c %Y /proc/${pidStr} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (startTime) status.uptime = Math.floor(Date.now() / 1000) - parseInt(startTime, 10);
      } catch {}
    }
  } else {
    // pgrep found nothing — SMAPI not running; override stale status/live file data
    status.gameRunning = false;
    status.cpu = 0;
    status.memory.used = 0;
    if (status.live) status.live.serverState = 'offline';
  }

  // -- Container-level memory fallback (always available via /proc/meminfo) --
  if (status.memory.used === 0 || status.memory.limit === 2048) {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
      const totalKB    = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1]     || '0', 10);
      const availableKB= parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10);
      if (totalKB > 0) {
        if (status.memory.used === 0)     status.memory.used  = Math.round((totalKB - availableKB) / 1024);
        if (status.memory.limit === 2048) status.memory.limit = Math.round(totalKB / 1024);
      }
    } catch {}
  }

  // -- Fill gaps from SMAPI log hints --
  const hints = extractLogHints();
  if ((!status.day || status.day === 'Unknown') && hints.day) status.day = hints.day;
  if (status.players.online === 0 && hints.players > 0) status.players.online = hints.players;
  if (hints.paused) status.paused = true;

  // -- Script health check --
  if (!status.scriptsHealthy) {
    try {
      execSync('pgrep -f "event-handler.sh" >/dev/null 2>&1');
      status.scriptsHealthy = true;
    } catch {}
  }

  // -- Backup count --
  try {
    if (fs.existsSync(config.BACKUPS_DIR)) {
      status.backupCount = fs.readdirSync(config.BACKUPS_DIR)
        .filter(f => f.endsWith('.tar.gz') || f.endsWith('.zip')).length;
    }
  } catch {}

  // -- Mod count --
  try {
    const modsDir = `${config.GAME_DIR}/Mods`;
    if (fs.existsSync(modsDir)) {
      status.modCount = fs.readdirSync(modsDir)
        .filter(f => fs.existsSync(`${modsDir}/${f}/manifest.json`)).length;
    }
  } catch {}

  // -- System uptime --
  try {
    const uptimeStr = execSync('cat /proc/uptime', { encoding: 'utf-8' });
    status.systemUptime = Math.floor(parseFloat(uptimeStr.split(' ')[0]));
  } catch {}

  cachedStatus = status;
  cacheTime = now;

  statusHistory.push({
    timestamp: status.timestamp,
    cpu: status.cpu,
    memory: status.memory.used,
    players: status.players.online,
  });
  if (statusHistory.length > MAX_HISTORY) statusHistory.shift();

  return status;
}

// -- Broadcast to WebSocket subscribers every 5s --
setInterval(() => {
  if (statusSubscribers.size === 0) return;
  const status = collectStatus();
  const msg = JSON.stringify({ type: 'status', data: status });
  for (const ws of statusSubscribers) {
    if (ws.readyState === 1) {
      ws.send(msg);
    } else {
      statusSubscribers.delete(ws);
    }
  }
}, 5000);

// -- Helper: call manager container --
function callManager(path, body = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(path, config.MANAGER_URL);
    } catch {
      reject(new Error('Invalid manager URL'));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);

    const request = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(data || `Manager returned HTTP ${response.statusCode}`));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('Manager request timed out')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

// -- Route Handlers --

function getStatus(req, res) {
  res.json(collectStatus(req));
}

function subscribeStatus(ws) {
  statusSubscribers.add(ws);
  ws.send(JSON.stringify({ type: 'status', data: collectStatus() }));
  ws.on('close', () => statusSubscribers.delete(ws));
}

// Restart game process only (not container)
function restartServer(req, res) {
  try {
    spawnSync('sh', ['-lc', 'pkill -f "StardewModdingAPI|Stardew Valley" >/dev/null 2>&1 || true'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    cachedStatus = null;

    res.json({ success: true, message: 'Game restart initiated' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to restart server', details: e.message });
  }
}

// Persistent stop flag — stored in data volume so state survives container recreation (update.sh)
const STOP_FLAG = `${config.DATA_DIR}/server-stopped`;

// Stop game process — set stop flag so crash-monitor won't restart, then kill SMAPI
function stopServer(req, res) {
  try {
    fs.writeFileSync(STOP_FLAG, '');
    spawnSync('sh', ['-lc', 'pkill -f "StardewModdingAPI|Stardew Valley" >/dev/null 2>&1 || true'],
      { encoding: 'utf-8', timeout: 5000 });
    // Write offline state to live-status.json on disk immediately so "Starting..." shows correctly on next start
    try {
      if (fs.existsSync(config.LIVE_FILE)) {
        const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
        live.serverState = 'offline';
        fs.writeFileSync(config.LIVE_FILE, JSON.stringify(live));
      }
    } catch {}
    cachedStatus = null;
    res.json({ success: true, message: 'Game stopped' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to stop server', details: e.message });
  }
}

// Start game process — remove stop flag so crash-monitor resumes its loop
function startServer(req, res) {
  try {
    if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG);
    cachedStatus = null;
    res.json({ success: true, message: 'Game start initiated' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to start server', details: e.message });
  }
}

// Recreate entire container via manager
function restartContainer(req, res) {
  callManager('/recreate', { service: 'stardrop-server' })
    .then(() => {
      cachedStatus = null;
      res.json({ success: true, message: 'Container recreate initiated' });
    })
    .catch((error) => {
      res.status(500).json({ error: 'Failed to recreate container', details: error.message });
    });
}

// Pull latest image and restart via manager
function updateServer(req, res) {
  callManager('/update')
    .then(() => {
      cachedStatus = null;
      res.json({ success: true, message: 'Update initiated' });
    })
    .catch((error) => {
      res.status(500).json({ error: 'Failed to initiate update', details: error.message });
    });
}

// Run health check
function healthCheck(req, res) {
  const checks = [];

  // Game process
  let gameRunning = false;
  try {
    execSync('pgrep -f StardewModdingAPI >/dev/null 2>&1');
    gameRunning = true;
  } catch {}
  checks.push({ name: 'Game process', pass: gameRunning });

  // SMAPI log exists
  const logExists = fs.existsSync(config.SMAPI_LOG);
  checks.push({ name: 'SMAPI log', pass: logExists });

  // Status file exists
  const statusExists = fs.existsSync(config.STATUS_FILE);
  checks.push({ name: 'Status file', pass: statusExists });

  // Event handler running
  let eventHandler = false;
  try {
    execSync('pgrep -f "event-handler.sh" >/dev/null 2>&1');
    eventHandler = true;
  } catch {}
  checks.push({ name: 'Event handler', pass: eventHandler });

  // Game port listening
  let portOpen = false;
  try {
    execSync('netstat -uln 2>/dev/null | grep ":24642" >/dev/null 2>&1');
    portOpen = true;
  } catch {}
  checks.push({ name: 'Game port (24642/UDP)', pass: portOpen });

  // Live status file (ServerDashboard mod)
  const liveExists = fs.existsSync(config.LIVE_FILE);
  checks.push({ name: 'ServerDashboard live status', pass: liveExists });

  const passed = checks.filter(c => c.pass).length;
  const failed = checks.filter(c => !c.pass).length;

  res.json({
    passed,
    failed,
    checks,
    healthy: failed === 0,
  });
}

module.exports = {
  getStatus,
  subscribeStatus,
  startServer,
  stopServer,
  restartServer,
  restartContainer,
  updateServer,
  healthCheck,
};