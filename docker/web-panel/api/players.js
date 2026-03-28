/**
 * StardropHost | web-panel/api/players.js
 * Player information, management and history
 */

const fs = require('fs');
const { execSync } = require('child_process');
const http = require('http');
const config = require('../server');

// -- Player history (24h at 5min intervals) --
const playerHistory = [];
const MAX_PLAYER_HISTORY = 288;

// -- Connected players cache --
let connectedPlayers = [];
let lastLogParse = 0;

// -- Recent players tracking --
const playerSnapshots = new Map(); // id → rich player data from live-status.json
const recentPlayers   = new Map(); // id → { ...playerData, lastSeen }
const RECENT_EXPIRE_MS = 24 * 60 * 60 * 1000;

// -- Ban list --
const BAN_LIST_FILE = require('path').join(config.DATA_DIR, 'bans.json');

function loadBans() {
  try {
    if (fs.existsSync(BAN_LIST_FILE)) {
      return JSON.parse(fs.readFileSync(BAN_LIST_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveBans(bans) {
  try {
    fs.writeFileSync(BAN_LIST_FILE, JSON.stringify(bans, null, 2), 'utf-8');
  } catch {}
}

// -- Parse players from SMAPI log --
// BUG FIX: Player IDs are large negative numbers (e.g. -3472295406447050512)
// Updated regex from \w+ to [-0-9]+ to match actual numeric IDs
function parsePlayersFromLogs() {
  const now = Date.now();
  if (now - lastLogParse < 10000) return connectedPlayers;

  try {
    if (!fs.existsSync(config.SMAPI_LOG)) return connectedPlayers;

    const content = fs.readFileSync(config.SMAPI_LOG, 'utf-8');
    const lines   = content.split('\n');
    const players = new Map();

    for (const line of lines) {
      // Join patterns - IDs are numeric
      const joinMatch =
        line.match(/Received connection for vanilla player ([-0-9]+)/i) ||
        line.match(/Approved request for farmhand ([-0-9]+)/i) ||
        line.match(/farmhand ([-0-9]+) connected/i) ||
        line.match(/client ([-0-9]+) connected/i) ||
        line.match(/peer ([-0-9]+) joined/i);

      if (joinMatch) {
        const id = joinMatch[1];
        players.set(id, {
          id,
          name: formatPlayerId(id),
          joinedAt: new Date().toISOString(),
          isOnline: true,
        });
        continue;
      }

      // Leave patterns
      const leaveMatch =
        line.match(/farmhand ([-0-9]+) disconnected/i) ||
        line.match(/client ([-0-9]+) disconnected/i) ||
        line.match(/peer ([-0-9]+) left/i) ||
        line.match(/connection ([-0-9]+) disconnected/i) ||
        line.match(/player ([-0-9]+) disconnected/i);

      if (leaveMatch) {
        players.delete(leaveMatch[1]);
      }
    }

    connectedPlayers = Array.from(players.values());
    lastLogParse = now;
  } catch {
    // Keep last known state
  }

  return connectedPlayers;
}

// -- Try to get richer player data from live-status.json --
function getPlayersFromLiveStatus() {
  try {
    if (fs.existsSync(config.LIVE_FILE)) {
      const live = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));
      if (live.players?.length > 0) {
        const online = live.players
          .filter(p => p.isOnline && !p.isHost)
          .map(p => ({
            id:         p.uniqueId,
            name:       p.name || formatPlayerId(p.uniqueId),
            joinedAt:   null,
            isOnline:   true,
            health:     p.health,
            maxHealth:  p.maxHealth,
            stamina:    Math.floor(p.stamina ?? 0),
            maxStamina: Math.floor(p.maxStamina ?? 0),
            money:      p.money,
            location:   p.locationName,
            skills:     p.skills,
            daysPlayed: p.daysPlayed,
            tileX:      p.tileX,
            tileY:      p.tileY,
          }));

        // Update snapshots for all currently online players
        for (const p of online) playerSnapshots.set(p.id, p);

        return online;
      }
    }
  } catch {}
  return null;
}

// -- Format a numeric player ID for display --
function formatPlayerId(id) {
  if (!id) return 'Player';
  // Show last 6 digits of the numeric ID as a short identifier
  const str = String(id).replace('-', '');
  return `Farmhand #${str.slice(-6)}`;
}

function getOnlineCount() {
  try {
    if (fs.existsSync(config.STATUS_FILE)) {
      const data = JSON.parse(fs.readFileSync(config.STATUS_FILE, 'utf-8'));
      if (data.game?.players_online !== undefined) return data.game.players_online || 0;
      return data.players_online || 0;
    }
  } catch {}
  return connectedPlayers.length;
}

// -- Record player count history every 5 minutes --
setInterval(() => {
  playerHistory.push({
    timestamp: new Date().toISOString(),
    count: getOnlineCount(),
  });
  if (playerHistory.length > MAX_PLAYER_HISTORY) playerHistory.shift();
}, 5 * 60 * 1000);

// -- Send SMAPI console command --
// Writes directly to SMAPI's stdin via procfs (same approach as terminal.js).
// The web panel runs inside the game container, so no docker exec needed.
function sendConsoleCommand(command) {
  try {
    const pids = execSync('pgrep -f StardewModdingAPI', { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    const pid = pids[0];
    if (!pid) return false;
    const input = command.endsWith('\n') ? command : `${command}\n`;
    fs.writeFileSync(`/proc/${pid}/fd/0`, input);
    return true;
  } catch {
    return false;
  }
}

// -- Route Handlers --

function getPlayers(req, res) {
  // Prefer live-status.json data (richer, from StardropDashboard mod)
  const livePlayers = getPlayersFromLiveStatus();
  const logPlayers  = parsePlayersFromLogs();
  const players     = livePlayers || logPlayers;
  const online      = getOnlineCount();

  // Detect disconnects: players in snapshots but not currently online → move to recent
  const onlineIds = new Set(players.map(p => p.id));
  for (const [id, snapshot] of playerSnapshots) {
    if (!onlineIds.has(id)) {
      recentPlayers.set(id, { ...snapshot, lastSeen: Date.now() });
      playerSnapshots.delete(id);
    }
  }

  // Expire recent players older than 24h
  const now = Date.now();
  for (const [id, p] of recentPlayers) {
    if (now - p.lastSeen > RECENT_EXPIRE_MS) recentPlayers.delete(id);
  }

  res.json({
    online: Math.max(online, players.length),
    max: 4,
    players,
    recentPlayers: Array.from(recentPlayers.values()).sort((a, b) => b.lastSeen - a.lastSeen),
    history: playerHistory,
  });
}

function kickPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) {
    return res.status(400).json({ error: 'Player id or name is required' });
  }

  const target = name || id;
  const success = sendConsoleCommand(`kick ${target}`);

  if (success) {
    res.json({ success: true, message: `Kick command sent for ${target}` });
  } else {
    res.status(500).json({ error: 'Failed to send kick command' });
  }
}

function banPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) {
    return res.status(400).json({ error: 'Player id or name is required' });
  }

  const target = name || id;
  const bans = loadBans();

  if (!bans.find(b => b.id === id || b.name === name)) {
    bans.push({ id, name, bannedAt: new Date().toISOString() });
    saveBans(bans);
  }

  // Also kick them immediately
  sendConsoleCommand(`kick ${target}`);

  res.json({ success: true, message: `${target} banned` });
}

function unbanPlayer(req, res) {
  const { id, name } = req.body;
  if (!id && !name) {
    return res.status(400).json({ error: 'Player id or name is required' });
  }

  const bans = loadBans().filter(b => b.id !== id && b.name !== name);
  saveBans(bans);

  res.json({ success: true, message: 'Player unbanned' });
}

function grantAdmin(req, res) {
  const { id, name } = req.body;
  if (!id && !name) {
    return res.status(400).json({ error: 'Player id or name is required' });
  }

  const target = name || id;
  const success = sendConsoleCommand(`admin ${target}`);

  if (success) {
    res.json({ success: true, message: `Admin granted to ${target}` });
  } else {
    res.status(500).json({ error: 'Failed to send admin command' });
  }
}

module.exports = {
  getPlayers,
  kickPlayer,
  banPlayer,
  unbanPlayer,
  grantAdmin,
};