// dashboard.js — operator "Arrange" mode: drag + resize + show/hide every UI widget on a
// snap grid, PER view, persisted to localStorage. Self-contained overlay module in the
// same mold as ceiling-brush.js / radar.js: it builds its own edit layer + palette, wires
// its own pointer handlers, and only talks to main.js through setDisplayMode()/resize().
//
// Why one external edit layer instead of per-widget handles: several widgets rewrite their
// own innerHTML every frame (#flightboard, #info, #iss-alert, #rdr-detail) and the radar
// chrome lives in a nested stacking context (#radar-ui). So ALL edit chrome lives in ONE
// global overlay (#dash-edit-layer): a translucent grid + scrim (which also absorbs
// empty-space pointerdowns, neutralising the dome/radar canvas drags while arranging) with
// one draggable/resizable frame per widget. The manager only ever POSITIONS widgets (inline
// left/top/width/height) and force-hides them via a class — it never sets inline `display`,
// so each widget's own visibility owner (#toggle-board, .show, the hidden attr) still rules.

const CELL = 24;                       // snap grid cell (px, viewport origin)
const LS_KEY = 'dashLayout';
const Z_GRAB = 120;                    // raise a grabbed widget above its neighbours

// Per-view widget manifest. Ceiling/fisheye/free share one 'dome' bucket; radar is its own
// (#atc-chip is in BOTH — it can play in either view). minW/minH bound resizing; `def` =
// [x,y,w,h] fallback used to frame a widget that is display:none (not measurable) and has
// no saved rect yet.
const VIEWS = {
  dome: [
    { id: 'panel',       label: 'Command panel',     minW: 220, minH: 120 },
    { id: 'info',        label: 'Object card',       minW: 280, minH: 90 },
    { id: 'flightboard', label: 'Overhead manifest', minW: 300, minH: 120, def: [334, 560, 540, 180] },
    { id: 'compass',     label: 'Compass',           minW: 120, minH: 150 },
    { id: 'iss-alert',   label: 'ISS alert',         minW: 180, minH: 40,  def: [600, 14, 240, 44] },
    { id: 'atc-chip',    label: 'ATC chip',          minW: 150, minH: 34,  def: [1180, 560, 200, 44] },
  ],
  radar: [
    { id: 'rdr-status',    label: 'Status bar',     minW: 320, minH: 30 },
    { id: 'rdr-tracklist', label: 'Track list',     minW: 280, minH: 120 },
    { id: 'rdr-detail',    label: 'Track detail',   minW: 220, minH: 120, def: [1180, 90, 288, 300] },
    { id: 'rdr-attrib',    label: 'Attribution',    minW: 120, minH: 16,  def: [14, 700, 260, 20] },
    { id: 'atc-chip',      label: 'ATC chip',       minW: 150, minH: 34,  def: [1180, 470, 200, 44] },
  ],
  // City/Ground is its own view — do NOT fold it into 'dome', or the dome #panel rect gets
  // re-asserted over the City chrome (the doubled/overlapping header bug). Some of these are
  // built lazily by city.js, so they're framed via `def` until first measured.
  city: [
    { id: 'panel',      label: 'Command panel',  minW: 220, minH: 120 },
    { id: 'cty-status', label: 'Status bar',     minW: 320, minH: 28,  def: [0, 0, 900, 32] },
    { id: 'cty-list',   label: 'Activity list',  minW: 280, minH: 160, def: [1020, 470, 440, 380] },
    { id: 'cty-detail', label: 'Incident detail',minW: 240, minH: 120, def: [1020, 60, 440, 300] },
    { id: 'cty-cam',    label: 'Camera viewer',  minW: 280, minH: 160, def: [980, 60, 424, 360] },
    { id: 'cty-health', label: 'Feed health',    minW: 180, minH: 80 },
    { id: 'cty-log',    label: 'Event log',      minW: 180, minH: 80 },
  ],
};

const snap = (v) => Math.round(v / CELL) * CELL;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class DashboardLayout {
  constructor() {
    this.view = 'dome';
    this.editing = false;
    this.frames = new Map();          // widgetId -> frame element
    this._drag = null;                // active drag/resize op
    this._raf = 0;
    this._saveT = 0;
    this.layout = this._load();       // { dome:{[id]:{x,y,w?,h?,hidden?}}, radar:{…} }

    this._buildLayer();
    this._injectButtons();
    this._wireHotkey();

    // apply any saved rects/hidden flags immediately (harmless while a widget is hidden)
    this._applyView('dome');
    this._applyView('radar');
    this._applyView('city');
  }

  // ---- public API (driven by main.js) ----
  setDisplayMode(mode) {
    this.view = mode === 'radar' ? 'radar' : mode === 'city' ? 'city' : 'dome';
    this._applyView(this.view);       // re-assert this view's rects (e.g. #atc-chip differs per view)
    if (this.editing) this._rebuild();
  }
  resize() {
    this._clampAll(this.view);
    if (this.editing) this._syncFrames();
  }
  toggleEdit(force) {
    const on = force === undefined ? !this.editing : !!force;
    if (on === this.editing) return;
    this.editing = on;
    document.body.classList.toggle('layout-edit', on);
    if (on) { this._rebuild(); this._startSync(); }
    else { this._stopSync(); this._clearFrames(); }
  }
  reset() {
    this.layout[this.view] = {};
    for (const w of VIEWS[this.view]) {
      const el = document.getElementById(w.id);
      if (el) { this._strip(el); el.classList.remove('dash-force-hide'); }
    }
    this._save();
    if (this.editing) this._rebuild();
  }

  // ---- element helpers ----
  _strip(el) {
    for (const p of ['left', 'top', 'right', 'bottom', 'width', 'height', 'transform', 'maxHeight', 'zIndex', 'overflow'])
      el.style[p] = '';
  }
  _measure(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  _visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  _adoptPos(el, x, y) {
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none';
  }
  _adoptSize(el, w, h) {
    el.style.width = w + 'px'; el.style.height = h + 'px'; el.style.maxHeight = 'none'; el.style.overflow = 'auto';
  }

  // apply saved rects + hidden flags for a view's widgets (the CSS is the fallback for any
  // widget with no saved entry — we simply never touch its inline styles)
  _applyView(view) {
    const b = this.layout[view] || {};
    for (const w of VIEWS[view]) {
      const el = document.getElementById(w.id);
      if (!el) continue;
      const r = b[w.id];
      if (r) {
        this._adoptPos(el, r.x, r.y);
        if (r.w != null && r.h != null) this._adoptSize(el, r.w, r.h);
        el.classList.toggle('dash-force-hide', !!r.hidden);
      } else {
        // No saved rect for this view: clear any inline styles a PREVIOUS view left on a
        // shared widget (e.g. #panel arranged in dome) so this view falls back to its CSS
        // position instead of inheriting the other view's rect. This is what stopped the
        // dome panel rect from overlapping the City header.
        this._strip(el);
        el.classList.remove('dash-force-hide');
      }
    }
  }

  // keep arranged widgets on-screen after a viewport resize
  _clampAll(view) {
    const vw = innerWidth, vh = innerHeight;
    const b = this.layout[view] || {};
    for (const w of VIEWS[view]) {
      const r = b[w.id]; const el = document.getElementById(w.id);
      if (!r || !el) continue;
      const m = this._visible(el) ? this._measure(el) : { w: r.w || w.minW, h: r.h || w.minH };
      const cw = r.w || m.w, ch = r.h || m.h;
      r.x = clamp(r.x, 0, Math.max(0, vw - cw));
      r.y = clamp(r.y, 0, Math.max(0, vh - ch));
      this._adoptPos(el, r.x, r.y);
    }
    this._save();
  }

  // ---- edit layer + palette (built once) ----
  _buildLayer() {
    const layer = document.createElement('div');
    layer.id = 'dash-edit-layer';
    const pal = document.createElement('div');
    pal.className = 'dash-palette';
    pal.innerHTML = `
      <div class="dash-pal-head">Arrange layout · <span class="dash-pal-view"></span></div>
      <div class="dash-pal-list"></div>
      <div class="dash-pal-actions">
        <button type="button" class="dash-pal-reset">Reset view</button>
        <button type="button" class="dash-pal-done">Done</button>
      </div>
      <p class="dash-pal-hint">Drag a tile to move · pull the corner to resize · toggle to show/hide. Saved automatically, per view. Press E or Done to finish.</p>`;
    layer.appendChild(pal);
    document.body.appendChild(layer);
    this.layer = layer;
    this.palette = pal;
    this._list = pal.querySelector('.dash-pal-list');
    pal.querySelector('.dash-pal-reset').addEventListener('click', () => this.reset());
    pal.querySelector('.dash-pal-done').addEventListener('click', () => this.toggleEdit(false));
    pal.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  _rebuild() { this._clearFrames(); this._buildFrames(); this._buildPalette(); }

  _buildFrames() {
    const b = this.layout[this.view] || {};
    for (const w of VIEWS[this.view]) {
      if (b[w.id]?.hidden) continue;                 // force-hidden by operator → no frame
      const el = document.getElementById(w.id);
      if (!el) continue;
      const saved = b[w.id];
      const meas = this._visible(el) ? this._measure(el) : null;
      const rect = saved
        ? { x: saved.x, y: saved.y, w: saved.w ?? (meas ? meas.w : (w.def?.[2] || w.minW)), h: saved.h ?? (meas ? meas.h : (w.def?.[3] || w.minH)) }
        : (meas || { x: w.def?.[0] ?? 40, y: w.def?.[1] ?? 40, w: w.def?.[2] ?? w.minW, h: w.def?.[3] ?? w.minH });
      rect.x = clamp(rect.x, 0, Math.max(0, innerWidth - rect.w));
      rect.y = clamp(rect.y, 0, Math.max(0, innerHeight - rect.h));

      const f = document.createElement('div');
      f.className = 'dash-frame';
      f.dataset.id = w.id;
      f.style.left = rect.x + 'px'; f.style.top = rect.y + 'px';
      f.style.width = rect.w + 'px'; f.style.height = rect.h + 'px';
      f.innerHTML = `<span class="dash-tag">${w.label}</span><span class="dash-resize"></span>`;
      this.layer.appendChild(f);
      this.frames.set(w.id, f);
      this._wireFrame(f, w);
    }
  }

  _buildPalette() {
    this.palette.querySelector('.dash-pal-view').textContent =
      this.view === 'radar' ? 'Tactical scope' : this.view === 'city' ? 'Ground · city' : 'Dome / projector';
    const b = this.layout[this.view] || {};
    this._list.innerHTML = '';
    for (const w of VIEWS[this.view]) {
      const row = document.createElement('label');
      row.className = 'dash-pal-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !b[w.id]?.hidden;
      cb.addEventListener('change', () => this._setHidden(w.id, !cb.checked));
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + w.label));
      this._list.appendChild(row);
    }
  }

  _setHidden(id, hidden) {
    const b = this.layout[this.view] || (this.layout[this.view] = {});
    const r = b[id] || (b[id] = {});
    r.hidden = hidden;
    const el = document.getElementById(id);
    if (el) el.classList.toggle('dash-force-hide', hidden);
    this._save();
    if (this.editing) { this._clearFrames(); this._buildFrames(); }
  }

  _clearFrames() { for (const f of this.frames.values()) f.remove(); this.frames.clear(); }

  // ---- pointer drag + resize (radar-pan pattern: capture start rect, apply delta) ----
  _wireFrame(f, w) {
    const begin = (e, resize) => {
      e.preventDefault(); e.stopPropagation();
      const el = document.getElementById(w.id);
      if (!el) return;
      this._drag = {
        f, w, el, resize,
        px: e.clientX, py: e.clientY,
        x: parseFloat(f.style.left), y: parseFloat(f.style.top),
        w0: f.offsetWidth, h0: f.offsetHeight,
      };
      f.setPointerCapture?.(e.pointerId);
      el.style.zIndex = String(Z_GRAB);
    };
    f.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('dash-resize')) begin(e, false); });
    f.querySelector('.dash-resize').addEventListener('pointerdown', (e) => begin(e, true));

    f.addEventListener('pointermove', (e) => {
      const d = this._drag;
      if (!d || d.f !== f) return;
      const dx = e.clientX - d.px, dy = e.clientY - d.py;
      if (d.resize) {
        const nw = clamp(snap(d.w0 + dx), w.minW, innerWidth - d.x);
        const nh = clamp(snap(d.h0 + dy), w.minH, innerHeight - d.y);
        f.style.width = nw + 'px'; f.style.height = nh + 'px';
        this._adoptSize(d.el, nw, nh);
      } else {
        const cw = f.offsetWidth, ch = f.offsetHeight;
        const nx = clamp(snap(d.x + dx), 0, Math.max(0, innerWidth - cw));
        const ny = clamp(snap(d.y + dy), 0, Math.max(0, innerHeight - ch));
        f.style.left = nx + 'px'; f.style.top = ny + 'px';
        this._adoptPos(d.el, nx, ny);
      }
    });

    const end = (e) => {
      const d = this._drag;
      if (!d || d.f !== f) return;
      f.releasePointerCapture?.(e.pointerId);
      const b = this.layout[this.view] || (this.layout[this.view] = {});
      const r = b[w.id] || (b[w.id] = {});
      r.x = parseFloat(f.style.left); r.y = parseFloat(f.style.top);
      if (d.resize) { r.w = f.offsetWidth; r.h = f.offsetHeight; }
      this._drag = null;
      this._save();
    };
    f.addEventListener('pointerup', end);
    f.addEventListener('pointercancel', end);
  }

  // keep frames tracking their widgets (panel scroll, #rdr-detail appearing on select, …)
  _startSync() {
    const loop = () => { if (!this.editing) return; this._syncFrames(); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }
  _stopSync() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }
  _syncFrames() {
    for (const [id, f] of this.frames) {
      if (this._drag && this._drag.f === f) continue;
      const el = document.getElementById(id);
      if (!el || !this._visible(el)) continue;       // leave the ghost frame put while hidden
      const r = this._measure(el);
      f.style.left = r.x + 'px'; f.style.top = r.y + 'px';
      f.style.width = r.w + 'px'; f.style.height = r.h + 'px';
    }
  }

  // ---- entry buttons + hotkey ----
  _injectButtons() {
    const fs = document.getElementById('fullscreen-btn');
    if (fs && fs.closest('.btn-row')) {
      const row = document.createElement('div'); row.className = 'btn-row';
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '⤢ Arrange layout';
      b.addEventListener('click', () => this.toggleEdit(true));
      row.appendChild(b); fs.closest('.btn-row').after(row);
    }
    // (The scope's own Arrange button used to be injected into #rdr-controls; that
    // console is gone — the panel's Arrange button above now covers every view.)
  }
  _wireHotkey() {
    addEventListener('keydown', (e) => {
      if (e.key !== 'e' && e.key !== 'E') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      this.toggleEdit();
    });
  }

  // ---- persistence ----
  _load() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY));
      if (s && typeof s === 'object') return { dome: s.dome || {}, radar: s.radar || {} };
    } catch { /* ignore */ }
    return { dome: {}, radar: {} };
  }
  _save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try { localStorage.setItem(LS_KEY, JSON.stringify(this.layout)); } catch { /* quota */ }
    }, 200);
  }
}
