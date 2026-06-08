// ceiling-brush.js — a paint-to-reveal mask for mapping the projection onto a real
// flat ceiling.
//
// The flat-roof ("ceiling") and fisheye projector modes light up the whole image, but
// a real ceiling is rarely a clean rectangle — crown molding, beams, a round medallion,
// an alcove. This overlays a 2D black mask the user PAINTS while lying under the
// projector: brush to REVEAL the sky where the ceiling is, and HIDE (black) everything
// else, so only the ceiling lights up and the spill onto walls/edges goes dark. The
// mask is saved to localStorage, so a kiosk keeps its painted shape across reloads.
//
// It is a pure screen-space canvas overlay: where the canvas is opaque black it covers
// the sky (unlit on a projector); where transparent, the sky shows through. It never
// touches the WebGL render, the projection, or any positioning math.

const LS_MASK = 'ceilMask';        // the painted bitmap (PNG data URL)
const LS_CFG = 'ceilShapeCfg';     // { enabled, brushMode, size }

export class CeilingBrush {
  constructor() {
    this.canvas = document.getElementById('ceiling-brush');
    this.cursor = document.getElementById('brush-cursor');
    if (!this.canvas) return;      // markup absent — feature is a no-op
    this.ctx = this.canvas.getContext('2d');

    this.enabled = false;          // custom shape on/off
    this.painting = false;         // paint MODE: the mouse paints instead of rotating the view
    this.brushMode = 'reveal';     // 'reveal' (erase black) | 'hide' (paint black)
    this.size = 120;               // brush diameter, CSS px
    this.displayMode = 'ceiling';  // kept in sync by main.js
    this._drawing = false;         // a stroke is in progress
    this._last = null;
    this._saveTimer = 0;

    this._resizeCanvas(false);
    this._wireControls();
    this._wirePointer();
    this._loadCfg();               // restores size/mode/enabled (reflects into controls)
    this._loadMask();              // async — draws the saved shape once it decodes
  }

  // --- public API (main.js) ---
  setDisplayMode(mode) { this.displayMode = mode; this._applyActive(); }
  resize() { if (this.canvas) this._resizeCanvas(true); }

  // --- active state: the overlay only applies over a projector image (ceiling/fisheye),
  // never the free-look screen view. The body class shows the overlay AND hides the
  // fixed round skylight vignette so the two don't stack.
  _applyActive() {
    const active = this.enabled && this.displayMode !== 'free';
    document.body.classList.toggle('custom-ceiling', active);
    if (!active) this._setPaint(false);
  }

  _setEnabled(on) {
    this.enabled = on;
    const cb = document.getElementById('cs-enable'); if (cb) cb.checked = on;
    this._applyActive();
    this._saveCfg();
  }

  _setPaint(on) {
    // Turning paint on auto-enables the custom shape (so the single Paint button is
    // enough to start mapping). Paint only engages over a projector image.
    if (on && !this.enabled) this._setEnabled(true);
    this.painting = on && this.enabled && this.displayMode !== 'free';
    document.body.classList.toggle('brush-paint', this.painting);
    const btn = document.getElementById('cs-paint');
    if (btn) {
      btn.textContent = this.painting ? '✎ Paint: ON' : '✎ Paint: off';
      btn.classList.toggle('active', this.painting);
    }
  }

  _setBrushMode(m) {
    this.brushMode = m;
    document.getElementById('cs-reveal')?.classList.toggle('active', m === 'reveal');
    document.getElementById('cs-hide')?.classList.toggle('active', m === 'hide');
    this._saveCfg();
  }

  _setSize(px) {
    this.size = px;
    const v = document.getElementById('cs-size-val'); if (v) v.textContent = String(px);
    if (this.cursor) { this.cursor.style.width = `${px}px`; this.cursor.style.height = `${px}px`; }
    this._saveCfg();
  }

  // --- canvas backing store ---
  _resizeCanvas(preserve) {
    const w = window.innerWidth, h = window.innerHeight;
    if (preserve && this.canvas.width && this.canvas.height) {
      // Keep the painted shape across a window resize by rescaling the old bitmap.
      const tmp = document.createElement('canvas');
      tmp.width = this.canvas.width; tmp.height = this.canvas.height;
      tmp.getContext('2d').drawImage(this.canvas, 0, 0);
      this.canvas.width = w; this.canvas.height = h;
      this.ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, w, h);
    } else {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  blackoutAll() {
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this._save();
  }
  revealAll() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this._save();
  }
  invert() {
    const w = this.canvas.width, h = this.canvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').drawImage(this.canvas, 0, 0);
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, w, h);                 // everything black …
    this.ctx.globalCompositeOperation = 'destination-out';
    this.ctx.drawImage(tmp, 0, 0);                 // … then erase where it WAS black → invert
    this.ctx.globalCompositeOperation = 'source-over';
    this._save();
  }

  // Soft round brush stamp at canvas (x, y). Reveal erases the black; hide paints it.
  // A radial gradient feathers the rim so the painted edge isn't a hard pixel cut.
  _stamp(x, y) {
    const r = Math.max(this.size / 2, 1);
    const g = this.ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.72, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    this.ctx.globalCompositeOperation = this.brushMode === 'reveal' ? 'destination-out' : 'source-over';
    this.ctx.fillStyle = g;
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.globalCompositeOperation = 'source-over';
  }

  // Stamp along last -> (x,y) so fast strokes leave no gaps.
  _stroke(x, y) {
    const last = this._last || { x, y };
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(this.size * 0.25, 2);
    const n = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i <= n; i++) this._stamp(last.x + dx * (i / n), last.y + dy * (i / n));
    this._last = { x, y };
  }

  // --- pointer (painting) — listeners are harmless when not painting (guarded), and
  // the overlay only receives events at all while body.brush-paint sets pointer-events
  // auto, so normal view rotation / hover is untouched the rest of the time.
  _wirePointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.painting) return;
      e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      this._drawing = true;
      this._last = { x: e.clientX, y: e.clientY };
      this._stamp(e.clientX, e.clientY);
      this._moveCursor(e.clientX, e.clientY);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.painting) return;
      this._moveCursor(e.clientX, e.clientY);
      if (this._drawing) { e.preventDefault(); this._stroke(e.clientX, e.clientY); }
    });
    const end = (e) => {
      if (!this._drawing) return;
      this._drawing = false; this._last = null;
      c.releasePointerCapture?.(e.pointerId);
      this._save();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }
  _moveCursor(x, y) {
    if (!this.cursor) return;
    this.cursor.style.left = `${x}px`;
    this.cursor.style.top = `${y}px`;
  }

  // --- control wiring ---
  _wireControls() {
    const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);
    on('cs-enable', 'change', (e) => this._setEnabled(e.target.checked));
    on('cs-paint', 'click', () => this._setPaint(!this.painting));
    on('cs-reveal', 'click', () => this._setBrushMode('reveal'));
    on('cs-hide', 'click', () => this._setBrushMode('hide'));
    const size = document.getElementById('cs-size');
    if (size) size.addEventListener('input', () => this._setSize(parseInt(size.value, 10)));
    on('cs-revealall', 'click', () => this.revealAll());
    on('cs-blackout', 'click', () => this.blackoutAll());
    on('cs-invert', 'click', () => this.invert());
  }

  // --- persistence ---
  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { localStorage.setItem(LS_MASK, this.canvas.toDataURL('image/png')); } catch { /* quota */ }
    }, 400);
  }
  _saveCfg() {
    try {
      localStorage.setItem(LS_CFG, JSON.stringify({ enabled: this.enabled, brushMode: this.brushMode, size: this.size }));
    } catch { /* ignore */ }
  }
  _loadCfg() {
    let cfg = {};
    try { cfg = JSON.parse(localStorage.getItem(LS_CFG)) || {}; } catch { /* ignore */ }
    this._setSize(Number.isFinite(cfg.size) ? cfg.size : this.size);
    const sizeEl = document.getElementById('cs-size'); if (sizeEl) sizeEl.value = this.size;
    this._setBrushMode(cfg.brushMode === 'hide' ? 'hide' : 'reveal');
    if (cfg.enabled) this._setEnabled(true);
  }
  _loadMask() {
    let data = null;
    try { data = localStorage.getItem(LS_MASK); } catch { /* ignore */ }
    if (!data) return;
    const img = new Image();
    img.onload = () => {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
    };
    img.src = data;
  }
}
