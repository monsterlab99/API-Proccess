// ==UserScript==
// @name         Monster API Process Hunting — Fetch-First + GM Fallback Toggle + Retry Delays + ShadowDOM + Live 302/200 + Last Verified
// @namespace    ivac-tools
// @version      1.9.0
// @description  Prefer same-origin fetch (visible in DevTools) with optional GM fallback; path-based endpoints; live retry delays editor; 401/429 no-retry; cancellable sleeps; draggable ShadowDOM UI; live log; 302/200 counters; Mode chip; Last Verified badge.
// @match        https://payment.ivacbd.com/*
// @run-at       document-idle
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @connect      api-payment.ivacbd.com
// @connect      payment.ivacbd.com
// ==/UserScript==

(function () {
  'use strict';

  // Avoid duplicates
  if (window.MonsterProcessUI) {
    window.MonsterProcessUI.remove();
    delete window.MonsterProcessUI;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Config / Globals  (PATH-based; prefer same-origin fetch so DevTools shows it)
  // ─────────────────────────────────────────────────────────────────────────────
  const SAME_ORIGIN_BASE  = location.origin;                   // https://payment.ivacbd.com
  const CROSS_ORIGIN_BASE = 'https://api-payment.ivacbd.com';  // fallback base (GM only)

  // Use PATHS (not full URLs)
  const API_PATH = '/api/payment/appointment/process';

  const AFTER_200_GET = {
    enabled: true,
    pathTemplate: '/payment-response/{TRAN_ID}'  // path, not full URL
  };

  function resolveUrl(base, path) {
    return base.replace(/\/+$/,'') + '/' + String(path || '').replace(/^\/+/, '');
  }
  function buildApiUrlSameOrigin() { return resolveUrl(SAME_ORIGIN_BASE, API_PATH); }
  function buildApiUrlCrossOrigin() { return resolveUrl(CROSS_ORIGIN_BASE, API_PATH); }
  function buildFollowPath(tranId)  { return AFTER_200_GET.pathTemplate.replace('{TRAN_ID}', encodeURIComponent(tranId || '')); }
  function buildFollowUrlSameOrigin(tranId) { return resolveUrl(SAME_ORIGIN_BASE, buildFollowPath(tranId)); }

  let globalStopRequested = false;
  let activeControllers = new Set(); // AbortControllers, GM wrappers, and delay handles
  let abortController = new AbortController();

  let activeRequests = 0;
  let nextReqId = 1;
  const pendingRows = new Map();

  const LOG_LIMIT = 200;
  const BODY_PREVIEW = 1200;

  // Persisted UI state (counters, mirror, collapse, badges, toggles)
  const LS_STATE = 'monster_api_process_state_v190';
  function loadState(){ try { return JSON.parse(localStorage.getItem(LS_STATE)||''); } catch { return null; } }
  function saveState(){
    try {
      state.mirror       = !!mirrorConsole.checked;
      state.c302         = redirCount;
      state.c200         = okCount;
      state.multiOn      = !!multiOn;
      state.retrymaxOn   = !!retrymaxOn;
      state.allowGMFallback = !!gmFallbackToggle.checked;
      localStorage.setItem(LS_STATE, JSON.stringify(state));
    } catch{}
  }
  const state = loadState() || { mirror: true, logCollapsed: false, c302: 0, c200: 0, allowGMFallback: true };
  if (typeof state.multiOn === 'undefined')    state.multiOn = false;
  if (typeof state.retrymaxOn === 'undefined') state.retrymaxOn = true; // DEFAULT ON
  state.lastOkTran = state.lastOkTran || '';
  state.lastOkAt   = state.lastOkAt   || 0;

  // Persistent counters
  let redirCount = Number(state.c302 || 0);
  let okCount    = Number(state.c200 || 0);

  // ─────────────────────────────────────────────────────────────────────────────
  // Retry Settings + Persistence (from your V3)
  // ─────────────────────────────────────────────────────────────────────────────
  let maxRetry = Infinity;                        // engine cap; Retrymax uses this
  let Delays = [10, 11, 12, 13, 9, 14, 15, 9];          // seconds; editable via UI
  const NO_RETRY_STATUSES = new Set([401, 429, 403]);  // DO NOT retry these by default

  const LS_DELAYS = 'monster_retry_delays_v1';
  function parseDelayString(str) {
    return String(str).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  }
  function loadPersistedDelays() {
    try {
      const raw = localStorage.getItem(LS_DELAYS);
      const arr = raw ? parseDelayString(raw) : [];
      if (arr.length) Delays = arr;
    } catch {}
  }
  function savePersistedDelays() { try { localStorage.setItem(LS_DELAYS, Delays.join(',')); } catch {} }
  function getRandomDelaySec() {
    const i = Math.floor(Math.random() * Delays.length);
    const v = Number(Delays[i]);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  loadPersistedDelays();

  // ─────────────────────────────────────────────────────────────────────────────
  // Shadow DOM host (isolated)
  // ─────────────────────────────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'monsterHost';
  host.style.cssText = 'position:fixed;z-index:2147483647;inset:auto auto auto auto;';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);
  window.MonsterProcessUI = host;

  // Shield boundary (let events work inside)
  (function shieldShadowBoundary() {
    const events = [
      'contextmenu','mousedown','mouseup','click','dblclick',
      'pointerdown','pointerup','touchstart','touchend',
      'dragstart','dragenter','dragover','dragleave','drop',
      'selectstart','keydown','keyup'
    ];
    for (const ev of events) {
      host.addEventListener(ev, (e) => {
        if (shadow && shadow.contains(e.target)) e.stopPropagation();
      }, { capture: true });
    }
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // Styles (inside shadow)
  // ─────────────────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial}
    #monsterProcessBox{position:fixed;top:15px;left:15px;width:330px;max-width:95vw;background:#130f40;border-radius:12px;font-family:sans-serif;font-weight:700;box-shadow:0 4px 12px rgba(0,0,0,.3);font-size:12px;padding:12px 10px 10px;color:#fff;user-select:none;touch-action:none;transform:translate(0,0)}
    #monsterProcessBox *{font-family:sans-serif!important;font-weight:700!important;box-sizing:border-box}
    #monsterProcessHeader{background:#130f40;color:#fff;padding:6px 8px;display:flex;justify-content:space-between;align-items:center;border-radius:10px;cursor:grab;margin-bottom:8px}
    #monsterProcessHeader .iconHit{
      display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;line-height:1;border-radius:6px;margin-left:8px;cursor:pointer;user-select:none;
    }
    #monsterProcessHeader .iconHit:hover{ background:rgba(255,255,255,.15) }
    #monsterProcessHeader .iconHit:active{ transform:translateY(0.5px) }

    .toggleButtons{display:flex;justify-content:space-between;gap:8px;margin-bottom:10px}
    .toggleBtn{flex:1;font-size:11px;padding:8px 0;height:36px;border:none;border-radius:8px;color:#fff;cursor:pointer;text-align:center}
    .multiOff{background:#6c5ce7}.multiOn{background:#341f97}
    .retrymaxOff{background:#f39c12}.retrymaxOn{background:#2ecc71}
    .monsterInput{width:100%;padding:6px;font-size:11px;border:none;border-radius:6px;background:#1f1b5b;color:#fff;min-height:60px;margin-bottom:10px;resize:vertical}
    .monsterBtn{width:100%;padding:8px;background:#2980b9;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;margin-bottom:8px}
    .bottomRow{display:flex;justify-content:space-between;gap:8px;margin-bottom:6px}
    .bottomRow button{flex:1;font-size:12px;padding:8px 0;border:none;border-radius:6px;color:#fff}
    .stopAllBtn{background:#e74c3c}.clearAllBtn{background:#27ae60}
    #monsterProcessStatus{margin:6px 0;text-align:center;color:#f1f1f1;font-size:11px}

    #lastOkRow .chip{ border-color:#10b981; background:#d1fae5; color:#065f46; cursor:pointer }
    #lastOkRow .chip:active{ transform:translateY(0.5px) }

    #monsterLogHdr{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
    .chip{font-size:11px;padding:2px 6px;border-radius:999px;border:1px solid #ddd;background:#fff;color:#222}
    #logCount{margin-left:4px}
    #activeChip{margin-left:6px;border-color:#6ee7b7;background:#eafff5}
    #redirChip{ margin-left:6px; border-color:#93c5fd; background:#eff6ff; color:#1e3a8a }
    #redirChip.flash{ background:#d1fae5; border-color:#10b981 }
    #okChip{ margin-left:6px; border-color:#10b981; background:#d1fae5; color:#065f46 }
    #okChip.flash{ background:#bbf7d0; border-color:#10b981 }
    #modeChip.fetchOnly { border-color:#fb923c; background:#fff7ed; color:#7c2d12; }
    #modeChip.fetchGM   { border-color:#93c5fd; background:#eff6ff; color:#1e3a8a; }

    #monsterLogTools{display:flex;gap:6px;margin-left:auto;align-items:center;flex-wrap:nowrap}
    #monsterLogBox{max-height:240px;overflow:auto;margin-top:6px;padding:6px;background:#0a0a0a;color:#d2f8d2;border-radius:10px;border:1px solid #2a2a2a}
    .logRow{border:1px solid #2a2a2a;border-left-width:4px;border-radius:8px;padding:6px;margin-bottom:6px}
    .logRow.good{border-left-color:#2ecc71}.logRow.bad{border-left-color:#e74c3c}.logRow.run{border-left-color:#f1c40f}
    .logRow .meta{display:flex;gap:8px;align-items:center;font-size:11px;color:#a7a7a7;flex-wrap:wrap}
    .logRow .url{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px}
    .stateRun{color:#f1c40f}.stateOk{color:#2ecc71}.stateErr{color:#ff6b6b}
    .btnTiny{border:1px solid #ddd;background:#f7f7f7;border-radius:8px;padding:4px 6px;cursor:pointer;color:#222;line-height:1;min-width:auto;white-space:nowrap}

    .switch{display:inline-flex;align-items:center;gap:6px;color:#eee}
    .switch input{transform:scale(1.05)}
    #dropMark{display:none;position:absolute;inset:0;border:2px dashed #38bdf8;border-radius:12px;pointer-events:none}
    #monsterProcessBox.drop #dropMark{display:block}
  `;
  shadow.appendChild(style);

  // ─────────────────────────────────────────────────────────────────────────────
  // Panel markup (inside shadow)
  // ─────────────────────────────────────────────────────────────────────────────
  const box = document.createElement('div');
  box.id = 'monsterProcessBox';
  box.innerHTML = `
    <div id="monsterProcessHeader">
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:14px">🔥</span><b>Monster API Process Hunting</b>
      </div>
      <div>
        <span id="monsterProcessToggle" class="iconHit" title="Collapse/Expand" aria-label="Collapse/Expand">–</span>
        <span id="monsterProcessClose"  class="iconHit" title="Close panel"     aria-label="Close">×</span>
      </div>
    </div>
    <div id="monsterProcessContent">
      <div class="toggleButtons">
        <button id="multiBtn" class="toggleBtn multiOff">Multi [OFF]</button>
        <button id="retrymaxBtn" class="toggleBtn retrymaxOff">Retrymax [OFF]</button>
      </div>

      <!-- Live Retry Delays editor -->
      <div style="margin-bottom:8px;">
        <label style="font-size:11px;color:#fff;">Retry Delays (sec, comma-separated):</label>
        <input id="delayInput" type="text" value="2,4,6,3,9,5,7,9"
               style="width:100%;padding:6px;font-size:11px;border:none;border-radius:6px;background:#1f1b5b;color:#fff;">
      </div>

      <textarea id="monsterInput" class="monsterInput" placeholder="Paste or drop x-www-form-urlencoded payload here..."></textarea>
      <button id="monsterFetchBtn" class="monsterBtn">Submit Fetch</button>
      <div class="bottomRow">
        <button id="stopAllBtn" class="stopAllBtn">🔴 Stop All</button>
        <button id="clearAllBtn" class="clearAllBtn" title="Clear the input field">🧹 Clear</button>
      </div>
      <div id="monsterProcessStatus"></div>

      <!-- Last Verified badge -->
      <div id="lastOkRow" style="display:none; margin:4px 0 6px 0;">
        <span id="lastOkBadge" class="chip" title="Click to copy tran_id">Last Verified: —</span>
      </div>

      <div id="monsterLogHdr">
        <strong style="color:#fff">Live Network Log</strong>
        <span id="logCount" class="chip">0 req</span>
        <span id="activeChip" class="chip">Active: 0</span>
        <span id="redirChip"  class="chip" title="302 redirects detected">302: —</span>
        <span id="okChip"     class="chip" title="200 OK confirmed">200: —</span>
        <span id="modeChip"   class="chip" title="Current request engine mode">Mode: …</span>
        <div id="monsterLogTools">
          <label class="switch" title="Mirror important events to console">
            <input id="mirrorConsole" type="checkbox"/> Console
          </label>
          <label class="switch" title="Allow fallback to GM_xmlhttpRequest if fetch fails (CORS/down server)">
            <input id="gmFallbackToggle" type="checkbox" checked/> GM Fallback
          </label>
          <button id="logCollapse" class="btnTiny" title="Collapse/Expand">▾</button>
          <button id="logClear" class="btnTiny" title="Clear log">Clear</button>
          <button id="logExport" class="btnTiny" title="Export log">Export</button>
        </div>
      </div>
      <div id="monsterLogBox"></div>
    </div>
    <div id="dropMark"></div>
  `;
  shadow.appendChild(box);

  // ─────────────────────────────────────────────────────────────────────────────
  // Smooth drag with persistence (default center-bottom on first load)
  // ─────────────────────────────────────────────────────────────────────────────
  (function initSmoothDrag() {
    const header = shadow.getElementById('monsterProcessHeader');
    let baseX = 15, baseY = 15, nx = 15, ny = 15, dragging = false, sx=0, sy=0, rafPending=false;

    let hasSavedPos = false;
    try {
      const pos = JSON.parse(localStorage.getItem('monster_ui_pos') || 'null');
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        baseX = nx = pos.x; baseY = ny = pos.y;
        hasSavedPos = true;
      }
    } catch {}

    if (!hasSavedPos) {
      const prev = box.style.transform;
      box.style.transform = '';
      const rect = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      nx = Math.round((vw - rect.width) / 2);
      ny = Math.round(vh - rect.height - 20);
      baseX = nx; baseY = ny;
      box.style.transform = prev;
      try { localStorage.setItem('monster_ui_pos', JSON.stringify({ x: nx, y: ny })); } catch {}
    }

    box.style.transform = `translate(${nx}px, ${ny}px)`;

    function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
    function onDown(e){
      const id = e.target && e.target.id;
      if (id === 'monsterProcessToggle' || id === 'monsterProcessClose') return;
      dragging = true; box.style.cursor = 'grabbing';
      try { header.setPointerCapture(e.pointerId || 1); } catch {}
      sx = e.clientX; sy = e.clientY; e.preventDefault();
    }
    function onMove(e){
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      const rect = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const maxX = vw - rect.width - 6, maxY = vh - rect.height - 6;
      nx = clamp(baseX + dx, 6 - rect.width * 0.25, maxX);
      ny = clamp(baseY + dy, 6, maxY);
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => { box.style.transform = `translate(${nx}px, ${ny}px)`; rafPending = false; });
      }
    }
    function onUp(e){
      if (!dragging) return;
      dragging = false; box.style.cursor = '';
      baseX = nx; baseY = ny;
      try { localStorage.setItem('monster_ui_pos', JSON.stringify({ x: nx, y: ny })); } catch {}
      try { header.releasePointerCapture(e.pointerId || 1); } catch {}
    }
    header.style.touchAction = 'none';
    header.addEventListener('pointerdown', onDown);
    shadow.addEventListener('pointermove', onMove);
    shadow.addEventListener('pointerup', onUp);
    window.addEventListener('resize', () => {
      const rect = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const maxX = vw - rect.width - 6, maxY = vh - rect.height - 6;
      nx = clamp(nx, 6 - rect.width * 0.25, maxX);
      ny = clamp(ny, 6, maxY);
      box.style.transform = `translate(${nx}px, ${ny}px)`;
      try { localStorage.setItem('monster_ui_pos', JSON.stringify({ x: nx, y: ny })); } catch {}
    });
  })();

  // ─────────────────────────────────────────────────────────────────────────────
  // Drag-and-drop payload into textarea
  // ─────────────────────────────────────────────────────────────────────────────
  const ta = shadow.getElementById('monsterInput');
  ['dragenter','dragover'].forEach(ev => {
    box.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); box.classList.add('drop'); });
  });
  ['dragleave','dragend'].forEach(ev => {
    box.addEventListener(ev, e => {
      e.preventDefault(); e.stopPropagation();
      const rel = e.relatedTarget;
      if (!rel || (rel instanceof Node && !box.contains(rel))) box.classList.remove('drop');
    });
  });
  box.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation(); box.classList.remove('drop');
    const txt = e.dataTransfer.getData('text/plain');
    if (txt) { ta.value = txt; return; }
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) { try { ta.value = await f.text(); } catch {} }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // UI refs (inside shadow) + helpers
  // ─────────────────────────────────────────────────────────────────────────────
  const input = shadow.getElementById('monsterInput');
  const fetchBtn = shadow.getElementById('monsterFetchBtn');
  const status = shadow.getElementById('monsterProcessStatus');
  const multiBtn = shadow.getElementById('multiBtn');
  const retrymaxBtn = shadow.getElementById('retrymaxBtn');
  const stopBtn = shadow.getElementById('stopAllBtn');
  const clearBtn = shadow.getElementById('clearAllBtn');
  const logBox = shadow.getElementById('monsterLogBox');
  const logCount = shadow.getElementById('logCount');
  const activeChip = shadow.getElementById('activeChip');
  const mirrorConsole = shadow.getElementById('mirrorConsole');
  const gmFallbackToggle = shadow.getElementById('gmFallbackToggle');
  const modeChip = shadow.getElementById('modeChip');
  const logCollapseBtn = shadow.getElementById('logCollapse');
  const logClearBtn = shadow.getElementById('logClear');
  const logExportBtn = shadow.getElementById('logExport');
  const lastOkRow   = shadow.getElementById('lastOkRow');
  const lastOkBadge = shadow.getElementById('lastOkBadge');
  const delayInput  = shadow.getElementById('delayInput');

  function setBtnState(btn, isOn, onClass, offClass, label) {
    if (!btn) return;
    btn.classList.toggle(onClass,  isOn);
    btn.classList.toggle(offClass, !isOn);
    btn.textContent = `${label} [${isOn ? 'ON' : 'OFF'}]`;
  }

  let multiOn    = !!state.multiOn;
  let retrymaxOn = !!state.retrymaxOn;
  setBtnState(multiBtn,    multiOn,    'multiOn',    'multiOff',    'Multi');
  setBtnState(retrymaxBtn, retrymaxOn, 'retrymaxOn', 'retrymaxOff', 'Retrymax');

  // Retry Delays editor (persist)
  if (delayInput) {
    delayInput.value = Delays.join(',');
    delayInput.addEventListener('change', () => {
      const parts = parseDelayString(delayInput.value);
      if (parts.length) {
        Delays = parts;
        savePersistedDelays();
        showStatus(`⏱ Retry delays set to [${Delays.join(', ')}]`, '#27ae60');
      } else {
        showStatus('⚠️ Invalid delays — keeping old values', '#e67e22');
        delayInput.value = Delays.join(',');
      }
    });
  }

  mirrorConsole.checked = !!state.mirror;
  if (typeof state.allowGMFallback === 'boolean') {
    gmFallbackToggle.checked = state.allowGMFallback;
  } else {
    gmFallbackToggle.checked = true;
    state.allowGMFallback = true;
  }

  // Counters: format & render
  function fmtCount(n){ return n > 0 ? String(n) : '—'; }
  function updateRedirChip({ bump = false, flash = false } = {}) {
    const chip = shadow.getElementById('redirChip');
    if (!chip) return;
    if (bump) redirCount++;
    chip.textContent = `302: ${fmtCount(redirCount)}`;
    if (flash) { chip.classList.add('flash'); setTimeout(()=>chip.classList.remove('flash'), 800); }
    state.c302 = redirCount; saveState();
  }
  function updateOkChip({ bump = false, flash = false } = {}) {
    const chip = shadow.getElementById('okChip');
    if (!chip) return;
    if (bump) okCount++;
    chip.textContent = `200: ${fmtCount(okCount)}`;
    if (flash) { chip.classList.add('flash'); setTimeout(()=>chip.classList.remove('flash'), 800); }
    state.c200 = okCount; saveState();
  }

  // Mode chip
  function isGMAllowed(){ return !!(gmFallbackToggle && gmFallbackToggle.checked); }
  function renderModeChip() {
    const gm = isGMAllowed();
    modeChip.textContent = gm ? 'Mode: Fetch+GM' : 'Mode: Fetch-only';
    modeChip.classList.remove('fetchOnly', 'fetchGM');
    modeChip.classList.add(gm ? 'fetchGM' : 'fetchOnly');
  }
  renderModeChip();

  // Last Verified badge
  function renderLastOk(){
    if (!lastOkRow || !lastOkBadge) return;
    if (!state.lastOkTran){
      lastOkRow.style.display = 'none';
      lastOkBadge.textContent = 'Last Verified: —';
      lastOkBadge.removeAttribute('data-tran');
      return;
    }
    const t = new Date(state.lastOkAt || Date.now());
    const hh = String(t.getHours()).padStart(2,'0');
    const mm = String(t.getMinutes()).padStart(2,'0');
    const ss = String(t.getSeconds()).padStart(2,'0');
    lastOkBadge.textContent = `Last Verified: ${state.lastOkTran} @ ${hh}:${mm}:${ss}`;
    lastOkBadge.setAttribute('data-tran', state.lastOkTran);
    lastOkRow.style.display = '';
  }
  function setLastOk(tran){
    if (!tran) return;
    state.lastOkTran = tran;
    state.lastOkAt   = Date.now();
    saveState();
    renderLastOk();
    lastOkBadge.classList.add('flash');
    setTimeout(()=> lastOkBadge.classList.remove('flash'), 800);
  }
  if (lastOkBadge){
    lastOkBadge.addEventListener('click', async () => {
      const v = lastOkBadge.getAttribute('data-tran') || state.lastOkTran || '';
      if (!v) return;
      try { await navigator.clipboard.writeText(v); showStatus(`Copied ${v}`, '#10b981'); } catch{}
    });
  }

  // Initial render of persisted totals + badge + log collapse
  updateRedirChip();
  updateOkChip();
  renderLastOk();
  if (state.logCollapsed) toggleCollapse(logBox, logCollapseBtn, true);

  // Keyboard accessibility for header icons
  ['monsterProcessToggle','monsterProcessClose'].forEach(id=>{
    const el = shadow.getElementById(id);
    if (!el) return;
    el.setAttribute('role','button');
    el.setAttribute('tabindex','0');
    el.addEventListener('keydown', (e)=>{
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers (UI + toast + detect + follow + cancellable delay)
  // ─────────────────────────────────────────────────────────────────────────────
  function showStatus(msg, color = '#3498db', duration = 10000) {
    status.textContent = msg;
    status.style.color = color;
    clearTimeout(window.__monsterStatusTimer);
    if (duration !== Infinity) window.__monsterStatusTimer = setTimeout(() => { status.textContent = ''; }, duration);
  }
  function updateActiveReqUI() {
    activeChip.textContent = `Active: ${activeRequests}`;
    activeChip.style.borderColor = activeRequests > 0 ? '#10b981' : '#ddd';
    activeChip.style.background = activeRequests > 0 ? '#d1fae5' : '#fff';
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function preview(s, full = false) { if (!s) return ''; return full || s.length <= BODY_PREVIEW ? s : s.slice(0, BODY_PREVIEW) + `\n…(${s.length - BODY_PREVIEW} more chars)`; }

  function setCollapseIcon(btn, collapsed){ if (!btn) return; btn.textContent = collapsed ? '▸' : '▾'; }
  function toggleCollapse(target, btn, force) {
    const collapsed = force ?? (target.style.display !== 'none');
    target.style.display = collapsed ? 'none' : '';
    setCollapseIcon(btn, collapsed);
    state.logCollapsed = collapsed; saveState();
  }

  function toast(msg, ok = true) {
    const t = document.createElement('div');
    Object.assign(t.style, { position: 'fixed', right: '14px', top: '14px', background: ok ? '#10b981' : '#f59e0b', color:'#031b0d', padding:'8px 12px', borderRadius:'10px', font:'12px/1.3 system-ui', zIndex:2147483647, boxShadow:'0 6px 16px rgba(0,0,0,.2)' });
    t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3000);
  }

  function parseHeaders(raw = '') {
    const map = {};
    raw.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (m) map[m[1].toLowerCase()] = m[2];
    });
    return map;
  }

  // Cancelable delay for retry sleeps (so Stop All aborts instantly)
  function makeCancellableDelay(ms) {
    let timer = null, resolveRef = null;
    const promise = new Promise((resolve) => {
      resolveRef = resolve;
      timer = setTimeout(() => { timer = null; resolve(); }, ms);
    });
    return {
      promise,
      abort() {
        if (timer !== null) { clearTimeout(timer); timer = null; }
        if (resolveRef) { resolveRef(); }
      }
    };
  }

  function detectSuccess({ status, responseHeadersStr = '', body = '', requestBody = '', finalUrl = '' }) {
    // Request body (explicit)
    if (requestBody) {
      const q = new URLSearchParams(requestBody);
      const tran = q.get('tran_id') || (requestBody.match(/SBIMU\d+/i)?.[0] || '');
      const st   = (q.get('status') || '').toUpperCase();
      if (tran) return { ok: st ? st === 'VALID' : undefined, why: 'request', tran_id: tran, status: st };
    }
    // Final URL
    if (finalUrl) {
      try {
        const urlObj = new URL(finalUrl, location.origin);
        const tran = urlObj.searchParams.get('tran_id') || (finalUrl.match(/SBIMU\d+/i)?.[0] || '');
        const st   = (urlObj.searchParams.get('status') || '').toUpperCase();
        if (tran) return { ok: st ? st === 'VALID' : undefined, why: 'finalUrl', tran_id: tran, status: st };
      } catch {}
    }
    // 302 Location header
    if (status === 302 && responseHeadersStr) {
      const map = parseHeaders(responseHeadersStr);
      const loc = map['location'];
      if (loc) {
        const dec = decodeURIComponent(loc);
        try {
          const urlObj = new URL(dec, location.origin);
          const tran = urlObj.searchParams.get('tran_id') || (dec.match(/SBIMU\d+/i)?.[0] || '');
          const st   = (urlObj.searchParams.get('status') || '').toUpperCase();
          if (tran) return { ok: st ? st === 'VALID' : undefined, why: '302->Location', tran_id: tran, status: st, location: dec };
        } catch {}
      }
    }
    // Fallback: scan body
    const txt = typeof body === 'string' ? body : '';
    const tran = (txt.match(/SBIMU\d+/i) || [])[0] || null;
    const stM  = (txt.match(/status=(VALID|FAILED)/i) || [])[1];
    const st   = (stM || '').toUpperCase();
    if (tran) return { ok: st ? st === 'VALID' : undefined, why: 'body', tran_id: tran, status: st };
    return { ok: undefined };
  }

  // Prefer same-origin follow so it shows in DevTools Network
  async function followOnce(url) {
    try {
      const res = await fetch(url, { method: 'GET', credentials: 'include' });
      const text = await res.text().catch(() => '');
      return { status: res.status, text };
    } catch {
      if (typeof GM_xmlhttpRequest === 'function') {
        return new Promise(resolve => {
          GM_xmlhttpRequest({
            method: 'GET', url, timeout: 15000,
            onload: r => resolve({ status: r.status, text: String(r.responseText || '') }),
            onerror: () => resolve(null), ontimeout: () => resolve(null)
          });
        });
      }
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Live log
  // ─────────────────────────────────────────────────────────────────────────────
  const logs = [];
  function bumpReqCount() { logCount.textContent = `${logs.length} req`; }

  function startLog(reqId, meta) {
    logs.push({ reqId, ...meta, status: 'RUNNING' });
    if (logs.length > LOG_LIMIT) logs.shift();
    const row = document.createElement('div');
    row.className = 'logRow run';
    row.id = `req-${reqId}`;
    row.innerHTML = `
      <div class="meta">
        <span>${new Date(meta.ts).toLocaleTimeString()}</span>
        <span class="url" title="${meta.url}"><b>${meta.method}</b> ${meta.url}</span>
        <span class="chip stateRun">RUNNING</span>
        <span>—</span>
      </div>
      <div style="color:#a9f">Payload:</div>
      <pre style="white-space:pre-wrap">${escapeHtml(preview(meta.requestBody))}</pre>
      <details><summary>Response</summary><pre style="white-space:pre-wrap">—</pre></details>
    `;
    logBox.prepend(row);
    pendingRows.set(reqId, row);
    bumpReqCount();
    if (state.mirror) console.log('%c[MonsterAPI]%c START —', 'color:#06c;font-weight:bold','color:inherit', meta);
  }

  async function finalizeLog(reqId, { statusCode, ms, responseBody, ok, headersRaw, finalUrl = '', requestBody = '' }) {
    const row = pendingRows.get(reqId); if (!row) return;
    row.classList.remove('run'); row.classList.add(ok ? 'good' : 'bad');

    const stateChip = row.querySelector('.meta .chip');
    stateChip.classList.remove('stateRun'); stateChip.classList.add(ok ? 'stateOk' : 'stateErr');
    stateChip.textContent = String(statusCode || 'ERR');

    const metaSpans = row.querySelectorAll('.meta span');
    if (metaSpans[3]) metaSpans[3].textContent = `${ms} ms`;

    const respPre = row.querySelector('details pre');
    respPre.textContent = responseBody || '';

    const hadRedirect =
      statusCode === 302 ||
      /(^|[\r\n])location\s*:/i.test(headersRaw || '') ||
      (finalUrl && !/\/api\/payment\/appointment\/process\b/i.test(finalUrl));

    if (hadRedirect) updateRedirChip({ bump: true });
    if (hadRedirect && statusCode !== 302 && finalUrl) updateRedirChip({ flash: true });
    if (statusCode === 200) updateOkChip({ bump: true });

    const det = detectSuccess({ status: statusCode, responseHeadersStr: headersRaw || '', body: responseBody || '', requestBody: requestBody || '', finalUrl });
    if (det && det.tran_id) {
      const badge = document.createElement('span');
      badge.className = 'chip'; badge.style.marginLeft = '6px';
      let bg = '#fef9c3', br = '#eab308', label = `CONFIRMED: ${det.tran_id}`;
      if (det.status === 'VALID' || det.ok === true) { bg = '#d1fae5'; br = '#10b981'; }
      else if (det.status === 'FAILED') { bg = '#ffe4e6'; br = '#fb7185'; }
      if (det.status) label += ` · ${det.status}`;
      badge.style.background = bg; badge.style.borderColor = br; badge.textContent = label;
      row.querySelector('.meta')?.appendChild(badge);

      if (det.ok !== false && det.status !== 'FAILED') { toast(`CONFIRMED: ${det.tran_id}`, true); try { navigator.clipboard.writeText(det.tran_id); } catch {} }
      else { toast(`Result for ${det.tran_id}: ${det.status || 'UNKNOWN'}`, false); }

      if ((det.status === 'VALID' || det.ok === true) && det.tran_id) setLastOk(det.tran_id);

      if (AFTER_200_GET.enabled && (statusCode === 200 || statusCode === 302 || hadRedirect)) {
        const followURL = det.why === '302->Location' && det.location ? det.location : buildFollowUrlSameOrigin(det.tran_id);
        const tag = document.createElement('span');
        tag.className = 'chip'; tag.style.marginLeft = '6px'; tag.style.background = '#e0f2fe'; tag.style.borderColor = '#38bdf8'; tag.textContent = 'FOLLOWING…';
        row.querySelector('.meta')?.appendChild(tag);
        const follow = await followOnce(followURL);
        if (follow) {
          const extra = `\n\n--- Payment Response (${follow.status}) ${followURL} ---\n` + (follow.text.slice(0, 2000));
          respPre.textContent += extra;
          tag.textContent = follow.status === 200 ? 'CONFIRMED' : `ERR ${follow.status}`;
          tag.style.background = follow.status === 200 ? '#d1fae5' : '#fff7ed';
          tag.style.borderColor = follow.status === 200 ? '#10b981' : '#fb923c';

          if (hadRedirect && follow.status === 200) updateRedirChip({ flash: true });
          if (follow.status === 200) updateOkChip({ bump: true, flash: true });

          if (follow.status === 200){
            const validInFollow = /status\s*=\s*VALID/i.test(follow.text || '') || /VALID/i.test(follow.text || '');
            if (validInFollow && det.tran_id) setLastOk(det.tran_id);
          }
        }
      }
    } else if (AFTER_200_GET.enabled && (statusCode === 200 || statusCode === 302 || hadRedirect)) {
      const warn = document.createElement('span');
      warn.className = 'chip'; warn.style.marginLeft = '6px'; warn.style.background = '#fff7ed'; warn.style.borderColor = '#fb923c'; warn.textContent = 'TRAN_ID not found';
      row.querySelector('.meta')?.appendChild(warn);
    }

    pendingRows.delete(reqId);
    if (state.mirror) console.log(`%c[MonsterAPI]%c ${ok ? 'DONE' : 'FAIL'} ${statusCode} ${ms}ms`, 'color:#06c;font-weight:bold','color:inherit', { reqId, status: statusCode, ms, response: responseBody?.slice?.(0, 500), finalUrl, headersRaw });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sender — prefer same-origin fetch (visible in Network); GM only as fallback
  // ─────────────────────────────────────────────────────────────────────────────
  function sendOnce({ controller }) {
    const body = input.value.trim();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };

    const ts = Date.now(); const reqId = nextReqId++;
    const apiSame  = buildApiUrlSameOrigin();
    const apiCross = buildApiUrlCrossOrigin();

    activeRequests++; updateActiveReqUI();
    const startMeta = { ts, method: 'POST', url: apiSame, requestHeaders: headers, requestBody: String(body || '') };
    startLog(reqId, startMeta);

    // 1) Try same-origin fetch first (shows in DevTools)
    return fetch(apiSame, {
      method: 'POST',
      headers,
      body,
      credentials: 'include',
      signal: controller?.signal
    }).then(async res => {
      const ms = Date.now() - ts;
      const text = await res.text().catch(() => '');
      finalizeLog(reqId, {
        statusCode: res.status,
        ms,
        responseBody: text,
        ok: res.ok || res.status === 302,
        headersRaw: '',
        finalUrl: '',
        requestBody: String(body || '')
      });
      return { ok: res.ok || res.status === 302, status: res.status, text };
    }).catch(async err => {
      // mark first leg as failed
      const msFail = Date.now() - ts;
      finalizeLog(reqId, {
        statusCode: 0,
        ms: msFail,
        responseBody: String(err?.message || err || 'Fetch failed; trying GM...'),
        ok: false,
        headersRaw: '',
        finalUrl: '',
        requestBody: String(body || '')
      });

      // If user disabled fallback, stop here
      if (!isGMAllowed()) {
        const row = pendingRows.get(reqId);
        if (row) {
          const badge = document.createElement('span');
          badge.className = 'chip'; badge.style.marginLeft = '6px';
          badge.style.background = '#fff7ed'; badge.style.borderColor = '#fb923c';
          badge.textContent = 'GM fallback blocked';
          row.querySelector('.meta')?.appendChild(badge);
        }
        return { ok:false, status:0, text:'Fetch failed and GM fallback is disabled' };
      }

      // 2) Fallback to GM (cross-origin)
      const reqId2 = nextReqId++;
      activeRequests++; updateActiveReqUI();
      startLog(reqId2, { ts: Date.now(), method: 'POST', url: apiCross, requestHeaders: headers, requestBody: String(body || '') });

      if (typeof GM_xmlhttpRequest !== 'function') {
        const ms = Date.now() - ts;
        finalizeLog(reqId2, {
          statusCode: 0, ms,
          responseBody: 'GM_xmlhttpRequest unavailable',
          ok: false, headersRaw: '', finalUrl: '', requestBody: String(body || '')
        });
        activeRequests = Math.max(0, activeRequests - 1); updateActiveReqUI();
        return { ok:false, status:0, text:'No GM fallback' };
      }

      return new Promise(resolve => {
        let gmHandle = null;
        let cancelled = false;

        const gmWrapper = {
          abort() { try { gmHandle?.abort?.(); } catch {} cancelled = true; }
        };
        gmWrapper._controllerRef = gmWrapper;
        activeControllers.add(gmWrapper);

        gmHandle = GM_xmlhttpRequest({
          method: 'POST',
          url: apiCross,
          headers,
          data: body,
          timeout: 30000,
          onload: res => {
            cleanup();
            if (cancelled || globalStopRequested) return resolve({ ok:false, status:0, text:'' });
            const ms = Date.now() - ts;
            const statusOk = (res.status >= 200 && res.status < 400) || res.status === 302;
            finalizeLog(reqId2, {
              statusCode: res.status,
              ms,
              responseBody: String(res.responseText || ''),
              ok: statusOk,
              headersRaw: res.responseHeaders || '',
              finalUrl: res.finalUrl || '',
              requestBody: String(body || '')
            });
            resolve({ ok: statusOk, status: res.status, text: String(res.responseText || '') });
          },
          onerror: e => {
            cleanup();
            const ms = Date.now() - ts;
            finalizeLog(reqId2, {
              statusCode: 0, ms,
              responseBody: String(e?.error || 'Request failed'),
              ok: false, headersRaw: '', finalUrl: '', requestBody: String(body || '')
            });
            resolve({ ok:false, status:0, text:'Network error' });
          },
          ontimeout: () => {
            cleanup();
            const ms = Date.now() - ts;
            finalizeLog(reqId2, {
              statusCode: 0, ms,
              responseBody: 'Timeout',
              ok: false, headersRaw: '', finalUrl: '', requestBody: String(body || '')
            });
            resolve({ ok:false, status:0, text:'Timeout' });
          }
        });

        function cleanup() {
          activeControllers.delete(gmWrapper);
          activeRequests = Math.max(0, activeRequests - 1); updateActiveReqUI();
        }
      });
    }).finally(() => {
      if (controller) activeControllers.delete(controller);
      activeRequests = Math.max(0, activeRequests - 1); updateActiveReqUI();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Engines & Buttons (wired to shadow UI)
  // ─────────────────────────────────────────────────────────────────────────────
  const fetchBtnKeyHandler = (e) => {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); fetchBtn.click(); }
  };
  input.addEventListener('keydown', fetchBtnKeyHandler);
  shadow.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') shadow.getElementById('monsterProcessClose')?.click(); });

  multiBtn.onclick = () => {
    multiOn = !multiOn;
    setBtnState(multiBtn, multiOn, 'multiOn', 'multiOff', 'Multi');
    state.multiOn = multiOn;
    saveState();
  };
  retrymaxBtn.onclick = () => {
    retrymaxOn = !retrymaxOn;
    setBtnState(retrymaxBtn, retrymaxOn, 'retrymaxOn', 'retrymaxOff', 'Retrymax');
    state.retrymaxOn = retrymaxOn;
    saveState();
  };
  clearBtn.onclick = () => { input.value = ''; status.textContent = ''; };

  fetchBtn.onclick = async () => {
    const payload = input.value.trim();
    if (!payload) { showStatus('⚠️ Paste or drop a payload first', '#e67e22'); return; }
    if (multiOn && retrymaxOn) { showStatus('🔁 Multi + Retrymax Mode Running...', '#9b59b6'); startCombinedEngine(); }
    else if (multiOn) { showStatus('🚀 Sending 5 Fetch Requests...', '#3498db'); startMultiOnly(); }
    else if (retrymaxOn) { showStatus('🔄 Retrymax Mode Running...', '#f39c12'); startRetrymaxOnly(); }
    else { showStatus('⏳ Sending single request...'); await doSimpleSend(); }
  };

  shadow.getElementById('monsterProcessToggle').onclick = () => {
    const content = shadow.getElementById('monsterProcessContent'); const toggle = shadow.getElementById('monsterProcessToggle');
    const collapsed = content.style.display === 'none'; content.style.display = collapsed ? 'block' : 'none'; toggle.textContent = collapsed ? '–' : '+';
  };
  shadow.getElementById('monsterProcessClose').onclick = () => host.remove();

  gmFallbackToggle.onchange = () => { saveState(); renderModeChip(); };
  mirrorConsole.onchange = saveState;

  stopBtn.onclick = () => {
    globalStopRequested = true;
    for (const ctrl of Array.from(activeControllers)) { try { ctrl.abort && ctrl.abort(); } catch {} }
    activeControllers.clear();
    try { abortController.abort(); } catch {}
    abortController = new AbortController();
    setTimeout(() => { globalStopRequested = false; }, 1000);
    showStatus('🛑 All operations and retries cancelled', '#e74c3c');
  };

  function startMultiOnly() { for (let i = 0; i < 5; i++) doSimpleSend(`#${i + 1}`); }
  function startRetrymaxOnly() {
    fetchWithRetry(() => {
      globalStopRequested = true;
      stopBtn.click();
      showStatus('✅ Success. Aborting all.', '#2ecc71');
    });
  }
  function startCombinedEngine() {
    let launched = 0;
    const launch = () => {
      if (globalStopRequested || launched >= maxRetry) return;
      launched++;
      fetchWithRetry(() => {
        globalStopRequested = true;
        stopBtn.click();
        showStatus('✅ Success. Aborting all.', '#2ecc71');
      });
    };
    for (let i = 0; i < 5 && launched < maxRetry; i++) launch();
  }

  // Log toolbar
  logCollapseBtn.onclick = () => toggleCollapse(logBox, logCollapseBtn);
  logClearBtn.onclick = () => {
    logs.length = 0;
    logBox.innerHTML = '';
    logCount.textContent = '0 req';

    redirCount = 0; okCount = 0;
    updateRedirChip(); updateOkChip();
    state.c302 = 0; state.c200 = 0;

    state.lastOkTran = '';
    state.lastOkAt   = 0;
    renderLastOk();

    saveState();
    showStatus('🧹 Log cleared and totals reset', '#27ae60');
  };
  logExportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `monster_network_log_${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click(); URL.revokeObjectURL(a.href);
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Engines (simple + retry)
  // ─────────────────────────────────────────────────────────────────────────────
  async function doSimpleSend(label = '') {
    const controller = new AbortController(); controller._controllerRef = controller; activeControllers.add(controller);
    const { ok, status: st } = await sendOnce({ controller });
    if (ok) showStatus(`✅ Success ${label} [${st}]`, '#2ecc71'); else showStatus(`❌ Failed ${label} [${st}]`, '#e74c3c');
    return ok;
  }

  async function fetchWithRetry(onSuccess) {
    const controller = new AbortController();
    controller._controllerRef = controller;
    activeControllers.add(controller);

    let retryCount = 0;

    while (retryCount < maxRetry && !globalStopRequested) {
      const { ok, status: st } = await sendOnce({ controller });

      if (ok) {
        showStatus(`✅ HTTP ${st} Success`, '#2ecc71');
        if (onSuccess) onSuccess(st);
        activeControllers.delete(controller);
        return true;
      }

      if (NO_RETRY_STATUSES.has(st)) {
        showStatus(`⛔ No retry on HTTP ${st}`, '#e67e22');
        break;
      }

      retryCount++;
      if (retryCount >= maxRetry || globalStopRequested) break;

      const delaySec = getRandomDelaySec();
      showStatus(`⚠️ Retry ${retryCount} failed (HTTP ${st}). Retrying in ${delaySec}s…`, '#f39c12');

      const delayHandle = makeCancellableDelay(delaySec * 1000);
      activeControllers.add(delayHandle);
      await delayHandle.promise;
      activeControllers.delete(delayHandle);

      if (globalStopRequested) break;
    }

    activeControllers.delete(controller);
    if (!globalStopRequested) showStatus('❌ Retrymax failed all attempts.', '#e74c3c');
    return false;
  }

})();
