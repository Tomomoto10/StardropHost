/**
 * StardropHost | web-panel/api/farm.js
 * Farm overview — live player data + save file parsing
 *
 * Two data sources, used in priority order:
 *   1. live-status.json  — written every 10s by StardropDashboard mod (Phase 6)
 *                          real-time: players, time, season, weather
 *   2. Save file XML     — parsed on demand
 *                          rich:      Community Center, skills, inventory, relationships
 */

const fs   = require('fs');
const path = require('path');
const config = require('../server');

// -- Save file helpers --

function getSelectedSaveName() {
  try {
    const prefsPath = path.join(config.CONFIG_DIR, 'startup_preferences');
    if (fs.existsSync(prefsPath)) {
      const content = fs.readFileSync(prefsPath, 'utf-8');
      const match   = content.match(/^saveFolderName\s*=\s*(.+)$/m);
      if (match && match[1].trim()) return match[1].trim();
    }
  } catch {}

  try {
    const markerPath = path.join(config.SAVES_DIR, '.selected_save');
    if (fs.existsSync(markerPath)) {
      const selected = fs.readFileSync(markerPath, 'utf-8').trim();
      if (selected) return selected;
    }
  } catch {}

  // Fall back to most recently modified save
  try {
    if (!fs.existsSync(config.SAVES_DIR)) return null;
    const dirs = fs.readdirSync(config.SAVES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(path.join(config.SAVES_DIR, e.name)).mtimeMs; } catch {}
        return { name: e.name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return dirs[0]?.name || null;
  } catch {
    return null;
  }
}

function getSaveFilePath(saveName) {
  if (!saveName) return null;
  const p = path.join(config.SAVES_DIR, saveName, saveName);
  return fs.existsSync(p) ? p : null;
}

// -- XML tag extractor --
// Lightweight single-tag extractor — avoids a full XML parser dependency.
// Only works for simple non-nested tags; good enough for save file fields.

function xmlTag(xml, tag, all = false) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  if (all) {
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
    return results;
  }
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

function xmlInt(xml, tag) {
  const v = xmlTag(xml, tag);
  return v !== null ? parseInt(v, 10) : null;
}

function xmlBool(xml, tag) {
  const v = xmlTag(xml, tag);
  return v === 'true' ? true : v === 'false' ? false : null;
}

// -- Community Center parsing --
// The save file stores CC bundle completion as a map of bundle IDs → bool arrays.
// We count completed rooms by checking whether all bundles in each room are done.

const CC_ROOMS = {
  'Pantry':          [0, 1, 2, 3, 4, 5],
  'Crafts Room':     [13, 14, 15, 16, 17],
  'Fish Tank':       [6, 7, 8, 9, 10],
  'Boiler Room':     [20, 21, 22],
  'Vault':           [23, 24, 25, 26],
  'Bulletin Board':  [31, 32, 33, 34, 35, 36],
};

function parseCommunityCenter(xml) {
  try {
    // Find the communityCenter location block
    const ccMatch = xml.match(/<GameLocation[^>]*xsi:type="CommunityCenter"[^>]*>([\s\S]*?)<\/GameLocation>/);
    if (!ccMatch) return null;

    const ccXml = ccMatch[1];

    // Parse bundle completion: <item><key><int>ID</int></key><value><ArrayOfBoolean>...</ArrayOfBoolean></value></item>
    const bundleComplete = {};
    const itemRe = /<item>\s*<key>\s*<int>(\d+)<\/int>\s*<\/key>\s*<value>\s*<ArrayOfBoolean>([\s\S]*?)<\/ArrayOfBoolean>/g;
    let m;
    while ((m = itemRe.exec(ccXml)) !== null) {
      const bundleId = parseInt(m[1], 10);
      const bools    = m[2].match(/<boolean>(true|false)<\/boolean>/g) || [];
      // Bundle is complete if all slots are true
      bundleComplete[bundleId] = bools.length > 0 && bools.every(b => b.includes('true'));
    }

    const rooms = {};
    let completedRooms = 0;
    const totalRooms   = Object.keys(CC_ROOMS).length;

    for (const [roomName, bundleIds] of Object.entries(CC_ROOMS)) {
      const roomDone = bundleIds.every(id => bundleComplete[id] === true);
      const roomBundles = bundleIds.map(id => ({
        id,
        complete: bundleComplete[id] === true,
      }));
      rooms[roomName] = { complete: roomDone, bundles: roomBundles };
      if (roomDone) completedRooms++;
    }

    const percentComplete = Math.round((completedRooms / totalRooms) * 100);

    return { rooms, completedRooms, totalRooms, percentComplete };
  } catch {
    return null;
  }
}

// -- Save file parser --

function parseSaveFile(savePath) {
  try {
    const xml = fs.readFileSync(savePath, 'utf-8');

    const farmName    = xmlTag(xml, 'farmName');
    const playerName  = xmlTag(xml, 'name');
    const year        = xmlInt(xml, 'year');
    const season      = xmlTag(xml, 'currentSeason');
    const day         = xmlInt(xml, 'dayOfMonth');
    const money       = xmlInt(xml, 'money');
    const totalEarned = xmlInt(xml, 'totalMoneyEarned');
    const playtimeMs  = xmlInt(xml, 'millisecondsPlayed');
    const farmType    = xmlInt(xml, 'whichFarm');

    const FARM_TYPES = ['Standard', 'Riverland', 'Forest', 'Hilltop', 'Wilderness', 'Four Corners', 'Beach', 'Meadowlands'];

    const cc = parseCommunityCenter(xml);

    return {
      farmName,
      playerName,
      year,
      season,
      day,
      money,
      totalEarned,
      playtimeHours: playtimeMs !== null ? Math.floor(playtimeMs / 3600000) : null,
      farmType:      farmType !== null ? (FARM_TYPES[farmType] || `Type ${farmType}`) : null,
      communityCenter: cc,
    };
  } catch {
    return null;
  }
}

// -- Live status reader --

function readLiveStatus() {
  try {
    if (!fs.existsSync(config.LIVE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(config.LIVE_FILE, 'utf-8'));

    // Reject stale data (older than 30s)
    // timestamp is Unix seconds from C# mod — multiply by 1000 to compare with Date.now() (ms)
    if (data.timestamp) {
      const age = Date.now() - (data.timestamp * 1000);
      if (age > 30000) return null;
    }

    return data;
  } catch {
    return null;
  }
}

// -- Route Handlers --

function getFarmOverview(req, res) {
  const saveName  = getSelectedSaveName();
  const savePath  = getSaveFilePath(saveName);
  const live      = readLiveStatus();
  const saveData  = savePath ? parseSaveFile(savePath) : null;

  if (!live && !saveData) {
    return res.json({
      available: false,
      message:   saveName
        ? 'Save file found but could not be read'
        : 'No save file selected or found',
    });
  }

  // Merge: live data wins for real-time fields, save data fills in the rest
  const overview = {
    available:  true,
    saveName,
    liveDataAvailable: !!live,

    // Real-time fields (prefer live)
    players:    live?.players    ?? [],
    season:     live?.season     ?? saveData?.season  ?? null,
    day:        live?.day        ?? saveData?.day      ?? null,
    year:       live?.year       ?? saveData?.year     ?? null,
    timeOfDay:  live?.gameTimeMinutes ?? null,
    weather:    live?.weather    ?? null,
    serverState: live?.serverState ?? null,

    // Rich fields from save file
    farmName:    saveData?.farmName    ?? live?.farmName    ?? null,
    playerName:  saveData?.playerName  ?? null,
    farmType:    saveData?.farmType    ?? null,
    money:       saveData?.money       ?? null,
    totalEarned: saveData?.totalEarned ?? null,
    playtimeHours: saveData?.playtimeHours ?? null,
    communityCenter: saveData?.communityCenter ?? null,
  };

  res.json(overview);
}

function getLiveStatus(req, res) {
  const live = readLiveStatus();

  if (!live) {
    return res.json({
      available: false,
      message:   fs.existsSync(config.LIVE_FILE)
        ? 'Live status file exists but data is stale or unreadable'
        : 'StardropDashboard mod not installed or server not running',
    });
  }

  res.json({ available: true, ...live });
}

module.exports = { getFarmOverview, getLiveStatus };