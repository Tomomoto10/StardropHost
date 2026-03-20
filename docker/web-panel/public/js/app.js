/**
 * StardropHost | web-panel/public/js/app.js
 * Main application — navigation, WebSocket, all page logic
 */

// ─── Auth Check ──────────────────────────────────────────────────
(function authCheck() {
  if (!API.token) { window.location.href = '/login.html'; return; }
  API.get('/api/auth/verify').then(data => {
    if (!data || !data.valid) { window.location.href = '/login.html'; return; }
    const loader = document.getElementById('app-loader');
    if (loader) loader.classList.add('hidden');
    // Check wizard before showing main app
    API.get('/api/wizard/status').then(wiz => {
      if (wiz && wiz.needsWizard) {
        showWizard(wiz);
      } else {
        document.getElementById('app').style.display = 'flex';
        init();
      }
    }).catch(() => {
      document.getElementById('app').style.display = 'flex';
      init();
    });
  }).catch(() => { window.location.href = '/login.html'; });
})();

// ─── Timezone Picker ─────────────────────────────────────────────
// Builds a search-as-you-type timezone picker inside `containerId`.
// The selected IANA timezone value is readable via tzPickerValue(containerId).

function tzPickerValue(containerId) {
  const el = document.getElementById(containerId);
  return el?.querySelector('input[data-tz-value]')?.dataset.tzValue || '';
}

function buildTzPicker(containerId, initialValue) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Get all IANA timezone IDs available in this browser
  const zones = (() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
  })();

  // Compute UTC offset string for a timezone
  function getOffset(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date());
      return parts.find(p => p.type === 'timeZoneName')?.value || 'UTC';
    } catch { return ''; }
  }

  // Build options array once (lazy, on first search)
  let _opts = null;
  function getOpts() {
    if (_opts) return _opts;
    _opts = zones.map(tz => {
      const off = getOffset(tz);
      return { value: tz, off, search: (tz + ' ' + off).toLowerCase().replace(/[/_]/g, ' ') };
    });
    return _opts;
  }

  const inputId  = `${containerId}-search`;
  const dropId   = `${containerId}-drop`;
  const hiddenId = `${containerId}-val`;

  const displayValue = initialValue
    ? `${initialValue} (${getOffset(initialValue)})`
    : '';

  container.innerHTML = `
    <input class="input" id="${inputId}" type="text" autocomplete="off"
      placeholder="Search timezone (e.g. Melbourne, UTC+10)"
      value="${escapeHtml(displayValue)}" style="width:100%">
    <input type="hidden" id="${hiddenId}" data-tz-value="${escapeHtml(initialValue || '')}"
      value="${escapeHtml(initialValue || '')}">
    <div class="tz-dropdown" id="${dropId}" style="display:none"></div>
  `;

  const searchEl  = document.getElementById(inputId);
  const hiddenEl  = document.getElementById(hiddenId);
  const dropEl    = document.getElementById(dropId);
  let activeIdx   = -1;

  function showDropdown(results) {
    if (!results.length) { dropEl.style.display = 'none'; return; }
    dropEl.innerHTML = results.slice(0, 50).map((r, i) =>
      `<div class="tz-option" data-i="${i}" data-val="${escapeHtml(r.value)}">
         <span class="tz-option-tz">${escapeHtml(r.value)}</span>
         <span class="tz-option-off">${escapeHtml(r.off)}</span>
       </div>`
    ).join('');
    dropEl.style.display = '';
    activeIdx = -1;
    dropEl.querySelectorAll('.tz-option').forEach(opt => {
      opt.onmousedown = e => { e.preventDefault(); selectTz(opt.dataset.val); };
    });
  }

  function selectTz(val) {
    const off = getOffset(val);
    searchEl.value        = val ? `${val} (${off})` : '';
    hiddenEl.value        = val;
    hiddenEl.dataset.tzValue = val;
    dropEl.style.display  = 'none';
    activeIdx             = -1;
  }

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.trim().toLowerCase();
    hiddenEl.value = '';
    hiddenEl.dataset.tzValue = '';
    if (!q) { dropEl.style.display = 'none'; return; }
    const results = getOpts().filter(o => o.search.includes(q));
    showDropdown(results);
  });

  searchEl.addEventListener('keydown', e => {
    const opts = dropEl.querySelectorAll('.tz-option');
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, opts.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      selectTz(opts[activeIdx].dataset.val);
      return;
    } else if (e.key === 'Escape') {
      dropEl.style.display = 'none'; return;
    }
    opts.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    if (activeIdx >= 0) opts[activeIdx].scrollIntoView({ block: 'nearest' });
  });

  searchEl.addEventListener('blur', () => {
    setTimeout(() => { dropEl.style.display = 'none'; }, 150);
  });

  // If initial value passed, pre-select it
  if (initialValue) selectTz(initialValue);
}

// ─── Setup Wizard ────────────────────────────────────────────────
let _wizState = {};

function showWizard(status) {
  _wizState = status;
  document.getElementById('wizard-overlay').style.display = 'block';
  // Populate the game path hint
  const gpEl = document.getElementById('wiz-game-path');
  if (gpEl) gpEl.textContent = '/home/stardew-server/stardrophost/data/game/';
  // Map backend step to UI step (new step 3 is download progress; backend 3→UI 4, 4→5, 5→6)
  const bs = status.currentStep || 2;
  let uiStep = bs <= 2 ? 2 : bs + 1; // backend 3→UI 4, backend 4→UI 5, backend 5→UI 6
  if (uiStep < 2) uiStep = 2;
  wizGoToStep(uiStep);
}

function wizGoToStep(n) {
  document.querySelectorAll('.wiz-step').forEach(el => el.style.display = 'none');
  const step = document.getElementById(`wiz-step-${n}`);
  if (step) step.style.display = 'block';
  // Update dots (steps 2-7 → dots 0-5)
  document.querySelectorAll('.wiz-dot').forEach((dot, i) => {
    const dotStep = i + 2;
    dot.classList.toggle('done',   dotStep < n);
    dot.classList.toggle('active', dotStep === n);
  });
  _wizState.currentStep = n;

  // Step 2: auto-check game files on entry
  if (n === 2) {
    const hint = sessionStorage.getItem('wizardHint');
    if (hint === 'local') sessionStorage.removeItem('wizardHint');
    wizCheckGameFiles();
  }

  // Ensure timezone picker is built when step 5 is shown (handles refresh mid-wizard)
  if (n === 5 && !document.getElementById('wiz-tz-picker-search')) {
    buildTzPicker('wiz-tz-picker', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  }
}

function wizSetMethod(method) {
  document.querySelectorAll('.wiz-method-btn').forEach(b => b.classList.toggle('active', b.dataset.method === method));
  document.getElementById('wiz-method-local').style.display = method === 'local' ? 'block' : 'none';
  document.getElementById('wiz-method-steam').style.display = method === 'steam' ? 'block' : 'none';
  _wizState._method = method;
  // Steam: hide the Continue row entirely — download button auto-advances
  // Local/path: show Continue row, enable once files are verified
  const continueRow = document.getElementById('wiz-step2-continue-row');
  if (continueRow) continueRow.style.display = method === 'steam' ? 'none' : '';
  const nextBtn = document.getElementById('wiz-step2-next');
  if (nextBtn) nextBtn.disabled = !_wizState._filesFound;
}

async function wizScanGamePath() {
  const pathInput = document.getElementById('wiz-scan-path');
  const statusEl  = document.getElementById('wiz-scan-status');
  const gamePath  = pathInput?.value?.trim();
  if (!gamePath) { statusEl.textContent = 'Enter a path first.'; return; }

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Scanning…';
  try {
    const data = await API.post('/api/wizard/step/2', { method: 'path', gamePath });
    if (data?.success) {
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = '✅ Game files found and registered!';
      _wizState._filesFound = true;
      _wizState._method = 'path';
      document.getElementById('wiz-step2-next').disabled = false;
    }
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || '❌ Path not found or missing game files.';
  }
}

let _steamAuthPollTimer = null;
let _steamDlPollTimer   = null;
let _steamDlLogLines    = 0;

// Step A — initiate Steam login via steam-auth sidecar (this triggers the Guard email)
async function wizSteamLogin() {
  const user     = document.getElementById('wiz-steam-user')?.value?.trim();
  const pass     = document.getElementById('wiz-steam-pass')?.value?.trim();
  const statusEl = document.getElementById('wiz-steam-status');
  const loginBtn = document.getElementById('wiz-steam-login-btn');

  if (!user || !pass) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Enter your Steam username and password.';
    return;
  }

  // Store credentials in memory only — never written to disk here
  _wizState._steamUser = user;
  _wizState._steamPass = pass;

  loginBtn.disabled = true;
  loginBtn.textContent = 'Connecting to Steam…';
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Connecting to Steam…';

  try {
    const data = await API.post('/api/steam/login', { username: user, password: pass });
    if (data?.success) {
      statusEl.style.color = '';
      statusEl.textContent = 'Logging in… waiting for Steam Guard if required.';
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = setInterval(wizPollSteamAuth, 3000);
    } else {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data?.error || 'Login failed — try again.';
    }
  } catch (e) {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Login to Steam';
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Could not reach Steam auth service — is it running?';
  }
}

// Step B — poll steam-auth status every 3s (mirrors the original working flow)
// IMPORTANT: polling is NEVER stopped on guard_required — it keeps running so that
// when the user submits the code and steam-auth transitions to 'online', the poll
// detects it automatically without needing a manual interval restart.
async function wizPollSteamAuth() {
  const statusEl = document.getElementById('wiz-steam-status');
  const guardRow = document.getElementById('wiz-steam-guard-row');
  const loginBtn = document.getElementById('wiz-steam-login-btn');

  try {
    const data = await API.get('/api/steam/status');
    if (!data) return;

    if (data.state === 'guard_required') {
      // Show guard row — keep polling so we detect 'online' after code is submitted
      guardRow.style.display = '';
      document.getElementById('wiz-steam-guard').focus();
      statusEl.style.color = 'var(--accent-warning,#f59e0b)';
      statusEl.textContent = data.lastError
        ? '⚠️ ' + data.lastError + ' — try again.'
        : '📧 A Steam Guard code has been sent to your email — enter it above and click Submit Code.';

    } else if (data.state === 'online') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      guardRow.style.display = 'none';
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = '✅ Steam authenticated — starting game download…';
      _wizState._method = 'steam';
      wizTriggerSteamDownload();

    } else if (data.state === 'error') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data.lastError || '❌ Steam login error — try again.';

    } else if (data.state === 'unavailable') {
      clearInterval(_steamAuthPollTimer);
      _steamAuthPollTimer = null;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login to Steam';
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = '❌ Steam auth service unavailable — check container logs.';
    }
    // state === 'logging_in' → keep polling, no UI change needed
  } catch {}
}

// Step C — submit the Guard code to steam-auth
// The polling interval is still running — it will detect 'online' automatically.
async function wizSubmitSteamGuard() {
  const code     = document.getElementById('wiz-steam-guard')?.value?.trim();
  const statusEl = document.getElementById('wiz-steam-status');
  const guardBtn = document.getElementById('wiz-steam-guard-btn');

  if (!code) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Enter the code from your email.';
    return;
  }

  guardBtn.disabled = true;
  guardBtn.textContent = 'Verifying…';
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Submitting Steam Guard code…';

  try {
    await API.post('/api/steam/guard', { code });
    statusEl.style.color = 'var(--text-secondary)';
    statusEl.textContent = 'Code submitted — waiting for Steam confirmation…';
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to submit code — try again.';
  } finally {
    guardBtn.disabled = false;
    guardBtn.textContent = 'Submit Code';
  }
}

// Step D — credentials verified; write to runtime.env to kick off steamcmd, then advance
async function wizTriggerSteamDownload() {
  const statusEl = document.getElementById('wiz-steam-status');

  try {
    const body = {
      method:        'steam',
      steamUsername: _wizState._steamUser,
      steamPassword: _wizState._steamPass,
    };

    const data = await API.post('/api/wizard/step/2', body);
    if (data?.success) {
      _wizState._method     = 'steam';
      _wizState._filesFound = true;
      statusEl.style.color  = 'var(--accent)';
      statusEl.textContent  = '✅ Steam code accepted — starting game download…';
      // Advance to step 3 (download progress screen) and begin polling
      _steamDlLogLines = 0;
      setTimeout(() => { wizGoToStep(3); wizPollDownloadProgress(); }, 1200);
    } else {
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = data?.error || 'Failed to start download.';
    }
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to start download.';
  }
}

// Step 3 — poll game-ready + stream setup.log while download/install is running
const _DL_STAGE_PCT = { waiting: 5, no_game_files: 5, downloading: 30, installing: 65, starting: 90, loading: 95, running: 97, hosting: 99, ready: 100 };
const _DL_STAGE_TXT = {
  waiting:       'Connecting to Steam…',
  no_game_files: 'Waiting for download to begin…',
  downloading:   'Downloading Stardew Valley via Steam… (may take 5–15 min)',
  installing:    'Installing SMAPI and building mods… (first run only)',
  starting:      'Game installed — starting server…',
  loading:       'Server loading…',
  running:       'Server running — proceeding to setup…',
  hosting:       'Multiplayer enabled — proceeding to setup…',
  ready:         '✅ Game installed and server is ready!',
};

// Show a "← Back to Step 2" button below the step-3 log when a fatal error occurs.
function _wizShowStep3BackBtn(msg) {
  const logEl = document.getElementById('wiz-dl-log');
  if (!logEl) return;
  // Only add once
  if (document.getElementById('wiz-dl-back-btn')) return;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start';
  if (msg) {
    const p = document.createElement('p');
    p.style.cssText = 'font-size:12px;color:var(--accent-error,#ef4444);margin:0';
    p.textContent = msg;
    wrap.appendChild(p);
  }
  const btn = document.createElement('button');
  btn.id = 'wiz-dl-back-btn';
  btn.className = 'btn btn-secondary';
  btn.textContent = '← Back to Step 2';
  btn.onclick = () => { wizGoToStep(2); };
  wrap.appendChild(btn);
  logEl.parentElement.appendChild(wrap);
}

// Returns the index of the LAST "Steam credentials detected" line in the log,
// or 0 if not found. Using the last occurrence means each new download attempt
// resets the view — old sentinels from earlier attempts are excluded.
function _wizLatestAttemptStart(lines) {
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/Steam credentials detected/i.test(lines[i].text)) idx = i;
  }
  return idx;
}

// Stream setup.log lines into the step-3 log box, starting from the most
// recent "Steam credentials detected" line so old attempts are hidden.
function _wizStreamLogs(lines, logEl, cntEl) {
  if (!logEl || !lines?.length) return;

  // Recalculate start on first display or after a retry reset
  if (_steamDlLogLines === 0) {
    const startIdx = _wizLatestAttemptStart(lines);
    if (startIdx > 0) _steamDlLogLines = startIdx;
    logEl.innerHTML = ''; // clear placeholder
  }

  const newLines = lines.slice(_steamDlLogLines);
  if (!newLines.length) return;

  // Lines that are pure container-startup noise — not useful during the wizard
  const _wizNoisePatterns = [
    /StardropHost v[\d.]+ Starting/,
    /Phase \d+:/,
    /Step 0:/,
    /Step 1:/,
    /Starting web panel/,
    /Web panel started/,
    /Validating configuration/,
    /Configuration loaded/,
    /Setting up game files/,
    /No game files found/,
    /waiting for setup wizard/,
    /Open the web panel/,
    /={4,}/,           // === dividers
  ];

  newLines.forEach(l => {
    if (_wizNoisePatterns.some(p => p.test(l.text))) return;
    const div = document.createElement('div');
    div.style.color = l.level === 'error'            ? 'var(--accent-error,#ef4444)' :
                      l.level === 'warn'             ? 'var(--accent-warning,#f59e0b)' :
                      l.text.includes('[STEP]')      ? 'var(--accent)' :
                      l.text.includes('[STEAM]')     ? 'var(--text-secondary)' : '';
    if (l.text.includes('[STEP]')) div.style.fontWeight = '600';
    div.textContent = l.text;
    logEl.appendChild(div);
  });
  logEl.scrollTop = logEl.scrollHeight;
  _steamDlLogLines = lines.length;
  if (cntEl) cntEl.textContent = `${_steamDlLogLines} lines`;
}

// Called when the user submits a Guard code for steamcmd (separate from the
// sidecar login code). Re-triggers the download with the code included.
async function wizSubmitSteamcmdGuard() {
  const input    = document.getElementById('wiz-dl-guard-input');
  const btn      = document.getElementById('wiz-dl-guard-btn');
  const statusEl = document.getElementById('wiz-dl-guard-status');
  const lbl      = document.getElementById('wiz-dl-status');
  const bar      = document.getElementById('wiz-dl-bar');

  const code = input?.value?.trim();
  if (!code) { if (statusEl) statusEl.textContent = 'Please enter the Guard code.'; return; }
  if (!_wizState._steamUser || !_wizState._steamPass) {
    if (statusEl) statusEl.textContent = 'Session expired — go back to Step 2 and log in again.';
    return;
  }

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Submitting…';

  try {
    const data = await API.post('/api/wizard/step/2', {
      method: 'steam',
      steamUsername: _wizState._steamUser,
      steamPassword: _wizState._steamPass,
      steamGuardCode: code,
    });
    if (data?.success) {
      const guardRow = document.getElementById('wiz-dl-guard-row');
      if (guardRow) guardRow.style.display = 'none';
      if (input) input.value = '';
      if (lbl) { lbl.style.color = ''; lbl.textContent = 'Guard code sent — retrying download…'; }
      if (bar) bar.style.width = '35%';
      // Reset log position so we start streaming from the new attempt
      _steamDlLogLines = 0;
      // Remove any back button from a previous failed attempt
      const oldBack = document.getElementById('wiz-dl-back-btn');
      if (oldBack) oldBack.parentElement.remove();
      // Resume polling
      _steamDlPollTimer = setTimeout(wizPollDownloadProgress, 5000);
    } else {
      if (statusEl) statusEl.textContent = data?.error || 'Failed to submit code.';
      if (btn) btn.disabled = false;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Network error — please try again.';
    if (btn) btn.disabled = false;
  }
}

async function wizPollDownloadProgress() {
  const bar     = document.getElementById('wiz-dl-bar');
  const lbl     = document.getElementById('wiz-dl-status');
  const logEl   = document.getElementById('wiz-dl-log');
  const cntEl   = document.getElementById('wiz-dl-log-count');

  try {
    const data  = await API.get('/api/wizard/game-ready');
    const stage = data?.stage || 'waiting';
    const pct   = _DL_STAGE_PCT[stage] || 5;

    if (bar) bar.style.width = pct + '%';
    if (lbl) {
      lbl.textContent = _DL_STAGE_TXT[stage] || lbl.textContent;
      lbl.style.color = stage === 'ready' ? 'var(--accent)' :
                        stage === 'no_game_files' ? 'var(--accent-error,#ef4444)' : '';
    }

    // Advance to step 4 (resource limits) once game + SMAPI are installed
    if (stage === 'starting' || stage === 'loading' || stage === 'running' || stage === 'hosting' || data?.ready) {
      clearTimeout(_steamDlPollTimer);
      _steamDlPollTimer = null;
      _wizState._gameMethod = 'steam';
      if (lbl) { lbl.style.color = 'var(--accent)'; lbl.textContent = '✅ Game installed — continuing setup…'; }
      setTimeout(() => wizGoToStep(4), 1200);
      return;
    }

    // Check setup.log for status and errors
    const log = await API.get('/api/logs/setup?lines=300');
    if (log?.lines?.length) {
      // Only check sentinels in lines from the latest attempt onwards —
      // this prevents old STEAM_GUARD_REQUIRED etc. from re-triggering.
      const attemptStart = _wizLatestAttemptStart(log.lines);
      const allText = log.lines.slice(attemptStart).map(l => l.text).join('\n');

      // Detect steamcmd Guard requirement — show inline input, pause polling.
      // Always show (even on retry) so the user can correct a wrong code.
      if (/STEAM_GUARD_REQUIRED/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        const guardRow  = document.getElementById('wiz-dl-guard-row');
        const guardBtn  = document.getElementById('wiz-dl-guard-btn');
        const guardStat = document.getElementById('wiz-dl-guard-status');
        if (guardRow) guardRow.style.display = '';
        if (guardBtn) guardBtn.disabled = false;
        if (guardStat) guardStat.textContent = '';
        if (lbl) { lbl.style.color = 'var(--accent-warning,#f59e0b)'; lbl.textContent = '⏳ Waiting for Steam Guard code…'; }
        if (bar) bar.style.width = '30%';
        _wizStreamLogs(log.lines, logEl, cntEl);
        return;
      }

      if (/STEAM_WRONG_PASSWORD/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Wrong password.'; }
        _wizShowStep3BackBtn('Wrong Steam password — go back and re-enter your credentials.');
        return;
      }

      if (/STEAM_RATE_LIMIT/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Steam rate limit.'; }
        _wizShowStep3BackBtn('Steam has rate-limited this login. Wait a few minutes, then go back and retry.');
        return;
      }

      if (/STEAM_DOWNLOAD_FAILED|waiting for new credentials/i.test(allText)) {
        clearTimeout(_steamDlPollTimer);
        _steamDlPollTimer = null;
        if (lbl) { lbl.style.color = 'var(--accent-error,#ef4444)'; lbl.textContent = '❌ Download failed.'; }
        _wizShowStep3BackBtn('Download failed — go back to Step 2 and check your credentials.');
        return;
      }

      // Update progress bar from steamcmd download percentage.
      // Scan the current attempt's lines for the latest:
      //   "Update state (0x61) downloading, progress: 23.34"
      // and map that 0–100 value onto 5–90% of the bar (leaving room for
      // the preallocating/installing phases at either end).
      const attemptLines = log.lines.slice(attemptStart);
      let dlPct = null;
      for (let i = attemptLines.length - 1; i >= 0; i--) {
        const m = attemptLines[i].text.match(/downloading,\s*progress:\s*([\d.]+)/i);
        if (m) { dlPct = parseFloat(m[1]); break; }
      }
      if (dlPct !== null && bar) {
        const mapped = 5 + (dlPct / 100) * 85;
        bar.style.width = Math.min(Math.round(mapped), 90) + '%';
        if (lbl && dlPct > 0) {
          lbl.style.color = '';
          lbl.textContent = `Downloading Stardew Valley… ${Math.round(dlPct)}%`;
        }
      }

      // Stream new log lines (filtered to start from "Steam credentials detected")
      _wizStreamLogs(log.lines, logEl, cntEl);
    }
  } catch {}

  // Keep polling while on step 3
  if (_wizState.currentStep === 3) {
    _steamDlPollTimer = setTimeout(wizPollDownloadProgress, 4000);
  }
}

async function wizCheckGameFiles() {
  const statusEl   = document.getElementById('wiz-files-status');
  const choiceDiv  = document.getElementById('wiz-method-choice');
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Checking…';
  try {
    const data = await API.get('/api/wizard/status');
    if (data && data.gamePresent) {
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = '✅ Game files found!';
      _wizState._filesFound = true;
      if (choiceDiv) choiceDiv.style.display = 'none';
      document.getElementById('wiz-step2-next').disabled = false;
      if (!_wizState._method) _wizState._method = 'local';
    } else {
      statusEl.style.color = 'var(--accent-error)';
      statusEl.textContent = '❌ Game files not found. Choose a method below to provide them.';
      if (choiceDiv) choiceDiv.style.display = 'block';
    }
  } catch {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = 'Check failed — try again.';
    if (choiceDiv) choiceDiv.style.display = 'block';
  }
}

async function wizScanImportDir() {
  const dir      = document.getElementById('wiz-import-dir')?.value;
  const statusEl = document.getElementById('wiz-import-status');
  const resultsEl = document.getElementById('wiz-import-results');
  if (!dir) return;
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Scanning…';
  if (resultsEl) resultsEl.style.display = 'none';
  try {
    const data = await API.get(`/api/wizard/scan-saves?dir=${encodeURIComponent(dir)}`);
    if (data?.saves?.length) {
      statusEl.style.color = 'var(--accent)';
      statusEl.textContent = `Found ${data.saves.length} save(s).`;
      const sel = document.getElementById('wiz-import-save');
      sel.innerHTML = data.saves.map(s =>
        `<option value="${encodeURIComponent(s.path)}" data-name="${s.name}">${s.name}</option>`
      ).join('');
      if (resultsEl) resultsEl.style.display = 'block';
    } else {
      statusEl.style.color = 'var(--text-muted)';
      statusEl.textContent = 'No Stardew Valley saves found in that directory.';
    }
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Scan failed.';
  }
}

async function wizImportSave() {
  const sel      = document.getElementById('wiz-import-save');
  const statusEl = document.getElementById('wiz-import-status');
  if (!sel?.value) return;
  const savePath = decodeURIComponent(sel.value);
  const saveName = sel.options[sel.selectedIndex]?.dataset?.name;
  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = `Importing "${saveName}"…`;
  try {
    await API.post('/api/wizard/import-save', { savePath, saveName });
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = `✅ "${saveName}" imported — select it in the next step.`;
    document.getElementById('wiz-import-results').style.display = 'none';
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Import failed.';
  }
}

async function wizSubmitStep2() {
  const method = _wizState._method;
  if (!method) { showToast('Select a game file method first', 'error'); return; }
  try {
    await API.post('/api/wizard/step/2', { method });
    _wizState._gameMethod = method;
    // Local/path users skip the download progress screen (step 3) — go straight to resources
    wizGoToStep(4);
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

async function wizSubmitStep3(skip) {
  const cpu = skip ? '' : (document.getElementById('wiz-cpu').value.trim());
  const mem = skip ? '' : (document.getElementById('wiz-mem').value.trim());
  try {
    await API.post('/api/wizard/step/3', { cpuLimit: cpu, memoryLimit: mem });
    _wizState._cpu = cpu; _wizState._mem = mem;
    wizGoToStep(5);
    buildTzPicker('wiz-tz-picker', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

async function wizSubmitStep4(skip) {
  const pw = skip ? '' : (document.getElementById('wiz-srv-pw').value.trim());
  const tz = tzPickerValue('wiz-tz-picker');
  try {
    await API.post('/api/wizard/step/4', { serverPassword: pw, timezone: tz || undefined });
    _wizState._srvPw = pw;
    // Populate confirm lines for step 6
    const gm = _wizState._gameMethod;
    document.getElementById('wiz-confirm-game').textContent =
      `✅ Game files: ${gm === 'steam' ? 'Steam download configured' : 'Copied manually'}`;
    const cpu = _wizState._cpu, mem = _wizState._mem;
    document.getElementById('wiz-confirm-resources').textContent =
      cpu || mem ? `✅ Resources: CPU=${cpu||'unlimited'}, RAM=${mem||'unlimited'}` : '✅ Resources: no limits set';
    document.getElementById('wiz-confirm-server').textContent =
      pw ? '✅ Server password set' : '✅ Server: open (no password)';
    // Load farm step (step 6)
    wizGoToStep(6);
    wizLoadFarmStep();
  } catch (e) {
    showToast(e.message || 'Failed to save — try again', 'error');
  }
}

// ─── Farm Setup (Step 5) ─────────────────────────────────────────
function wizFarmTab(tab) {
  document.getElementById('wiz-farm-new').style.display      = tab === 'new'      ? '' : 'none';
  document.getElementById('wiz-farm-existing').style.display = tab === 'existing' ? '' : 'none';
  document.getElementById('farm-tab-new').classList.toggle('active',      tab === 'new');
  document.getElementById('farm-tab-existing').classList.toggle('active', tab === 'existing');
}

async function wizLoadFarmStep() {
  wizFarmTab('new');
  // Load existing saves for the existing-save tab
  try {
    const data = await API.get('/api/wizard/saves');
    const sel  = document.getElementById('wiz-existing-save');
    if (data?.saves?.length) {
      sel.innerHTML = data.saves.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">No saves found — upload via Saves tab first</option>';
    }
  } catch {}
}

function wizPetToggle() {
  const accept     = document.getElementById('wiz-accept-pet')?.value === 'true';
  const detailsEl  = document.getElementById('wiz-pet-detail');
  if (detailsEl) detailsEl.style.display = accept ? '' : 'none';
}

function wizPetBreedOptions() {
  const species  = document.getElementById('wiz-pet-species')?.value || 'cat';
  const breedSel = document.getElementById('wiz-pet-breed');
  if (!breedSel) return;
  const cats = ['Tabby (orange)', 'Black cat', 'Calico', 'Siamese', 'Grey'];
  const dogs = ['Corgi', 'Pitbull', 'Poodle', 'Shiba Inu', 'Dalmatian'];
  const breeds = species === 'dog' ? dogs : cats;
  const current = breedSel.value;
  breedSel.innerHTML = breeds.map((b, i) => `<option value="${i}">${b}</option>`).join('');
  // Preserve selection if valid
  const idx = parseInt(current, 10);
  if (!isNaN(idx) && idx < 5) breedSel.value = String(idx);
}

async function wizCreateNewFarm() {
  const statusEl = document.getElementById('wiz-farm-status');

  const val = id => document.getElementById(id)?.value ?? '';

  const farmName     = val('wiz-farm-name').trim()    || 'Stardrop Farm';
  const farmerName   = val('wiz-farmer-name').trim()  || 'Host';
  const favoriteThing= val('wiz-favorite-thing').trim()|| 'Farming';
  const farmType     = val('wiz-farm-type')   || '0';
  const cabinCount   = val('wiz-cabin-count') || '1';
  const cabinLayout  = val('wiz-cabin-layout')|| 'separate';
  const moneyStyle   = val('wiz-money-style') || 'shared';
  const profitMargin = val('wiz-profit-margin')|| 'normal';
  const moveBuild    = val('wiz-move-build')  || 'off';
  const ccBundles    = val('wiz-cc-bundles')  || 'normal';
  const mineRewards  = val('wiz-mine-rewards')|| 'normal';
  const monsters     = val('wiz-monsters')    || 'false';
  const year1        = val('wiz-year1')       || 'false';
  const randomSeed   = val('wiz-random-seed').trim();
  const acceptPet    = val('wiz-accept-pet')  || 'true';
  const petSpecies   = val('wiz-pet-species') || 'cat';
  const petBreed     = val('wiz-pet-breed')   || '0';
  const petName      = val('wiz-pet-name').trim() || 'Stella';
  const cave         = val('wiz-cave')        || 'mushrooms';
  const joja         = val('wiz-joja')        || 'false';

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Saving farm configuration…';
  try {
    await API.post('/api/wizard/new-farm', {
      farmName, farmerName, favoriteThing,
      farmType, cabinCount, cabinLayout,
      moneyStyle, profitMargin, moveBuildPermission: moveBuild,
      communityCenterBundles: ccBundles, mineRewards,
      spawnMonstersAtNight: monsters === 'true',
      guaranteeYear1Completable: year1 === 'true',
      randomSeed: randomSeed !== '' ? randomSeed : null,
      acceptPet: acceptPet === 'true',
      petSpecies, petBreed: parseInt(petBreed, 10) || 0, petName,
      mushroomsOrBats: cave,
      purchaseJojaMembership: joja === 'true',
    });
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = '✅ Farm config saved';
    _wizState._farmMode = 'new';
    _wizState._farmName = farmName;
    const typeNames = ['Standard','Riverland','Forest','Hill-top','Wilderness','Four Corners','Beach'];
    document.getElementById('wiz-confirm-save').textContent =
      `✅ New farm: "${farmName}" (${typeNames[parseInt(farmType,10)] || 'Standard'})`;
    setTimeout(() => wizLaunchServer(), 800);
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to save farm config.';
  }
}

async function wizSelectExistingSave() {
  const statusEl = document.getElementById('wiz-existing-status');
  const saveName = document.getElementById('wiz-existing-save')?.value?.trim();
  if (!saveName) { statusEl.textContent = 'No save selected.'; return; }

  statusEl.style.color = 'var(--text-secondary)';
  statusEl.textContent = 'Selecting save…';
  try {
    await API.post('/api/wizard/select-save', { saveName });
    statusEl.style.color = 'var(--accent)';
    statusEl.textContent = `✅ Will load: ${saveName}`;
    _wizState._farmMode = 'existing';
    _wizState._farmName = saveName;
    document.getElementById('wiz-confirm-save').textContent = `✅ Load save: ${saveName}`;
    setTimeout(() => wizLaunchServer(), 800);
  } catch (e) {
    statusEl.style.color = 'var(--accent-error)';
    statusEl.textContent = e.message || 'Failed to select save.';
  }
}

let _gameReadyTimer = null;
let _setupLogTimer  = null;
let _setupLogLines  = 0;
let _smapiLogTimer  = null;
let _smapiLogLines  = 0;
let _smapiLogActive = false;

async function wizLaunchServer() {
  wizGoToStep(7);
  _smapiLogLines  = 0;
  _smapiLogActive = false;
  try { await API.post('/api/wizard/step/5', {}); } catch {}
  wizPollGameReady(0);
  wizPollSetupLog();
}

async function wizPollSetupLog() {
  const box   = document.getElementById('wiz-setup-log');
  const count = document.getElementById('wiz-log-count');
  if (!box) return;

  try {
    const data = await fetch('/api/logs/setup?lines=120').then(r => r.json());
    if (data?.lines?.length && data.lines.length !== _setupLogLines) {
      _setupLogLines = data.lines.length;
      const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.innerHTML = data.lines.map(l => {
        const cls = l.level === 'error' ? 'color:#ef4444'
                  : l.level === 'warn'  ? 'color:#f59e0b'
                  : l.text.includes('[STEP]') ? 'color:var(--accent);font-weight:600'
                  : '';
        return `<div style="${cls}">${escapeHtml(l.text)}</div>`;
      }).join('');
      if (count) count.textContent = `${data.lines.length} lines`;
      if (atBottom) box.scrollTop = box.scrollHeight;
    }
  } catch {}

  // Keep polling while wizard overlay is visible
  if (document.getElementById('wizard-overlay')?.style.display !== 'none') {
    _setupLogTimer = setTimeout(wizPollSetupLog, 3000);
  }
}

async function wizPollSmapiLog() {
  const section = document.getElementById('wiz-smapi-log-section');
  const box     = document.getElementById('wiz-smapi-log');
  const count   = document.getElementById('wiz-smapi-log-count');
  if (!box) return;

  try {
    const data = await fetch('/api/wizard/smapi-log?lines=150').then(r => r.json());
    if (data?.exists && data.lines?.length) {
      if (section) section.style.display = '';
      if (data.lines.length !== _smapiLogLines) {
        _smapiLogLines = data.lines.length;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.innerHTML = data.lines.map(l => {
          const cls = l.level === 'error' ? 'color:#ef4444'
                    : l.level === 'warn'  ? 'color:#f59e0b'
                    : l.level === 'trace' ? 'color:var(--text-muted);opacity:0.7'
                    : l.text.includes('[FarmAutoCreate]') || l.text.includes('[StardropGameManager]')
                      ? 'color:var(--accent);font-weight:600'
                    : '';
          return `<div style="${cls}">${escapeHtml(l.text)}</div>`;
        }).join('');
        if (count) count.textContent = `${data.lines.length} lines`;
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    }
  } catch {}

  if (document.getElementById('wizard-overlay')?.style.display !== 'none') {
    _smapiLogTimer = setTimeout(wizPollSmapiLog, 3000);
  }
}

const _STAGE_PCT = { waiting: 5, no_game_files: 8, downloading: 20, installing: 45, starting: 60, loading: 70, running: 80, hosting: 92, ready: 100 };
const _STAGE_TXT = {
  waiting:       'Waiting for server to start…',
  no_game_files: '⚠️ Game files not found — go back to step 2 to provide them',
  downloading:   'Downloading game files via Steam… (may take 5–15 min)',
  installing:    'Installing SMAPI and building mods… (first run only, may take a few minutes)',
  starting:      'Starting game server…',
  loading:       'Game is loading…',
  running:       'Creating your farm automatically…',
  hosting:       'Farm loaded, enabling multiplayer hosting…',
  ready:         '✅ Server is live — players can join!',
};

function wizPollGameReady(prevPct) {
  const bar = document.getElementById('wiz-launch-bar');
  const lbl = document.getElementById('wiz-launch-status');
  const btn = document.getElementById('wiz-complete-btn');

  _gameReadyTimer = setTimeout(async () => {
    try {
      const data = await API.get('/api/wizard/game-ready');
      const stage = data?.stage || 'waiting';
      const pct   = Math.max(prevPct, _STAGE_PCT[stage] || prevPct);

      if (bar) bar.style.width = pct + '%';
      if (lbl) {
        lbl.textContent  = _STAGE_TXT[stage] || lbl.textContent;
        lbl.style.color  = stage === 'ready' ? 'var(--accent)' : '';
      }

      // Start SMAPI log polling as soon as the game process is running
      if (!_smapiLogActive && data?.gameRunning) {
        _smapiLogActive = true;
        wizPollSmapiLog();
      }

      if (data?.ready) {
        if (bar) bar.style.width = '100%';
        if (lbl) { lbl.style.color = 'var(--accent)'; lbl.textContent = _STAGE_TXT.ready; }
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = 'Go to Dashboard'; }
      } else if (data?.stage === 'no_game_files') {
        // Game files never arrived — send user back to step 2
        if (lbl) { lbl.style.color = 'var(--accent-error, #ef4444)'; lbl.textContent = _STAGE_TXT.no_game_files; }
        if (btn) {
          btn.disabled = false; btn.style.opacity = '1';
          btn.textContent = '← Back to Game Files';
          btn.className = 'btn btn-warning';
          btn.onclick = () => wizGoToStep(2);
        }
        wizPollGameReady(pct); // keep polling — container will retry once creds re-appear
      } else {
        wizPollGameReady(pct);
      }
    } catch {
      wizPollGameReady(prevPct);
    }
  }, 5000);
}

async function wizComplete() {
  if (_gameReadyTimer) { clearTimeout(_gameReadyTimer); _gameReadyTimer = null; }

  // Mark wizard complete in backend state regardless of step-check results
  try { await API.post('/api/wizard/force-complete'); } catch {}

  // For existing-save path: save is already on disk — auto-select if needed.
  // For new-farm path: save won't exist until Day 1 ends; don't block here.
  if (_wizState._farmMode === 'existing') {
    try {
      const savesData = await API.get('/api/saves');
      if (savesData?.saves?.length && !savesData.selectedSave) {
        await API.post('/api/saves/select', { saveName: savesData.saves[0].name });
      }
    } catch {}
  }

  document.getElementById('wizard-overlay').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  init();
  showToast('Setup complete! Server is running.', 'success');
}

// ─── Global State ────────────────────────────────────────────────
let ws                     = null;
let currentPage            = 'dashboard';
let logAutoScroll          = true;
let statusInterval         = null;
let lastStatusData         = null;
let backupStatusPoll       = null;
let lastBackupStatus       = null;
let containerReconnectPoll = null;
let steamPollInterval      = null;

// ─── Theme ───────────────────────────────────────────────────────
let currentTheme = (() => {
  const saved = localStorage.getItem('panel_theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
})();

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme;
  const use = document.querySelector('#themeToggle use');
  if (use) use.setAttribute('href', currentTheme === 'dark' ? '#icon-theme-light' : '#icon-theme-dark');
}

// ─── Helpers ─────────────────────────────────────────────────────
function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className   = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ─── Init ────────────────────────────────────────────────────────
function init() {
  applyTheme();
  setupNavigation();
  setupWebSocket();
  loadDashboard();
  loadBackupStatus();

  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('panel_token');
    window.location.href = '/login.html';
  };

  document.getElementById('themeToggle').onclick = () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('panel_theme', currentTheme);
    applyTheme();
  };

  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
  };

  // Log controls
  document.getElementById('logAutoScroll').onclick = () => {
    logAutoScroll = !logAutoScroll;
    document.getElementById('logAutoScroll').style.opacity = logAutoScroll ? '1' : '0.5';
  };

  document.getElementById('logClear').onclick = () => {
    document.getElementById('logOutput').innerHTML = '';
  };

  document.querySelectorAll('.log-filter').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadLogs(btn.dataset.filter);
      subscribeToLogs(btn.dataset.filter);
    };
  });

  let searchTimeout;
  document.getElementById('logSearch').oninput = e => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const filter = document.querySelector('.log-filter.active')?.dataset.filter || 'all';
      loadLogs(filter, e.target.value);
    }, 300);
  };

  statusInterval = setInterval(loadDashboard, 10000);
}

// ─── Navigation ──────────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard: 'Dashboard', farm: 'Farm', players: 'Players',
  saves: 'Saves', mods: 'Mods', terminal: 'Console', logs: 'Logs', invite: 'Steam Invite Codes', config: 'Config',
};

function setupNavigation() {
  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(item => {
    item.onclick = () => navigateTo(item.dataset.page);
  });
}

function navigateTo(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item, .mob-nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll(`.nav-item[data-page="${page}"], .mob-nav-item[data-page="${page}"]`)
    .forEach(i => i.classList.add('active'));

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  setText('pageTitle', PAGE_TITLES[page] || page);
  document.getElementById('sidebar').classList.remove('open');

  // Stop Steam polling when leaving invite/config
  if (page !== 'config' && page !== 'invite') stopSteamPolling();

  switch (page) {
    case 'dashboard': loadDashboard();                         break;
    case 'farm':      loadFarm();                              break;
    case 'players':   loadPlayers();                           break;
    case 'saves':     loadSaves();                             break;
    case 'mods':      loadMods();                              break;
    case 'logs':      loadLogs('all'); subscribeToLogs('all'); break;
    case 'invite':    loadSteam();                             break;
    case 'config':    loadConfig(); loadVnc();                 break;
  }
}

// ─── WebSocket ───────────────────────────────────────────────────
function setupWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(API.getWsUrl());

  ws.onopen    = ()  => console.log('[WS] Connected');
  ws.onclose   = ()  => { console.log('[WS] Disconnected, reconnecting in 5s...'); setTimeout(setupWebSocket, 5000); };
  ws.onerror   = ()  => {};
  ws.onmessage = (e) => {
    try { handleWsMessage(JSON.parse(e.data)); }
    catch (err) { console.error('[WS] Parse error:', err); }
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'status':           updateDashboardUI(msg.data);      break;
    case 'log':              appendLogLine(msg.line);          break;
    case 'terminal:output':  appendTerminalOutput(msg.data);   break;
    case 'terminal:opened':
      appendTerminalOutput(msg.data);
      document.getElementById('termInput').disabled    = false;
      document.getElementById('termSendBtn').disabled  = false;
      document.getElementById('termConnect').style.display    = 'none';
      document.getElementById('termDisconnect').style.display = '';
      break;
    case 'terminal:closed':
    case 'terminal:error':
      appendTerminalOutput(msg.type === 'terminal:error' ? `[Error] ${msg.data}\r\n` : msg.data);
      document.getElementById('termInput').disabled    = true;
      document.getElementById('termSendBtn').disabled  = true;
      document.getElementById('termConnect').style.display    = '';
      document.getElementById('termDisconnect').style.display = 'none';
      break;
  }
}

// ─── Dashboard ───────────────────────────────────────────────────
async function loadDashboard() {
  const data = await API.get('/api/status');
  if (data) updateDashboardUI(data);
}

function updateDashboardUI(data) {
  lastStatusData = data;

  const running     = !!data.gameRunning;
  const statusText  = running ? 'Running' : 'Stopped';
  const statusClass = running ? 'online'  : 'offline';

  setText('stat-status', statusText);
  document.getElementById('stat-status-icon').innerHTML =
    `<span class="status-orb ${statusClass}"></span>`;
  document.getElementById('serverStatus').className = `status-badge ${statusClass}`;
  document.getElementById('serverStatus').innerHTML =
    `<span class="status-dot ${statusClass}"></span><span id="serverStatusText">${statusText}</span>`;

  setText('stat-players', `${data.players?.online ?? 0}/4`);
  setText('stat-uptime',  formatUptime(data.uptime || 0));
  setText('stat-day',     data.paused ? 'Paused' : (data.day || '--'));
  setText('stat-backups', data.backupCount ?? 0);
  setText('stat-mods',    data.modCount    ?? 0);

  // CPU
  const cpu = Math.round(data.cpu || 0);
  setText('cpu-value', `${cpu}%`);
  const cpuBar = document.getElementById('cpu-bar');
  cpuBar.style.width  = Math.min(cpu, 100) + '%';
  cpuBar.className    = 'progress-fill' + (cpu > 80 ? ' danger' : cpu > 60 ? ' warn' : '');

  // RAM
  const memUsedMB  = Math.round(data.memory?.used  || 0);
  const memLimitMB = data.memory?.limit || 2048;
  const memPct     = Math.round((memUsedMB / memLimitMB) * 100);
  setText('ram-value', `${memUsedMB} / ${memLimitMB} MB`);
  const ramBar   = document.getElementById('ram-bar');
  ramBar.style.width = Math.min(memPct, 100) + '%';
  ramBar.className   = 'progress-fill' + (memPct > 80 ? ' danger' : memPct > 60 ? ' warn' : '');

  // Details
  const net = data.network || {};
  setText('detail-join-ip',   net.joinIp || '--');
  setText('detail-local-ips', net.localIps?.[0] || '--');
  setText('detail-vnc',       data.vncEnabled ? `Enabled — port ${net.vncPort || 5900}` : 'Disabled');

  // If Steam is online and has an invite code, show it as the join IP
  if (data.live?.inviteCode) {
    setText('detail-join-ip', data.live.inviteCode);
  }
}

// ─── Farm ────────────────────────────────────────────────────────
async function loadFarm() {
  const data = await API.get('/api/farm/overview');
  if (!data) return;

  const liveEl = document.getElementById('farmLiveData');
  const ccEl   = document.getElementById('farmCCData');
  const infoEl = document.getElementById('farmInfoData');

  if (!data.available) {
    const msg = `<div class="empty-state">${escapeHtml(data.message || 'No farm data available')}</div>`;
    liveEl.innerHTML = msg; ccEl.innerHTML = msg; infoEl.innerHTML = msg;
    return;
  }

  // Live status
  const players = data.players?.length
    ? data.players.map(p => `<div class="player-card">
        <div class="player-avatar">${icon('players', 'icon')}</div>
        <div>
          <div class="player-name">${escapeHtml(p.name)}</div>
          ${p.location ? `<div class="player-info">${escapeHtml(p.location)}</div>` : ''}
          ${p.health != null ? `<div class="player-info">HP ${p.health}/${p.maxHealth} · ⚡ ${p.stamina ?? '--'}</div>` : ''}
        </div>
      </div>`).join('')
    : '<div class="empty-state">No players online</div>';

  liveEl.innerHTML = `
    <div class="details-grid">
      <div class="detail-item">
        <div class="detail-label">Date</div>
        <div class="detail-value">${escapeHtml(data.season || '--')} ${data.day ?? '--'}, Year ${data.year ?? '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Time</div>
        <div class="detail-value">${data.timeOfDay != null ? formatGameTime(data.timeOfDay) : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Weather</div>
        <div class="detail-value">${escapeHtml(data.weather || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Server</div>
        <div class="detail-value">${escapeHtml(data.serverState || '--')}</div>
      </div>
    </div>
    <div style="margin-top:12px">${players}</div>
    ${!data.liveDataAvailable ? '<div style="margin-top:8px;color:var(--text-muted);font-size:13px">Live data unavailable — ServerDashboard mod not installed (Phase 6)</div>' : ''}
  `;

  // Community Center
  if (data.communityCenter) {
    const cc = data.communityCenter;
    const roomsHtml = Object.entries(cc.rooms).map(([room, info]) =>
      `<div class="detail-item">
        <div class="detail-label">${escapeHtml(room)}</div>
        <div class="detail-value" style="color:${info.complete ? 'var(--accent)' : 'var(--text-secondary)'}">
          ${info.complete ? '✅ Complete' : `${info.bundles.filter(b => b.complete).length}/${info.bundles.length} bundles`}
        </div>
      </div>`
    ).join('');

    ccEl.innerHTML = `
      <div style="margin-bottom:12px">
        <strong>${cc.completedRooms}/${cc.totalRooms} rooms complete</strong>
        <div class="progress-bar" style="margin-top:6px">
          <div class="progress-fill" style="width:${cc.percentComplete}%;${cc.percentComplete === 100 ? 'background:var(--accent)' : ''}"></div>
        </div>
      </div>
      <div class="details-grid">${roomsHtml}</div>
    `;
  } else {
    ccEl.innerHTML = '<div class="empty-state">Community Center data not available</div>';
  }

  // Farm info
  infoEl.innerHTML = `
    <div class="details-grid">
      <div class="detail-item">
        <div class="detail-label">Farm Name</div>
        <div class="detail-value">${escapeHtml(data.farmName || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Farmer</div>
        <div class="detail-value">${escapeHtml(data.playerName || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Farm Type</div>
        <div class="detail-value">${escapeHtml(data.farmType || '--')}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Money</div>
        <div class="detail-value">${data.money != null ? `${data.money.toLocaleString()}g` : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Total Earned</div>
        <div class="detail-value">${data.totalEarned != null ? `${data.totalEarned.toLocaleString()}g` : '--'}</div>
      </div>
      <div class="detail-item">
        <div class="detail-label">Playtime</div>
        <div class="detail-value">${data.playtimeHours != null ? `${data.playtimeHours}h` : '--'}</div>
      </div>
    </div>
  `;
}

function formatGameTime(t) {
  const h      = Math.floor(t / 100);
  const m      = t % 100;
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12    = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

// ─── Logs ────────────────────────────────────────────────────────
async function loadLogs(filter, search) {
  const params = new URLSearchParams({ type: filter || 'all', lines: 300 });
  if (search) params.set('search', search);

  const data = await API.get(`/api/logs?${params}`);
  if (!data) return;

  const output = document.getElementById('logOutput');
  output.innerHTML = '';

  if (!data.exists) {
    output.innerHTML = '<div class="log-line info">Log file not found yet — server may still be starting...</div>';
    return;
  }

  if (!data.lines.length) {
    output.innerHTML = '<div class="log-line info">No log entries yet — waiting for server activity...</div>';
    return;
  }

  for (const line of data.lines) appendLogLine(line);
}

function appendLogLine(line) {
  const output = document.getElementById('logOutput');
  const div    = document.createElement('div');
  div.className   = `log-line ${line.level || 'info'}`;
  div.textContent = line.text || line;
  output.appendChild(div);
  while (output.children.length > 2000) output.removeChild(output.firstChild);
  if (logAutoScroll) output.scrollTop = output.scrollHeight;
}

function subscribeToLogs(filter) {
  wsSend({ type: 'subscribe', channel: 'logs', filter });
}

// ─── Terminal ────────────────────────────────────────────────────
function terminalConnect()    { wsSend({ type: 'terminal:open' }); }
function terminalDisconnect() {
  wsSend({ type: 'terminal:close' });
  document.getElementById('termInput').disabled    = true;
  document.getElementById('termSendBtn').disabled  = true;
  document.getElementById('termConnect').style.display    = '';
  document.getElementById('termDisconnect').style.display = 'none';
}

function terminalSend() {
  const input = document.getElementById('termInput');
  const text  = input.value.trim();
  if (!text) return;
  wsSend({ type: 'terminal:input', data: text });
  input.value = '';
}

function appendTerminalOutput(text) {
  const output = document.getElementById('termOutput');
  output.querySelector('.terminal-hint')?.remove();
  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

// ─── Players ─────────────────────────────────────────────────────
async function loadPlayers() {
  const data = await API.get('/api/players');
  if (!data) return;

  const list = document.getElementById('playersList');
  setText('playerCount', `${data.online ?? 0} / 8`);

  if (!data.players?.length) {
    list.innerHTML = `<div class="empty-state">${icon('players', 'icon empty-icon')}<div>No players online</div></div>`;
    return;
  }

  list.innerHTML = data.players.map(p => `
    <div class="player-card">
      <div class="player-avatar">${icon('players', 'icon')}</div>
      <div class="player-body">
        <div class="player-name">${escapeHtml(p.name)}</div>
        ${p.location ? `<div class="player-info">${escapeHtml(p.location)}</div>` : ''}
      </div>
      <div class="player-actions">
        <button class="btn btn-sm" onclick="kickPlayer('${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Kick</button>
        <button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444" onclick="banPlayer('${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Ban</button>
        <button class="btn btn-sm" onclick="grantAdmin('${escapeHtml(p.id)}','${escapeHtml(p.name)}')">Admin</button>
      </div>
    </div>
  `).join('');
}

async function kickPlayer(id, name) {
  if (!confirm(`Kick ${name}?`)) return;
  const data = await API.post('/api/players/kick', { id, name });
  showToast(data?.success ? `Kicked ${name}` : (data?.error || 'Kick failed'), data?.success ? 'success' : 'error');
  if (data?.success) loadPlayers();
}

async function banPlayer(id, name) {
  if (!confirm(`Ban ${name}? They will be kicked immediately.`)) return;
  const data = await API.post('/api/players/ban', { id, name });
  showToast(data?.success ? `Banned ${name}` : (data?.error || 'Ban failed'), data?.success ? 'success' : 'error');
  if (data?.success) loadPlayers();
}

async function grantAdmin(id, name) {
  if (!confirm(`Grant admin to ${name}?`)) return;
  const data = await API.post('/api/players/admin', { id, name });
  showToast(data?.success ? `Admin granted to ${name}` : (data?.error || 'Failed'), data?.success ? 'success' : 'error');
}

// ─── Saves ───────────────────────────────────────────────────────
async function loadSaves() {
  const [savesData, backupsData] = await Promise.all([
    API.get('/api/saves'),
    API.get('/api/saves/backups'),
  ]);

  if (savesData) {
    const list = document.getElementById('savesList');
    if (!savesData.saves?.length) {
      list.innerHTML = '<div class="empty-state">No save files found</div>';
    } else {
      list.innerHTML = savesData.saves.map(s => `
        <div class="save-item">
          <div class="save-info">
            <div class="save-name">
              ${icon('sprout', 'icon save-name-icon')}
              <span>${escapeHtml(s.farmName || s.name)}</span>
              ${s.isSelected ? '<span class="save-badge">Active</span>' : ''}
            </div>
            <div class="save-meta">
              ${s.season ? `${escapeHtml(s.season)} ${s.day}, Year ${s.year} · ` : ''}
              ${formatSize(s.size)} · ${s.lastModified ? new Date(s.lastModified).toLocaleString() : 'unknown'}
            </div>
          </div>
          <div class="save-actions">
            ${!s.isSelected ? `<button class="btn btn-sm" data-save-name="${escapeHtml(s.name)}">Select</button>` : ''}
            ${!s.isSelected ? `<button class="btn btn-sm save-delete-btn" style="color:#ef4444;border-color:#ef4444"
              data-save-name="${escapeHtml(s.name)}" data-farm="${escapeHtml(s.farmName || s.name)}">
              ${icon('trash', 'icon')}</button>` : ''}
          </div>
        </div>
      `).join('');

      list.querySelectorAll('[data-save-name]').forEach(btn => {
        if (btn.classList.contains('save-delete-btn')) {
          btn.onclick = () => deleteSave(btn.dataset.saveName, btn.dataset.farm);
        } else {
          btn.onclick = () => selectSave(btn.dataset.saveName);
        }
      });
    }
  }

  if (backupsData) {
    const list = document.getElementById('backupsList');
    if (!backupsData.backups?.length) {
      list.innerHTML = '<div class="empty-state">No backups found</div>';
    } else {
      list.innerHTML = backupsData.backups.map(b => `
        <div class="backup-item">
          <div class="save-info">
            <div class="save-name">${icon('package', 'icon save-name-icon')}<span>${escapeHtml(b.filename)}</span></div>
            <div class="save-meta">${formatSize(b.size)} · ${new Date(b.date).toLocaleString()}</div>
          </div>
          <div style="display:flex;gap:6px">
            <a class="btn btn-sm btn-primary" href="/api/saves/backups/${encodeURIComponent(b.filename)}?token=${API.token}"
               download="${escapeHtml(b.filename)}">${icon('download', 'icon')}</a>
            <button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444"
               onclick="deleteBackup('${escapeHtml(b.filename)}')">${icon('trash', 'icon')}</button>
          </div>
        </div>
      `).join('');
    }
  }
}

async function handleSaveUpload(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip'))   { showToast('Only .zip files supported', 'error'); return; }
  if (file.size > 40 * 1024 * 1024) { showToast('File too large (max 40MB)', 'error'); return; }

  const setAsDefault = document.getElementById('saveUploadSetDefault').checked;
  setText('saveUploadStatus', 'Uploading...');

  try {
    const reader = new FileReader();
    reader.onload = async () => {
      const data = await API.post('/api/saves/upload', {
        filename:     file.name,
        data:         reader.result.split(',')[1],
        setAsDefault,
      });
      setText('saveUploadStatus', '');
      input.value = '';
      if (data?.success) {
        let msg = 'Save uploaded.';
        if (data.defaultApplied)  msg = 'Save uploaded and set as active.';
        if (data.defaultSkipped)  msg += ' Multiple saves found — active save unchanged.';
        if (data.overwriteBackup) msg += ` Pre-overwrite backup: ${data.overwriteBackup}.`;
        msg += ' Restart the container to apply.';
        showToast(msg, 'success');
        loadSaves();
      } else {
        showToast(data?.error || 'Upload failed', 'error');
      }
    };
    reader.readAsDataURL(file);
  } catch (e) {
    setText('saveUploadStatus', '');
    showToast('Upload failed', 'error');
  }
}

async function selectSave(saveName) {
  const data = await API.post('/api/saves/select', { saveName });
  if (data?.success) {
    showToast('Active save updated. Restart the container to apply.', 'success');
    loadSaves();
  } else {
    showToast(data?.error || 'Failed to select save', 'error');
  }
}

async function deleteSave(saveName, farmName) {
  const label = farmName || saveName;
  const wantBackup = confirm(`Back up "${label}" before deleting?`);
  if (wantBackup) {
    showToast('Creating backup...', 'info');
    await API.post('/api/saves/backups', {});
    // Wait briefly for backup to start
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!confirm(`Permanently delete save "${label}"? This cannot be undone.`)) return;
  const data = await API.del(`/api/saves/${encodeURIComponent(saveName)}`);
  if (data?.success) { showToast('Save deleted', 'success'); loadSaves(); }
  else showToast(data?.error || 'Delete failed', 'error');
}

async function deleteBackup(filename) {
  if (!confirm(`Delete backup ${filename}?`)) return;
  const data = await API.del(`/api/saves/backups/${encodeURIComponent(filename)}`);
  if (data?.success) { showToast('Backup deleted', 'success'); loadSaves(); }
  else showToast(data?.error || 'Delete failed', 'error');
}

// ─── Backup status polling ────────────────────────────────────────
async function loadBackupStatus(silent = false) {
  const data = await API.get('/api/saves/backups/status');
  if (data) applyBackupStatus(data, silent);
}

function applyBackupStatus(status, silent = false) {
  const prevState  = lastBackupStatus?.state;
  lastBackupStatus = status;
  renderBackupStatus(status);

  if (status?.state === 'running') { startBackupStatusPolling(); return; }

  stopBackupStatusPolling();

  if (!silent) {
    if (prevState === 'running' && status?.state === 'completed') showToast('Backup created!', 'success');
    if (prevState === 'running' && status?.state === 'failed')    showToast(status.error || 'Backup failed', 'error');
  }

  if (status?.state !== 'running') {
    loadDashboard();
    if (currentPage === 'saves') loadSaves();
  }
}

function renderBackupStatus(status) {
  const active = status?.state && status.state !== 'idle';
  ['dashboardBackupStatus', 'savesBackupStatus'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (!active) { el.style.display = 'none'; el.innerHTML = ''; return; }

    const tone  = status.state === 'failed' ? 'error' : status.state === 'completed' ? 'success' : 'running';
    const title = status.state === 'failed' ? 'Backup failed' : status.state === 'completed' ? 'Backup complete' : 'Backup in progress...';
    const progress = status.state === 'running'
      ? `<div class="backup-progress"><div class="backup-progress-fill" style="width:${Math.max(1, status.progress || 0)}%"></div></div>` : '';
    const meta = [];
    if (status.state === 'running' && status.totalEntries > 0)
      meta.push(`${status.processedEntries}/${status.totalEntries} · ${status.progress}%`);
    if (status.backupName) meta.push(status.backupName);
    if (status.state === 'completed' && status.size) meta.push(formatSize(status.size));

    el.className     = `backup-status ${tone}`;
    el.style.display = '';
    el.innerHTML     =
      `<div class="backup-status-title">${escapeHtml(title)}</div>${progress}` +
      (meta.length ? `<div class="backup-status-meta">${escapeHtml(meta.join(' · '))}</div>` : '') +
      (status.error ? `<div class="backup-status-error">${escapeHtml(status.error)}</div>` : '');
  });

  document.querySelectorAll('.backup-action-btn').forEach(btn => {
    btn.disabled = status?.state === 'running';
  });
}

function startBackupStatusPolling() {
  if (!backupStatusPoll)
    backupStatusPoll = setInterval(() => loadBackupStatus(true), 2000);
}

function stopBackupStatusPolling() {
  if (backupStatusPoll) { clearInterval(backupStatusPoll); backupStatusPoll = null; }
}

// ─── Config ──────────────────────────────────────────────────────
async function loadConfig() {
  const data = await API.get('/api/config');
  if (!data) return;

  const container = document.getElementById('configContainer');
  container.innerHTML = '';

  const deferredTzPickers = [];

  for (const group of data.groups) {
    // VNC & Display settings are rendered inside the VNC panel card below
    if (group.name === 'VNC & Display') continue;

    const card = document.createElement('div');
    card.className = 'card config-group';
    card.innerHTML = `<div class="config-group-title">${escapeHtml(group.name)}</div>`;

    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'config-item';

      let valueHtml;
      if (item.readonly) {
        valueHtml = `<span style="color:var(--text-muted)">${item.sensitive ? '••••••••' : escapeHtml(item.value || '--')}</span>`;
      } else if (item.type === 'boolean') {
        const checked = item.value === 'true' ? 'checked' : '';
        valueHtml = `<label class="toggle"><input type="checkbox" data-key="${item.key}" ${checked} onchange="configChanged()"><span class="toggle-slider"></span></label>`;
      } else if (item.options?.length) {
        const opts = item.options.map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lbl = typeof o === 'object' ? o.label : (o || 'Auto-detect');
          const sel = val === (item.value ?? '') ? ' selected' : '';
          return `<option value="${escapeHtml(val)}"${sel}>${escapeHtml(lbl)}</option>`;
        }).join('');
        valueHtml = `<select class="input" data-key="${item.key}" style="width:220px" onchange="configChanged()">${opts}</select>`;
      } else if (item.viewable) {
        valueHtml = `<div class="password-wrapper">
          <input type="password" class="input" data-key="${item.key}" value="${escapeHtml(item.value || '')}"
            placeholder="${escapeHtml(item.default || '')}"${item.maxLength ? ` maxlength="${item.maxLength}"` : ''}
            style="width:150px" oninput="configChanged()">
          <button type="button" class="password-toggle" onclick="togglePasswordVisibility(this)" title="Show password">
            ${icon('eye', 'icon')}</button></div>`;
      } else if (item.type === 'timezone') {
        valueHtml = `<div class="tz-picker" id="cfg-tz-${item.key}" style="width:260px"></div>`;
      } else if (item.sensitive) {
        valueHtml = `<input type="password" class="input" data-key="${item.key}" placeholder="••••••••" style="width:150px" onchange="configChanged()">`;
      } else {
        valueHtml = `<input type="${item.type === 'number' ? 'number' : 'text'}" class="input" data-key="${item.key}"
          value="${escapeHtml(item.value || '')}" placeholder="${escapeHtml(item.default || '')}"
          style="width:150px" oninput="configChanged()">`;
      }

      row.innerHTML =
        `<div>
          <div class="config-label">${escapeHtml(item.label)}</div>
          ${item.description ? `<div class="config-help">${escapeHtml(item.description)}</div>` : ''}
        </div>
        <div class="config-value">${valueHtml}</div>`;

      if (item.type === 'timezone') {
        // Defer buildTzPicker until after card is appended to container (getElementById needs DOM)
        deferredTzPickers.push({ id: `cfg-tz-${item.key}`, value: item.value || item.default || 'UTC', key: item.key });
      }

      card.appendChild(row);
    }

    container.appendChild(card);

    // Now card is in the DOM — build any deferred timezone pickers for this card
    for (const p of deferredTzPickers.splice(0)) {
      buildTzPicker(p.id, p.value);
      const hidden = document.getElementById(`${p.id}-val`);
      if (hidden) { hidden.dataset.key = p.key; hidden.addEventListener('change', configChanged); }
      const searchEl = document.getElementById(`${p.id}-search`);
      if (searchEl) searchEl.addEventListener('input', configChanged);
    }
  }

  const saveRow = document.createElement('div');
  saveRow.style.textAlign = 'right';
  saveRow.innerHTML = `<button class="btn btn-success" id="saveConfigBtn" onclick="saveConfig()" style="display:none">Save Changes</button>`;
  container.appendChild(saveRow);
}

function configChanged() {
  const btn = document.getElementById('saveConfigBtn');
  if (btn) btn.style.display = '';
}

function togglePasswordVisibility(btn) {
  const input = btn.parentElement.querySelector('input');
  const show  = input.type === 'password';
  input.type  = show ? 'text' : 'password';
  btn.innerHTML = icon(show ? 'eye-off' : 'eye', 'icon');
  btn.title     = show ? 'Hide password' : 'Show password';
}

async function saveConfig() {
  const updates = {};
  document.querySelectorAll('[data-key]').forEach(el => {
    updates[el.dataset.key] = el.type === 'checkbox' ? String(el.checked) : el.value;
  });
  if (!Object.keys(updates).length) return;

  const data = await API.put('/api/config', updates);
  if (data?.success) {
    document.getElementById('saveConfigBtn').style.display = 'none';
    showRestartModal('Configuration saved. Restart the container to apply changes.');
  } else {
    showToast(data?.error || 'Failed to save config', 'error');
  }
}

// ─── VNC ─────────────────────────────────────────────────────────
async function loadVnc() {
  const [vnc, cfg] = await Promise.all([
    API.get('/api/vnc/status'),
    API.get('/api/config'),
  ]);
  const panel = document.getElementById('vncPanel');
  if (!panel) return;

  const vncGroup = cfg?.groups?.find(g => g.name === 'VNC & Display');

  // Build config rows for VNC & Display settings
  let cfgRows = '';
  if (vncGroup) {
    for (const item of vncGroup.items) {
      let ctrl = '';
      if (item.type === 'boolean') {
        const chk = item.value === 'true' ? 'checked' : '';
        ctrl = `<label class="toggle"><input type="checkbox" data-key="${item.key}" ${chk} onchange="configChanged()"><span class="toggle-slider"></span></label>`;
      } else if (item.options?.length) {
        const opts = item.options.map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lbl = typeof o === 'object' ? o.label : o;
          return `<option value="${escapeHtml(val)}"${val === (item.value ?? '') ? ' selected' : ''}>${escapeHtml(lbl)}</option>`;
        }).join('');
        ctrl = `<select class="input" data-key="${item.key}" style="width:180px" onchange="configChanged()">${opts}</select>`;
      } else if (item.viewable) {
        ctrl = `<div class="password-wrapper">
          <input type="password" class="input" data-key="${item.key}" value="${escapeHtml(item.value || '')}"
            placeholder="${escapeHtml(item.default || '')}"${item.maxLength ? ` maxlength="${item.maxLength}"` : ''}
            style="width:150px" oninput="configChanged()">
          <button type="button" class="password-toggle" onclick="togglePasswordVisibility(this)" title="Show password">
            ${icon('eye','icon')}</button></div>`;
      } else {
        ctrl = `<input type="${item.type === 'number' ? 'number' : 'text'}" class="input" data-key="${item.key}"
          value="${escapeHtml(item.value || '')}" placeholder="${escapeHtml(item.default || '')}"
          style="width:150px" oninput="configChanged()">`;
      }
      cfgRows += `<div class="config-item">
        <div>
          <div class="config-label">${escapeHtml(item.label)}</div>
          ${item.description ? `<div class="config-help">${escapeHtml(item.description)}</div>` : ''}
        </div>
        <div class="config-value">${ctrl}</div>
      </div>`;
    }
  }

  panel.innerHTML = `
    <div class="details-grid" style="margin-bottom:12px">
      <div class="detail-item">
        <div class="detail-label">Connection Status</div>
        <div class="detail-value" style="color:${vnc?.running ? 'var(--accent)' : 'var(--text-muted)'}">
          ${vnc?.running ? '● Running' : '○ Stopped'}
        </div>
      </div>
      <div class="detail-item">
        <div class="detail-label">VNC Port</div>
        <div class="detail-value">${vnc?.port || 5900}/TCP</div>
      </div>
    </div>
    <div class="action-buttons" style="margin-bottom:16px">
      ${vnc?.running
        ? `<button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444" onclick="vncDisable()">Stop VNC</button>`
        : `<button class="btn btn-sm btn-success" onclick="vncEnable()">Start VNC Now</button>`}
    </div>
    <div class="config-group" style="margin-top:8px">${cfgRows}</div>
    <div style="text-align:right;margin-top:10px">
      <button class="btn btn-success btn-sm" id="saveConfigBtn" onclick="saveConfig()" style="display:none">Save Changes</button>
    </div>
  `;
}

function showVncPasswordForm() {
  document.getElementById('vncPasswordForm').style.display = '';
}

async function vncEnable() {
  const data = await API.post('/api/vnc/enable');
  if (data?.success) { showToast('VNC enabled', 'success'); loadVnc(); }
  else showToast(data?.error || 'Failed to enable VNC', 'error');
}

async function vncDisable() {
  if (!confirm('Disable VNC? Active connections will be dropped.')) return;
  const data = await API.post('/api/vnc/disable');
  if (data?.success) { showToast('VNC disabled', 'success'); loadVnc(); }
  else showToast(data?.error || 'Failed to disable VNC', 'error');
}

async function setVncOneTimePassword() {
  const password = document.getElementById('vncOtpInput').value;
  if (!password) return;
  const data = await API.post('/api/vnc/password', { password });
  if (data?.success) {
    showToast('One-time VNC password set', 'success');
    document.getElementById('vncPasswordForm').style.display = 'none';
    loadVnc();
  } else {
    showToast(data?.error || 'Failed to set password', 'error');
  }
}

// ─── Steam Auth ───────────────────────────────────────────────────
function startSteamPolling() {
  if (steamPollInterval) return;
  steamPollInterval = setInterval(async () => {
    const data = await API.get('/api/steam/status');
    if (!data) return;
    renderSteamPanel(data);
    // Stop polling once settled: offline/error, or online with invite code in hand
    if (data.state === 'offline' || data.state === 'unavailable' || data.state === 'error' ||
        (data.state === 'online' && data.inviteCode)) {
      stopSteamPolling();
    }
  }, 4000);
}

function stopSteamPolling() {
  if (steamPollInterval) { clearInterval(steamPollInterval); steamPollInterval = null; }
}

async function loadSteam() {
  let data = await API.get('/api/steam/status');

  // If already online but no invite code, force a refresh from the SMAPI log now
  if (data?.state === 'online' && !data?.inviteCode) {
    const refreshed = await API.get('/api/steam/invitecode').catch(() => null);
    if (refreshed?.inviteCode) data = { ...data, inviteCode: refreshed.inviteCode };
  }

  renderSteamPanel(data);

  // Auto-poll if mid-login, waiting for Guard, or online but code not yet available
  if (data?.state === 'logging_in' || data?.state === 'guard_required' ||
      (data?.state === 'online' && !data?.inviteCode)) {
    startSteamPolling();
  }
}

function renderSteamPanel(data) {
  const panel = document.getElementById('steamPanel');
  if (!panel) return;

  // Container not running — it's optional
  if (!data || data.state === 'unavailable') {
    panel.innerHTML = `
      <div style="color:var(--text-muted);font-size:13px;line-height:1.5">
        Steam auth service is not running.<br>
        It starts automatically when you launch the server.<br>
        <span style="color:var(--text-secondary)">LAN play works without it — Steam is only needed for invite codes.</span>
      </div>`;
    return;
  }

  if (data.state === 'online') {
    panel.innerHTML = `
      <div class="details-grid" style="margin-bottom:12px">
        <div class="detail-item">
          <div class="detail-label">Status</div>
          <div class="detail-value" style="color:var(--accent)">● Connected</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Invite Code</div>
          <div class="detail-value" style="font-size:14px;font-family:monospace">
            ${escapeHtml(data.inviteCode || 'Waiting for server...')}
          </div>
          ${data.inviteCode ? `<div class="detail-note">Players paste this in Stardew Valley → Co-op → Enter Invite Code</div>` : ''}
        </div>
      </div>
      <div class="action-buttons">
        <button class="btn btn-sm btn-primary" onclick="refreshInviteCode()">
          ${icon('refresh', 'icon')} Refresh Code
        </button>
        <button class="btn btn-sm" style="color:#ef4444;border-color:#ef4444" onclick="steamLogout()">
          Sign Out
        </button>
      </div>`;
    return;
  }

  if (data.state === 'guard_required') {
    // If input already exists, only update the error message — don't wipe what user typed
    if (document.getElementById('steamGuardInput')) {
      const errEl = panel.querySelector('.steam-guard-error');
      if (errEl) errEl.textContent = data.lastError || '';
      startSteamPolling();
      return;
    }
    panel.innerHTML = `
      <div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary)">
        Steam Guard code required. Check your email or mobile authenticator app.
        <div class="steam-guard-error" style="color:var(--accent-error);margin-top:4px">${escapeHtml(data.lastError || '')}</div>
      </div>
      <div class="form-row">
        <input type="text" id="steamGuardInput" class="input" placeholder="Enter Steam Guard code"
               maxlength="10" style="width:180px" onkeydown="if(event.key==='Enter') submitSteamGuard()">
        <button class="btn btn-primary btn-sm" onclick="submitSteamGuard()">Submit</button>
        <button class="btn btn-sm" onclick="steamCancelLogin()">Cancel</button>
      </div>`;
    startSteamPolling();
    return;
  }

  if (data.state === 'logging_in') {
    panel.innerHTML = `
      <div style="color:var(--accent-info);font-size:13px">
        ${icon('loader', 'icon icon-spin')} Logging in to Steam...
      </div>`;
    startSteamPolling();
    return;
  }

  // offline / error — show login form
  panel.innerHTML = `
    <div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);line-height:1.5">
      Sign in to generate Steam invite codes so players can join without port forwarding.
      ${data.lastError ? `<div style="color:var(--accent-error);margin-top:4px">${escapeHtml(data.lastError)}</div>` : ''}
      ${data.hasToken ? `<div style="color:var(--accent-warn);margin-top:4px">⚠️ Previous session expired — please sign in again.</div>` : ''}
    </div>
    <div class="form-row">
      <input type="text"     id="steamUsername" class="input" placeholder="Steam username" style="width:160px"
             onkeydown="if(event.key==='Enter') steamLogin()">
      <input type="password" id="steamPassword" class="input" placeholder="Steam password" style="width:160px"
             onkeydown="if(event.key==='Enter') steamLogin()">
      <button class="btn btn-success btn-sm" onclick="steamLogin()">Sign In</button>
    </div>
    <div style="margin-top:8px;color:var(--text-muted);font-size:12px">
      Credentials pass directly to the steam-auth container and are never stored by the web panel.
    </div>`;
}

async function steamLogin() {
  const username = document.getElementById('steamUsername')?.value?.trim();
  const password = document.getElementById('steamPassword')?.value;

  if (!username || !password) {
    showToast('Enter your Steam username and password', 'error');
    return;
  }

  const data = await API.post('/api/steam/login', { username, password });
  if (data?.success) {
    showToast('Logging in...', 'success');
    startSteamPolling();
    // Immediately show the logging_in state
    renderSteamPanel({ state: 'logging_in' });
  } else {
    showToast(data?.error || 'Login failed', 'error');
  }
}

async function submitSteamGuard() {
  const code = document.getElementById('steamGuardInput')?.value?.trim();
  if (!code) { showToast('Enter your Steam Guard code', 'error'); return; }

  const data = await API.post('/api/steam/guard', { code });
  if (data?.success) {
    showToast('Code submitted — logging in...', 'success');
    renderSteamPanel({ state: 'logging_in' });
    startSteamPolling();
  } else {
    showToast(data?.error || 'Failed to submit code', 'error');
  }
}

async function steamCancelLogin() {
  await API.post('/api/steam/logout');
  stopSteamPolling();
  loadSteam();
}

async function steamLogout() {
  if (!confirm('Sign out of Steam? Invite codes will stop working until you sign in again.')) return;
  const data = await API.post('/api/steam/logout');
  if (data?.success) {
    showToast('Signed out of Steam', 'success');
    stopSteamPolling();
    loadSteam();
  } else {
    showToast(data?.error || 'Sign out failed', 'error');
  }
}

async function refreshInviteCode() {
  const data = await API.get('/api/steam/invitecode');
  if (data?.inviteCode) {
    showToast('Invite code refreshed', 'success');
    loadSteam();
  } else {
    showToast('No invite code available yet — is the server running?', 'warn');
  }
}

// ─── Mods ────────────────────────────────────────────────────────
async function loadMods() {
  const data = await API.get('/api/mods');
  if (!data) return;

  const badge = document.getElementById('smapi-version-badge');
  if (badge) badge.textContent = data.smapiVersion ? `SMAPI v${data.smapiVersion}` : '';

  const list = document.getElementById('modsList');
  setText('modUploadStatus', '');

  if (!data.mods?.length) {
    list.innerHTML = '<div class="empty-state">No mods found</div>';
    return;
  }

  list.innerHTML = data.mods.map(m => `
    <div class="mod-item">
      <div class="mod-info">
        <div class="mod-name">${escapeHtml(m.name)}</div>
        <div class="mod-meta">v${escapeHtml(m.version)} · ${escapeHtml(m.author || '')} · ${escapeHtml(m.id)}</div>
        ${m.description ? `<div class="mod-meta">${escapeHtml(m.description)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        ${m.pendingInstall
          ? '<span class="mod-badge" style="background:#f59e0b22;color:#f59e0b;border-color:#f59e0b55">Pending Install</span>'
          : `<span class="mod-badge ${m.isCustom ? 'custom' : ''}">${m.isCustom ? 'Custom' : 'Bundled'}</span>`}
        ${m.isCustom
          ? `<button class="btn btn-sm mod-delete-btn" style="color:#ef4444;border-color:#ef4444"
               data-folder="${escapeHtml(m.folder)}" data-name="${escapeHtml(m.name)}">
               ${icon('trash', 'icon')} Delete</button>`
          : ''}
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.mod-delete-btn').forEach(btn => {
    btn.onclick = () => deleteMod(btn.dataset.folder, btn.dataset.name);
  });
}

async function handleModUpload(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  if (!file.name.endsWith('.zip'))   { showToast('Only .zip files supported', 'error'); return; }
  if (file.size > 50 * 1024 * 1024) { showToast('File too large (max 50MB)', 'error'); return; }

  setText('modUploadStatus', 'Uploading...');
  const data = await API.upload('/api/mods/upload', file);
  setText('modUploadStatus', '');
  input.value = '';

  if (data?.success) {
    const msg = data.hasManifest
      ? 'Mod installed. Restart the server to load it.'
      : !data.hasManifest
        ? 'Uploaded but no manifest.json found — check archive structure.'
        : 'Uploaded but auto-install failed. Restart may still install it.';
    showToast(msg, 'success');
    loadMods();
  } else {
    showToast(data?.error || 'Upload failed', 'error');
  }
}

async function deleteMod(folder, name) {
  if (!confirm(`Delete mod "${name}"?`)) return;
  const data = await API.del(`/api/mods/${encodeURIComponent(folder)}`);
  if (data?.success) {
    showToast('Mod deleted. Restart the server to unload it.', 'success');
    loadMods();
  } else {
    showToast(data?.error || 'Delete failed', 'error');
  }
}

// ─── Actions ─────────────────────────────────────────────────────
async function restartServer() {
  if (!confirm('Restart the server?')) return;
  const data = await API.post('/api/server/restart');
  showToast(data?.success ? 'Restart initiated' : (data?.error || 'Restart failed'),
    data?.success ? 'success' : 'error');
}

async function createBackup() {
  if (lastBackupStatus?.state === 'running') {
    showToast('A backup is already in progress', 'warn');
    startBackupStatusPolling();
    return;
  }
  const data = await API.post('/api/saves/backups');
  if (data?.success) {
    applyBackupStatus(data.status, true);
    startBackupStatusPolling();
    showToast(data.alreadyRunning ? 'Backup already in progress' : 'Backup started', 'success');
  } else {
    showToast(data?.error || 'Backup failed', 'error');
  }
}

async function changePassword() {
  const oldPwd = document.getElementById('oldPassword').value;
  const newPwd = document.getElementById('newPassword').value;
  if (!oldPwd || !newPwd) { showToast('Please fill in both password fields', 'error'); return; }

  const data = await API.post('/api/auth/password', { oldPassword: oldPwd, newPassword: newPwd });
  if (data?.success) {
    if (data.token) { API.token = data.token; localStorage.setItem('panel_token', data.token); }
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    showToast('Password changed', 'success');
  } else {
    showToast(data?.error || 'Password change failed', 'error');
  }
}

// ─── Restart modal ────────────────────────────────────────────────
function showRestartModal(message) {
  const modal = document.getElementById('restartModal');
  setText('restartModalMessage', message || 'Restart the container for changes to take effect.');
  modal.style.display = '';
  modal.onclick = e => { if (e.target === modal) closeRestartModal(); };
}

function closeRestartModal() {
  document.getElementById('restartModal').style.display = 'none';
}

// ─── Factory Reset Modal ──────────────────────────────────────────
function openFactoryResetModal() {
  document.getElementById('frStep1').style.display = '';
  document.getElementById('frStep2').style.display = 'none';
  document.getElementById('frConfirmInput').value = '';
  const btn = document.getElementById('frConfirmBtn');
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  document.getElementById('factoryResetModal').style.display = 'flex';
}

function closeFactoryResetModal() {
  document.getElementById('factoryResetModal').style.display = 'none';
}

function frNextStep() {
  document.getElementById('frStep1').style.display = 'none';
  document.getElementById('frStep2').style.display = '';
  document.getElementById('frConfirmInput').focus();
}

function frCheckInput() {
  const val = document.getElementById('frConfirmInput').value;
  const btn = document.getElementById('frConfirmBtn');
  const ok  = val === 'DELETE';
  btn.style.opacity      = ok ? '1' : '0.4';
  btn.style.pointerEvents = ok ? '' : 'none';
}

async function confirmFactoryReset() {
  const btn = document.getElementById('frConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Resetting...';

  const data = await API.post('/api/wizard/factory-reset');
  if (data?.success) {
    closeFactoryResetModal();
    showToast('Reset complete — restarting game and reloading wizard…', 'success');
    setTimeout(() => window.location.reload(), 2500);
  } else {
    showToast(data?.error || 'Reset failed', 'error');
    btn.disabled = false;
    btn.textContent = 'Delete Everything';
  }
}

async function confirmRestart() {
  const btn = document.getElementById('restartNowBtn');
  if (btn) btn.disabled = true;

  try {
    const data = await API.post('/api/container/restart');
    if (data?.success) {
      showToast('Container is restarting...', 'success');
      startContainerReconnectPolling();
      return;
    }
    showToast(data?.error || 'Restart failed', 'error');
  } catch {
    showToast('Container is restarting...', 'success');
    startContainerReconnectPolling();
    return;
  }

  if (btn) btn.disabled = false;
}

function startContainerReconnectPolling() {
  closeRestartModal();
  if (containerReconnectPoll) clearInterval(containerReconnectPoll);
  const startedAt = Date.now();
  containerReconnectPoll = setInterval(async () => {
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      if (res?.ok) { clearInterval(containerReconnectPoll); window.location.reload(); return; }
    } catch {}
    if (Date.now() - startedAt > 120000) { clearInterval(containerReconnectPoll); window.location.reload(); }
  }, 2000);
}