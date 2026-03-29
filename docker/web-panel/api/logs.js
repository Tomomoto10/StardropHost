/**
 * StardropHost | web-panel/api/logs.js
 * Log reading and WebSocket streaming
 */

const fs = require('fs');
const path = require('path');
const config = require('../server');

// -- Log file mapping --
const LOG_FILES = {
  all:    'smapi-latest.log',
  error:  'errors.log',
  mod:    'mods.log',
  server: 'server.log',
  game:   'game.log',
};

function getCategorizedLogPath(filter) {
  return path.join(config.LOG_DIR, 'categorized', LOG_FILES[filter] || LOG_FILES.all);
}

function getLogSource(filter) {
  if (filter === 'all') {
    return { path: config.SMAPI_LOG, filtered: false };
  }
  if (filter === 'smapi') {
    return { path: config.SMAPI_LOG, filtered: true };
  }

  const categorizedPath = getCategorizedLogPath(filter);
  if (fs.existsSync(categorizedPath)) {
    return { path: categorizedPath, filtered: false };
  }

  return { path: config.SMAPI_LOG, filtered: true };
}

function isSmapiSource(line) {
  return /\[\d{2}:\d{2}:\d{2}\s+\w+\s+SMAPI\]/i.test(line);
}

function matchesFilter(filter, line) {
  if (!line || filter === 'all') return true;

  if (filter === 'smapi') {
    return isSmapiSource(line);
  }
  if (filter === 'error') {
    return /ERROR|FATAL|Exception/i.test(line);
  }
  // "game" tab = everything that is NOT a pure SMAPI-sourced line
  if (filter === 'game') {
    return !isSmapiSource(line);
  }
  return true;
}

function parseLogLevel(line) {
  if (/\bERROR\b/i.test(line)) return 'error';
  if (/\bWARN\b/i.test(line))  return 'warn';
  if (/\bDEBUG\b/i.test(line)) return 'debug';
  return 'info';
}

// -- HTTP Handlers --

function getLogs(req, res) {
  const filter = req.query.type || 'all';
  const lines  = parseInt(req.query.lines || '200', 10);
  const search = req.query.search || '';

  const source  = getLogSource(filter);
  const logPath = source.path;

  if (!fs.existsSync(logPath)) {
    return res.json({ lines: [], total: 0, file: logPath, exists: false });
  }

  try {
    const content  = fs.readFileSync(logPath, 'utf-8');
    let allLines   = content.split('\n').filter(l => l.trim());

    if (source.filtered) {
      allLines = allLines.filter(line => matchesFilter(filter, line));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      allLines = allLines.filter(l => l.toLowerCase().includes(searchLower));
    }

    const result = allLines.slice(-lines).map(line => ({
      text:  line,
      level: parseLogLevel(line),
    }));

    res.json({ lines: result, total: allLines.length, file: path.basename(logPath), exists: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read log file', details: e.message });
  }
}

function getErrors(req, res) {
  req.query.type = 'error';
  return getLogs(req, res);
}

function getServerLogs(req, res) {
  req.query.type = 'server';
  return getLogs(req, res);
}

function getModLogs(req, res) {
  req.query.type = 'mod';
  return getLogs(req, res);
}

function getGameLogs(req, res) {
  req.query.type = 'game';
  return getLogs(req, res);
}

// -- WebSocket log streaming --

function subscribeLogs(ws, filter) {
  const source  = getLogSource(filter);
  const logPath = source.path;

  if (ws._logWatcher) {
    ws._logWatcher.close();
    ws._logWatcher = null;
  }

  if (!fs.existsSync(logPath)) {
    ws.send(JSON.stringify({
      type: 'log',
      line: { text: `Log file not found: ${path.basename(logPath)}`, level: 'warn' },
    }));
    return;
  }

  let fileSize = 0;
  try { fileSize = fs.statSync(logPath).size; } catch {}

  const watcher = fs.watch(logPath, (eventType) => {
    if (eventType !== 'change') return;

    try {
      const stat = fs.statSync(logPath);

      // File was truncated (log rotation)
      if (stat.size <= fileSize) fileSize = 0;

      const stream = fs.createReadStream(logPath, { start: fileSize, encoding: 'utf-8' });
      let newData = '';

      stream.on('data', (chunk) => { newData += chunk; });
      stream.on('end', () => {
        fileSize = stat.size;
        const lines = newData.split('\n').filter(l => l.trim());

        for (const line of lines) {
          if (source.filtered && !matchesFilter(filter, line)) continue;
          if (ws.readyState !== 1) break;

          ws.send(JSON.stringify({
            type: 'log',
            line: { text: line, level: parseLogLevel(line) },
          }));
        }
      });
    } catch {}
  });

  ws._logWatcher = watcher;

  ws.send(JSON.stringify({
    type:   'log:subscribed',
    filter,
    file:   path.basename(logPath),
  }));
}

// -- Setup log (entrypoint.sh progress, visible during wizard) --

const SETUP_LOG_FILE = '/home/steam/.local/share/stardrop/logs/setup.log';

function getSetupLog(req, res) {
  const lines = Math.min(parseInt(req.query.lines || '120', 10), 500);

  if (!fs.existsSync(SETUP_LOG_FILE)) {
    return res.json({ lines: [], exists: false });
  }

  try {
    const content  = fs.readFileSync(SETUP_LOG_FILE, 'utf-8');
    const allLines = content.split('\n').filter(l => l.trim());

    const result = allLines.slice(-lines).map(line => ({
      text:  line,
      level: /\[ERROR\]/i.test(line) ? 'error'
           : /\[WARN\]/i.test(line)  ? 'warn'
           : /\[STEP\]/i.test(line)  ? 'info'
           : 'info',
    }));

    res.json({ lines: result, total: allLines.length, exists: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to read setup log', details: e.message });
  }
}

module.exports = {
  getLogs,
  getErrors,
  getServerLogs,
  getModLogs,
  getGameLogs,
  subscribeLogs,
  getSetupLog,
};