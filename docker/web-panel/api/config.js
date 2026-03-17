/**
 * StardropHost | web-panel/api/config.js
 * Environment configuration management
 */

const fs   = require('fs');
const path = require('path');
const config = require('../server');

// -- Config schema --
// Groups and fields shown in the web UI settings panel.
// Steam credentials are NOT stored here — they live in the steam-auth container (Phase 4).

const CONFIG_SCHEMA = {
  'Server': [
    { key: 'SERVER_PASSWORD',  label: 'Server Password',  type: 'password', viewable: true, default: '' },
    { key: 'PUBLIC_IP',        label: 'Public Join IP',    type: 'text',     default: '',
      description: 'Shown to players on the join screen. Leave blank to auto-detect.' },
  ],
  'VNC': [
    { key: 'ENABLE_VNC',       label: 'Enable VNC',        type: 'boolean',  default: 'false' },
    { key: 'VNC_PASSWORD',     label: 'VNC Password',      type: 'password', viewable: true, default: 'stardew1', maxLength: 8 },
    { key: 'DISABLE_RENDERING',label: 'Disable Rendering', type: 'boolean',  default: 'true',
      description: 'Disables the display server when VNC is not in use. Saves CPU.' },
  ],
  'Display': [
    { key: 'RESOLUTION_WIDTH',  label: 'Resolution Width',  type: 'number', default: '1280' },
    { key: 'RESOLUTION_HEIGHT', label: 'Resolution Height', type: 'number', default: '720' },
    { key: 'REFRESH_RATE',      label: 'Refresh Rate',      type: 'number', default: '60' },
  ],
  'Performance': [
    { key: 'CPU_LIMIT',    label: 'CPU Limit',    type: 'text', default: '',
      description: 'Docker CPU limit (e.g. 2.0 for 2 cores). Leave blank for no limit.' },
    { key: 'MEMORY_LIMIT', label: 'Memory Limit', type: 'text', default: '',
      description: 'Docker memory limit (e.g. 2g). Leave blank for no limit.' },
    { key: 'LOW_PERF_MODE', label: 'Low Performance Mode', type: 'boolean', default: 'false' },
    { key: 'TARGET_FPS',    label: 'Target FPS',            type: 'number',  default: '' },
  ],
  'Backup': [
    { key: 'ENABLE_AUTO_BACKUP',        label: 'Auto Backup',              type: 'boolean', default: 'true' },
    { key: 'MAX_BACKUPS',               label: 'Max Backups',              type: 'number',  default: '7' },
    { key: 'BACKUP_HOUR',               label: 'Backup Hour (0–23)',        type: 'number',  default: '4', min: 0, max: 23 },
    { key: 'BACKUP_COMPRESSION_LEVEL',  label: 'Compression Level (1–9)',  type: 'number',  default: '1', min: 1, max: 9,
      description: '1 = fastest, 9 = smallest. Default 1 is fine for most saves.' },
  ],
  'Stability': [
    { key: 'ENABLE_CRASH_RESTART', label: 'Auto Crash Restart', type: 'boolean', default: 'true' },
    { key: 'MAX_CRASH_RESTARTS',   label: 'Max Restarts',       type: 'number',  default: '5' },
  ],
  'Monitoring': [
    { key: 'ENABLE_LOG_MONITOR', label: 'Log Monitor',   type: 'boolean', default: 'true' },
    { key: 'METRICS_PORT',       label: 'Metrics Port',  type: 'number',  default: '9090' },
  ],
  'Other': [
    { key: 'TZ', label: 'Timezone', type: 'text', default: 'UTC' },
  ],
};

// -- Save detection --
// Mirrors getSelectedSaveName() in saves.js: startup_preferences first, then .selected_save

function detectCurrentSaveName() {
  // Primary: startup_preferences
  try {
    const prefsPath = path.join(config.CONFIG_DIR, 'startup_preferences');
    if (fs.existsSync(prefsPath)) {
      const content = fs.readFileSync(prefsPath, 'utf-8');
      const match   = content.match(/^saveFolderName\s*=\s*(.+)$/m);
      if (match && match[1].trim()) return match[1].trim();
    }
  } catch {}

  // Fallback: .selected_save marker
  try {
    const markerPath = path.join(config.SAVES_DIR, '.selected_save');
    if (fs.existsSync(markerPath)) {
      const selected = fs.readFileSync(markerPath, 'utf-8').trim();
      if (selected && fs.existsSync(path.join(config.SAVES_DIR, selected))) return selected;
    }
  } catch {}

  // Last resort: most recently modified save dir
  try {
    if (!fs.existsSync(config.SAVES_DIR)) return '';
    const candidates = fs.readdirSync(config.SAVES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(path.join(config.SAVES_DIR, e.name)).mtimeMs; } catch {}
        return { name: e.name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.name || '';
  } catch {
    return '';
  }
}

function listAvailableSaves() {
  try {
    if (!fs.existsSync(config.SAVES_DIR)) return [];
    return fs.readdirSync(config.SAVES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

// -- .env file helpers --

function findEnvFile() {
  const candidates = [
    config.ENV_FILE,
    '/home/steam/web-panel/data/runtime.env',
    path.join(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return config.ENV_FILE || '/home/steam/web-panel/data/runtime.env';
}

function parseEnvFile() {
  const env     = {};
  const envPath = findEnvFile();
  if (!envPath || !fs.existsSync(envPath)) return env;

  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key   = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    env[key] = value;
  }

  return env;
}

function writeEnvFile(envData) {
  const envPath = findEnvFile();
  const envDir  = path.dirname(envPath);

  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true });

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '# Managed by StardropHost web panel\n', 'utf-8');
  }

  const original    = fs.readFileSync(envPath, 'utf-8');
  const lines       = original.split('\n');
  const updatedKeys = new Set();

  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return line;

    const key = trimmed.slice(0, eqIndex).trim();
    if (key in envData) {
      updatedKeys.add(key);
      return `${key}=${envData[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(envData)) {
    if (!updatedKeys.has(key)) newLines.push(`${key}=${value}`);
  }

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
}

// -- Route Handlers --

function getConfig(req, res) {
  const env            = parseEnvFile();
  const detectedSave   = detectCurrentSaveName();
  const availableSaves = listAvailableSaves();
  const groups         = [];

  for (const [groupName, fields] of Object.entries(CONFIG_SCHEMA)) {
    const items = fields.map(field => {
      let value = env[field.key] ?? process.env[field.key] ?? field.default ?? '';

      // Sensitive: mask unless viewable
      const masked = field.sensitive && !field.viewable && value;

      return {
        key:          field.key,
        label:        field.label,
        type:         field.type,
        default:      field.default,
        description:  field.description,
        viewable:     field.viewable   || false,
        sensitive:    field.sensitive  || false,
        preserveIfBlank: field.preserveIfBlank || false,
        readonly:     field.readonly   || false,
        min:          field.min,
        max:          field.max,
        maxLength:    field.maxLength,
        options:      field.options || undefined,
        value:        masked ? undefined : value,
        hasValue:     !!(env[field.key] || process.env[field.key]),
      };
    });

    groups.push({ name: groupName, items });
  }

  res.json({ groups });
}

function updateConfig(req, res) {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    // Build a flat map of all known fields for validation
    const fieldMap = new Map();
    for (const fields of Object.values(CONFIG_SCHEMA)) {
      for (const field of fields) fieldMap.set(field.key, field);
    }

    // Reject unknown or readonly keys
    for (const key of Object.keys(updates)) {
      const field = fieldMap.get(key);
      if (!field) continue; // Silently skip unknown keys
      if (field.readonly) {
        return res.status(400).json({ error: `Field '${key}' is read-only` });
      }
    }

    const normalized = { ...updates };

    // ENABLE_VNC toggle also updates VNC_BIND_HOST
    if ('ENABLE_VNC' in normalized) {
      normalized.VNC_BIND_HOST = normalized.ENABLE_VNC === 'true' ? '0.0.0.0' : '127.0.0.1';
    }

    // Drop blank values for preserveIfBlank fields (e.g. passwords)
    for (const [key, field] of fieldMap.entries()) {
      if (field.preserveIfBlank && normalized[key] === '') {
        delete normalized[key];
      }
    }

    writeEnvFile(normalized);

    res.json({
      success: true,
      message: 'Configuration saved. Recreate the container to apply changes.',
      needsRestart: true,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update config', details: e.message });
  }
}

module.exports = { getConfig, updateConfig };