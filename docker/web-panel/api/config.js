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
  'VNC & Display': [
    { key: 'VNC_PASSWORD',      label: 'VNC Password',             type: 'password', viewable: true, default: 'stardew1', maxLength: 8 },
    { key: 'DISABLE_RENDERING', label: 'Disable Rendering when VNC is off', type: 'boolean', default: 'true',
      description: 'Turns off the display server when VNC is not active. Saves CPU.' },
    { key: 'DISPLAY_PRESET', label: 'Display Resolution', type: 'select', default: '1280x720@60',
      options: [
        { value: '800x600@30',   label: '800×600 @ 30 Hz (Low Performance)' },
        { value: '1280x720@30',  label: '1280×720 @ 30 Hz (HD)' },
        { value: '1280x720@60',  label: '1280×720 @ 60 Hz (HD)' },
        { value: '1920x1080@30', label: '1920×1080 @ 30 Hz (Full HD)' },
        { value: '1920x1080@60', label: '1920×1080 @ 60 Hz (Full HD)' },
        { value: '2560x1440@60', label: '2560×1440 @ 60 Hz (QHD)' },
      ] },
    { key: 'TARGET_FPS', label: 'Target FPS', type: 'number', default: '',
      description: 'Cap the game frame rate. Leave blank for uncapped.' },
  ],
  'Performance': [
    { key: 'CPU_LIMIT',    label: 'CPU Limit',    type: 'select', default: '',
      options: [
        { value: '',  label: 'No limit' },
        { value: '1', label: '1 core' },
        { value: '2', label: '2 cores' },
        { value: '4', label: '4 cores' },
        { value: '8', label: '8 cores' },
      ] },
    { key: 'MEMORY_LIMIT', label: 'Memory Limit', type: 'select', default: '',
      options: [
        { value: '',    label: 'No limit' },
        { value: '1g',  label: '1 GB' },
        { value: '2g',  label: '2 GB' },
        { value: '4g',  label: '4 GB' },
        { value: '8g',  label: '8 GB' },
        { value: '16g', label: '16 GB' },
      ] },
  ],
  'Backup': [
    { key: 'ENABLE_AUTO_BACKUP',     label: 'Auto Backup',               type: 'boolean', default: 'true' },
    { key: 'MAX_BACKUPS',            label: 'Max Backups',               type: 'number',  default: '7' },
    { key: 'BACKUP_INTERVAL_HOURS',  label: 'Backup Frequency (hours)',  type: 'number',  default: '24', min: 1, max: 24,
      description: 'How often to back up saves. 24 = once a day.' },
  ],
  'Stability': [
    { key: 'ENABLE_CRASH_RESTART', label: 'Auto Crash Restart', type: 'boolean', default: 'true' },
    { key: 'MAX_CRASH_RESTARTS',   label: 'Max Restarts',       type: 'number',  default: '3' },
  ],
  'Monitoring': [
    { key: 'ENABLE_LOG_MONITOR',          label: 'Log Monitor',                   type: 'boolean', default: 'true' },
    { key: 'METRICS_PORT',                label: 'Metrics Port',                  type: 'number',  default: '9090' },
    { key: 'PANEL_UPDATE_CHECK_HOURS',    label: 'Panel Update Check (hours)',    type: 'number',  default: '24',
      description: 'How often to check GitHub for StardropHost updates. Set to 0 to disable.' },
  ],
  'Server': [
    { key: 'SERVER_PASSWORD',  label: 'Server Password',  type: 'password', viewable: true, default: '' },
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

  const serverMode = (env.SERVER_MODE || process.env.SERVER_MODE || 'lan')
    .replace(/['"]/g, '').trim() || 'lan';
  res.json({ groups, serverMode });
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