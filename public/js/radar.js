// radar.js — a top-down tactical map view for the desktop.
//
// This is NOT the sky dome. It's an explorable GEOGRAPHIC map (Web Mercator, the same
// projection Google/Apple/Bing Maps use): pan and zoom freely, an optional satellite or
// terrain basemap tile layer underneath, your own position marked (ownship), and every
// aircraft plotted at its REAL lat/lon. Range rings + a bearing readout stay anchored to
// YOUR location (they represent real distance from you, so they move with you if you
// pan away to look elsewhere). A track list + detail panel give the full picture.
//
// Visual language is a real tactical command-and-control (C2) common-operating-picture
// (MIL-STD-2525 track symbology): near-black, hairline chrome, neo-grotesque
// + mono type, one restrained accent for selection. Tracks are coloured by what they
// actually ARE (military / law / EMS / civilian) — never faked as hostile. The status
// strip reports REAL feed health (link nominal/stale/offline), not a costume
// classification banner — this is a real tool, not a simulation.
//
// Pure renderer: reads live AircraftLayer data + a basemap tile cache each frame, and
// owns its own canvas + a small self-built HTML control/status overlay (mirrors the
// self-contained-module pattern used by ceiling-brush.js). One performance.now() clock
// drives all motion; the hot per-frame path allocates minimally (track list rebuild is
// the only per-frame allocation, same as before).

import { lookAngles, DEG } from './coords.js';
import { emergencyFor } from './emergency.js';

// ADS-B emitter category → human label (radar detail panel).
const EMITTER = { A1: 'Light', A2: 'Small', A3: 'Large', A4: 'Large (high-wake)', A5: 'Heavy', A6: 'High-performance', A7: 'Rotorcraft', B1: 'Glider', B2: 'Balloon / airship', B4: 'UAV', B6: 'Spacecraft', C1: 'Emergency vehicle', C2: 'Service vehicle' };

const TAU = Math.PI * 2;
const KM_PER_NM = 1.852;
const TILE = 256;          // standard XYZ slippy-map tile size (px)
const MIN_ZOOM = 3, MAX_ZOOM = 18;
const TILE_CACHE_MAX = 500; // bound the client tile cache (a browsable world map has unbounded keys)

// Selectable display ranges (how far the outer range ring / data radius reaches), NM.
export const RADAR_RANGES_NM = [10, 20, 40, 80, 150, 250];

// Track styling per service category — colour + affiliation frame shape (MIL-STD-2525-
// flavoured: shape + colour redundancy so it reads in mono/night conditions).
const CAT = {
  mil: { color: '#3FCF6A', tag: 'MIL', frame: 'square' },
  law: { color: '#36C6E0', tag: 'LEO', frame: 'rect' },
  ems: { color: '#FFB020', tag: 'EMS', frame: 'diamond' },
  civ: { color: '#C6D4E0', tag: 'CIV', frame: 'dot' },
};
const ACCENT = '#E8552A';   // selection / active UI — never used for track affiliation
const SWEEP = '#21D3C9';    // sweep / ownship / live-feed accent
const GRID = '#21323a';
const GRID_HI = '#2f4a55';
const TEXT = '#E8ECEF';
const TEXT_DIM = '#7C8894';

// Basemap tile styles proxied by server/index.js (see the /api/tile route there for the
// upstream providers + the licensing note — Esri's public tile endpoints, widely used
// free-of-charge, but review their terms for YOUR specific redistribution context before
// a formal submission).
const BASEMAPS = {
  none: { label: 'NONE', attribution: '' },
  sat: { label: 'SATELLITE', attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  terrain: { label: 'TERRAIN', attribution: 'Map data © Esri' },
};

// --- Web Mercator (standard XYZ slippy-map projection, EPSG:3857) -----------------
// world pixel space at a given integer zoom: n = TILE * 2^zoom wide/tall, x=0..n East
// from the antimeridian, y=0..n North pole to South pole. Same maths Leaflet/Google/
// OSM use, so our tiles + track positions align with any standard tile provider.
function project(lat, lon, zoom) {
  const n = TILE * 2 ** zoom;
  const x = (lon + 180) / 360 * n;
  const s = Math.max(-0.9999, Math.min(0.9999, Math.sin(lat * DEG)));
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  return { x, y };
}
function unproject(x, y, zoom) {
  const n = TILE * 2 ** zoom;
  const lon = x / n * 360 - 180;
  const yFrac = 0.5 - y / n;
  const lat = Math.atan(Math.sinh(2 * Math.PI * yFrac)) / DEG;
  return { lat, lon };
}
// Standard Web Mercator ground resolution (m/px) at a latitude + integer zoom.
function metersPerPixel(lat, zoom) {
  return 156543.03392804097 * Math.cos(lat * DEG) / (2 ** zoom);
}
// Pick the integer zoom whose resolution best fits rangeNm into radiusPx.
function zoomForRange(rangeNm, radiusPx, lat) {
  const desiredMpp = (rangeNm * KM_PER_NM * 1000) / radiusPx;
  const z = Math.log2(156543.03392804097 * Math.cos(lat * DEG) / desiredMpp);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
}

export class RadarRenderer {
  // callbacks: { onObserverChange(obs), onRangeChange(nm), onCatFilter(cats), onDisplayChange(mode) }
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0; this.cx = 0; this.cy = 0;

    this.rangeNm = 80;
    this.zoom = 7;
    this.observer = { lat: 0, lon: 0, alt: 0 };  // real tracked position
    this.center = { lat: 0, lon: 0 };            // view/pan target (== observer unless panned)
    this.panned = false;
    this.basemap = 'none';
    this.sweepOn = true;
    this._needsFit = true;

    this._reduceMotion = typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (typeof matchMedia === 'function') {
      matchMedia('(prefers-reduced-motion: reduce)')
        .addEventListener?.('change', (e) => { this._reduceMotion = e.matches; });
    }

    this.active = false;
    this._tracks = [];
    this._hover = null;
    this._selected = null;
    this._placingLocation = false;
    this._tiles = new Map();       // "style/z/x/y" -> { img, loaded, failed }

    this._buildOverlay();
    this._wirePointer();
    this.resize();
  }

  // --- lifecycle ---------------------------------------------------------------
  // state: the app's shared state object, used once to seed the service-filter
  // checkboxes and feed status from the current app state when radar becomes active.
  setActive(on, state) {
    this.active = on;
    this.canvas.style.display = on ? 'block' : 'none';
    this.overlay.style.display = on ? 'block' : 'none';
    document.body.classList.toggle('radar-on', on);
    if (on) {
      this.resize();
      this._needsFit = true;
      if (state?.cats) this._syncCatCheckboxes(state.cats);
    }
  }
  setObserver(o) { if (o) this.observer = o; }
  setRange(nm) { this._applyRange(nm); }
  setSweep(on) {
    this.sweepOn = on;
    const cb = document.getElementById('rdr-sweep-cb'); if (cb) cb.checked = on;
  }
  setFeedStatus(status) {
    // 'nominal' | 'stale' | 'offline' — an HONEST link-health readout (no classification
    // theatre: this is a real tool, so the status strip reports what's actually true).
    this._feedStatus = status;
  }

  _applyRange(nm) {
    this.rangeNm = nm;
    const fitRadiusPx = Math.min(this.w, this.h) * 0.42 || 300;
    this.zoom = zoomForRange(nm, fitRadiusPx, this.observer.lat || 0);
    this.center = { lat: this.observer.lat, lon: this.observer.lon };
    this.panned = false;
    const seg = document.getElementById('rdr-range');
    if (seg) for (const b of seg.querySelectorAll('[data-nm]')) b.classList.toggle('active', parseInt(b.dataset.nm, 10) === nm);
  }
  _recenter() { this._applyRange(this.rangeNm); }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w; this.h = h;
    this.cx = Math.round(w / 2);
    this.cy = Math.round(h / 2);
  }

  // --- coordinate helpers (screen <-> lat/lon through the current pan/zoom) ---
  _latLonToScreen(lat, lon) {
    const wc = project(this.center.lat, this.center.lon, this.zoom);
    const w = project(lat, lon, this.zoom);
    return { x: this.cx + (w.x - wc.x), y: this.cy + (w.y - wc.y) };
  }
  _screenToLatLon(px, py) {
    const wc = project(this.center.lat, this.center.lon, this.zoom);
    return unproject(wc.x + (px - this.cx), wc.y + (py - this.cy), this.zoom);
  }
  _ringRadiusPx(nm) {
    return (nm * KM_PER_NM * 1000) / metersPerPixel(this.observer.lat, this.zoom);
  }

  // --- main render -------------------------------------------------------------
  render(t, aircraft, observer, state) {
    if (!this.active) return;
    if (observer) {
      this.observer = observer;
      if (!this.panned) this.center = { lat: observer.lat, lon: observer.lon };
    }
    if (this._needsFit) { this._applyRange(this.rangeNm); this._needsFit = false; }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#0A0C0E';
    ctx.fillRect(0, 0, this.w, this.h);

    this._drawBasemap(ctx);
    this._drawRingsAndCompass(ctx);

    const sweep = this.sweepOn && !this._reduceMotion;
    if (sweep) this._drawSweep(ctx, t);

    this._collect(aircraft, state);

    const sweepA = sweep ? ((t / 5000) % 1) * TAU : -1;
    for (const tr of this._tracks) this._drawTrack(ctx, tr, t, sweepA);

    this._drawOwnship(ctx);
    this._drawLabels(ctx);
    this._corners(ctx);

    if (t - (this._lastChrome || 0) > 250) {
      this._updateStatus();
      this._updateTrackList();
      this._lastChrome = t;
    }
    this._updateDetail();
  }

  // --- basemap (Web Mercator tile mosaic, proxied through /api/tile) -----------
  _drawBasemap(ctx) {
    if (this.basemap === 'none') return;
    const wc = project(this.center.lat, this.center.lon, this.zoom);
    const left = wc.x - this.w / 2, top = wc.y - this.h / 2;
    const n = 2 ** this.zoom;
    const tx0 = Math.floor(left / TILE), tx1 = Math.floor((left + this.w) / TILE);
    const ty0 = Math.max(0, Math.floor(top / TILE));
    const ty1 = Math.min(n - 1, Math.floor((top + this.h) / TILE));

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = (((tx % n) + n) % n);           // world wraps horizontally
        const img = this._getTile(this.basemap, this.zoom, wx, ty);
        const sx = tx * TILE - left, sy = ty * TILE - top;
        if (img && img.loaded) ctx.drawImage(img.img, sx, sy, TILE, TILE);
      }
    }
  }
  _getTile(style, z, x, y) {
    const key = `${style}/${z}/${x}/${y}`;
    let t = this._tiles.get(key);
    if (t) return t;
    t = { img: new Image(), loaded: false, failed: false };
    t.img.onload = () => { t.loaded = true; };
    t.img.onerror = () => { t.failed = true; };
    t.img.src = `/api/tile/${style}/${z}/${x}/${y}`;
    if (this._tiles.size >= TILE_CACHE_MAX) this._tiles.delete(this._tiles.keys().next().value);
    this._tiles.set(key, t);
    return t;
  }

  // --- range rings + compass badge (anchored to the REAL observer position) ---
  _drawRingsAndCompass(ctx) {
    const own = this._latLonToScreen(this.observer.lat, this.observer.lon);
    ctx.font = '10px "IBM Plex Mono","Roboto Mono",ui-monospace,monospace';
    ctx.textBaseline = 'middle';
    for (let i = 1; i <= 4; i++) {
      const nm = (this.rangeNm * i) / 4;
      const rr = this._ringRadiusPx(nm);
      ctx.strokeStyle = i === 4 ? GRID_HI : GRID;
      ctx.lineWidth = i === 4 ? 1.4 : 1;
      ctx.beginPath(); ctx.arc(own.x, own.y, rr, 0, TAU); ctx.stroke();
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(`${nm % 1 ? nm.toFixed(0) : nm}NM`, own.x + 4, own.y - rr - 1);
    }
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    const R = this._ringRadiusPx(this.rangeNm);
    ctx.beginPath();
    ctx.moveTo(own.x - R, own.y); ctx.lineTo(own.x + R, own.y);
    ctx.moveTo(own.x, own.y - R); ctx.lineTo(own.x, own.y + R); ctx.stroke();

    // small fixed north-up compass badge (map doesn't rotate, so a static "N" suffices —
    // a full bearing-tick ring around the whole viewport isn't needed on a real map)
    const bx = this.w - 38, by = 54;
    ctx.strokeStyle = GRID_HI; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(bx, by, 18, 0, TAU); ctx.stroke();
    ctx.strokeStyle = ACCENT; ctx.beginPath(); ctx.moveTo(bx, by + 12); ctx.lineTo(bx, by - 12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx, by - 12); ctx.lineTo(bx - 3.5, by - 5); ctx.lineTo(bx + 3.5, by - 5); ctx.closePath();
    ctx.fillStyle = ACCENT; ctx.fill();
    ctx.fillStyle = TEXT_DIM; ctx.textAlign = 'center';
    ctx.fillText('N', bx, by - 17); ctx.textAlign = 'left';
  }

  _drawSweep(ctx, t) {
    const own = this._latLonToScreen(this.observer.lat, this.observer.lon);
    const a = ((t / 5000) % 1) * TAU;
    const R = Math.max(this.w, this.h);            // sweep the whole viewport, not just the ring
    ctx.save();
    ctx.translate(own.x, own.y); ctx.rotate(a);
    const seg = 22, span = 0.95;
    for (let i = 0; i < seg; i++) {
      const a0 = -span * (i / seg), a1 = -span * ((i + 1) / seg);
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a0 - Math.PI / 2, a1 - Math.PI / 2, true);
      ctx.closePath();
      ctx.fillStyle = SWEEP; ctx.globalAlpha = 0.08 * (1 - i / seg);
      ctx.fill();
    }
    ctx.globalAlpha = 0.5; ctx.strokeStyle = SWEEP; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -R); ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  _drawOwnship(ctx) {
    const { x, y } = this._latLonToScreen(this.observer.lat, this.observer.lon);
    ctx.strokeStyle = SWEEP; ctx.fillStyle = SWEEP; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 7); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y + 2);
    ctx.lineTo(x - 5, y + 5); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- track collection (geo-plotted via the same Mercator projection as the basemap) --
  _collect(aircraft, state) {
    const tracks = this._tracks;
    tracks.length = 0;
    if (!aircraft || !aircraft.planes) return;
    if (state && state.layers && state.layers.aircraft === false) return;
    const cats = state?.cats || { mil: true, law: true, ems: true, civ: true };
    const rangeM = this.rangeNm * KM_PER_NM * 1000;
    const obs = this.observer;

    for (const [, e] of aircraft.planes) {
      const cat = e.category || 'civ';
      if (!cats[cat]) continue;
      const p = e.render || e.cur;
      if (!p || p.lat == null) continue;
      const look = lookAngles(obs, { lat: p.lat, lon: p.lon, alt: 0 });
      if (look.range > rangeM) continue;            // stay tied to the real data-fetch radius
      const { x, y } = this._latLonToScreen(p.lat, p.lon);
      tracks.push({
        id: e.id, entry: e, cat, x, y,
        brgDeg: look.azimuth, rangeNm: look.range / 1000 / KM_PER_NM,
        hdg: e.state?.heading ?? null,
        spdKt: e.state?.velocity != null ? e.state.velocity * 1.94384 : null,
        altFt: p.alt != null ? p.alt * 3.28084 : null,
        call: (e.state?.callsign || '').trim() || e.id,
        emg: emergencyFor(e.state?.squawk),
      });
    }
    tracks.sort((a, b) => a.rangeNm - b.rangeNm);
  }

  // --- track glyphs ------------------------------------------------------------
  _drawTrack(ctx, tr, t, sweepA) {
    const st = CAT[tr.cat] || CAT.civ;
    const col = tr.emg ? tr.emg.hex : st.color;   // emergency squawk overrides the affiliation colour
    const sel = tr.id === this._selected;
    const hov = tr.id === this._hover;
    const x = tr.x, y = tr.y;

    let alpha = 1;
    if (sweepA >= 0) {
      let d = Math.abs(((tr.brgDeg * DEG - sweepA + Math.PI * 3) % TAU) - Math.PI);
      alpha = 0.85 + 0.15 * Math.max(0, 1 - d / 0.5);
    }
    ctx.globalAlpha = alpha;

    if (tr.hdg != null) {
      const len = tr.spdKt != null ? Math.max(12, Math.min(46, tr.spdKt / 12)) : 14;
      const a = tr.hdg * DEG;
      ctx.strokeStyle = col; ctx.globalAlpha = alpha * 0.7; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + len * Math.sin(a), y - len * Math.cos(a)); ctx.stroke();
      ctx.globalAlpha = alpha;
    }

    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
    const s = tr.cat === 'civ' ? 6 : 8;
    ctx.beginPath();
    switch (st.frame) {
      case 'square': ctx.rect(x - s, y - s, s * 2, s * 2); ctx.stroke(); break;
      case 'rect':
        ctx.moveTo(x - s, y + s); ctx.lineTo(x - s, y - s * 0.4);
        ctx.quadraticCurveTo(x - s, y - s, x, y - s);
        ctx.quadraticCurveTo(x + s, y - s, x + s, y - s * 0.4);
        ctx.lineTo(x + s, y + s); ctx.lineTo(x - s, y + s); ctx.stroke(); break;
      case 'diamond':
        ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s);
        ctx.lineTo(x - s, y); ctx.closePath(); ctx.stroke(); break;
      default:
        ctx.fillStyle = 'rgba(6,9,12,0.6)';           // dark halo so light dots read over satellite imagery
        ctx.arc(x, y, s + 1.8, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.fillStyle = col;
        ctx.arc(x, y, s, 0, TAU); ctx.fill(); break;
    }

    // Emergency: a pulsing ring around the track, colour-ramped by severity.
    if (tr.emg) {
      const pr = s + 7 + 3 * (0.5 + 0.5 * Math.sin(t * 0.006 * (1 + tr.emg.sev)));
      ctx.globalAlpha = 0.9; ctx.strokeStyle = tr.emg.hex; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.stroke(); ctx.globalAlpha = alpha;
    }

    if (hov && !sel) { ctx.globalAlpha = 1; ctx.strokeStyle = TEXT; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, s + 5, 0, TAU); ctx.stroke(); }
    if (sel) this._selBrackets(ctx, x, y, s + 6, t);
    ctx.globalAlpha = 1;
  }

  _selBrackets(ctx, x, y, r, t) {
    const p = r + 2 + (this._reduceMotion ? 0 : Math.sin(t * 0.006) * 1.5);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2;
    const leg = 6;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * p, y + sy * p - sy * leg);
      ctx.lineTo(x + sx * p, y + sy * p);
      ctx.lineTo(x + sx * p - sx * leg, y + sy * p);
      ctx.stroke();
    }
  }

  _drawLabels(ctx) {
    ctx.font = '11px "IBM Plex Mono","Roboto Mono",ui-monospace,monospace';
    ctx.textBaseline = 'middle';
    const placed = [];
    const showAll = this._tracks.length <= 40;
    for (const tr of this._tracks) {
      const sel = tr.id === this._selected, hov = tr.id === this._hover;
      if (!sel && !hov && !showAll) continue;
      const tx = tr.x + 12, ty = tr.y - 12;
      let clash = false;
      for (const q of placed) { if (Math.abs(q.x - tx) < 70 && Math.abs(q.y - ty) < 14) { clash = true; break; } }
      if (clash && !sel && !hov) continue;
      placed.push({ x: tx, y: ty });
      const st = CAT[tr.cat] || CAT.civ;
      ctx.strokeStyle = TEXT_DIM; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tr.x, tr.y); ctx.lineTo(tx - 2, ty); ctx.stroke();
      ctx.fillStyle = TEXT_DIM; ctx.beginPath(); ctx.arc(tr.x, tr.y, 1.5, 0, TAU); ctx.fill();
      const datum = `${tr.rangeNm.toFixed(0)}NM ${tr.altFt != null ? Math.round(tr.altFt / 100) * 100 / 1000 + 'k' : ''}`.trim();
      ctx.fillStyle = sel ? ACCENT : st.color;
      ctx.fillText(tr.call, tx, ty);
      ctx.fillStyle = TEXT_DIM;
      ctx.fillText(datum, tx, ty + 12);
    }
  }

  _corners(ctx) {
    ctx.strokeStyle = GRID_HI; ctx.lineWidth = 1;
    const m = 14, leg = 20, w = this.w, h = this.h;
    for (const [cx, cy, sx, sy] of [[m, m, 1, 1], [w - m, m, -1, 1], [w - m, h - m, -1, -1], [m, h - m, 1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy + sy * leg); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * leg, cy);
      ctx.stroke();
    }
  }

  // --- HTML overlay: controls (location/range/basemap/filter/sweep/view) + status/list/detail --
  _buildOverlay() {
    const el = document.createElement('div');
    el.id = 'radar-ui';
    const rangeOpts = RADAR_RANGES_NM.map((nm) => `<button type="button" data-nm="${nm}"${nm === 80 ? ' class="active"' : ''}>${nm}</button>`).join('');
    el.innerHTML = `
      <div id="rdr-status">
        <span class="rdr-brand"><i class="rdr-mark"></i><b>LIVELYSKY</b><span class="rdr-mode">Tactical Scope</span></span>
        <span class="rdr-sys"><i class="dot"></i><span id="rdr-feed">ADS-B LINK</span></span>
        <span id="rdr-clock" class="data"></span>
      </div>

      <div id="rdr-controls" class="panel">
        <div class="rdr-c-head">TACTICAL SCOPE</div>

        <div class="rdr-grp">
          <div class="rdr-grp-h">Location · Ownship</div>
          <div class="rdr-row2">
            <input id="rdr-lat" class="data" type="number" step="0.0001" placeholder="Lat" />
            <input id="rdr-lon" class="data" type="number" step="0.0001" placeholder="Lon" />
          </div>
          <div class="rdr-btnrow">
            <button id="rdr-loc-set" type="button">Set</button>
            <button id="rdr-loc-me" type="button">My location</button>
          </div>
          <button id="rdr-loc-pick" type="button" class="rdr-wide">Pick location on map</button>
        </div>

        <div class="rdr-grp">
          <div class="rdr-grp-h">Range · Outer Ring (NM)</div>
          <div class="rdr-seg" id="rdr-range">${rangeOpts}</div>
          <button id="rdr-recenter" type="button" class="rdr-wide">Recentre on ownship</button>
        </div>

        <div class="rdr-grp">
          <div class="rdr-grp-h">Basemap · Imagery</div>
          <div class="rdr-btnrow" id="rdr-basemap">
            <button type="button" data-bm="none" class="active">None</button>
            <button type="button" data-bm="sat">Satellite</button>
            <button type="button" data-bm="terrain">Terrain</button>
          </div>
        </div>

        <div class="rdr-grp">
          <div class="rdr-grp-h">Service Filter</div>
          <div class="rdr-chips">
            <label><input type="checkbox" data-rcat="mil" checked /> Military <i class="swatch" style="background:#3fcf6a"></i></label>
            <label><input type="checkbox" data-rcat="law" checked /> Law enforcement <i class="swatch" style="background:#36c6e0"></i></label>
            <label><input type="checkbox" data-rcat="ems" checked /> EMS / Fire <i class="swatch" style="background:#ffb020"></i></label>
            <label><input type="checkbox" data-rcat="civ" checked /> Civilian <i class="swatch" style="background:#c6d4e0"></i></label>
          </div>
        </div>

        <div class="rdr-grp">
          <label class="rdr-row2"><input type="checkbox" id="rdr-sweep-cb" checked /> Sweep</label>
        </div>

        <div class="rdr-grp">
          <div class="rdr-grp-h">View</div>
          <div class="rdr-btnrow">
            <button type="button" data-mode="ceiling">Ceiling</button>
            <button type="button" data-mode="fisheye">Fisheye</button>
            <button type="button" data-mode="free">Free</button>
          </div>
        </div>
      </div>

      <div id="rdr-attrib"></div>

      <div id="rdr-tracklist">
        <div class="rdr-tl-head">
          <span>ID</span><span>SVC</span><span>BRG</span><span>RNG</span><span>ALT</span><span>SPD</span>
        </div>
        <div id="rdr-tl-rows"></div>
      </div>
      <div id="rdr-detail" hidden></div>`;
    document.body.appendChild(el);
    el.style.display = 'none';
    this.overlay = el;

    this._elClock = el.querySelector('#rdr-clock');
    this._elFeed = el.querySelector('#rdr-feed');
    this._elFeedDot = el.querySelector('#rdr-status .dot');
    this._elRows = el.querySelector('#rdr-tl-rows');
    this._elDetail = el.querySelector('#rdr-detail');
    this._elAttrib = el.querySelector('#rdr-attrib');
    this._elLat = el.querySelector('#rdr-lat');
    this._elLon = el.querySelector('#rdr-lon');
    this._elPick = el.querySelector('#rdr-loc-pick');

    this._elRows.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (row) { this._selected = row.dataset.id; this._updateTrackList(); this._updateDetail(); }
    });

    el.querySelector('#rdr-loc-set').addEventListener('click', () => {
      const lat = parseFloat(this._elLat.value), lon = parseFloat(this._elLon.value);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        this.cb.onObserverChange?.({ lat, lon, alt: this.observer.alt || 0 });
      }
    });
    el.querySelector('#rdr-loc-me').addEventListener('click', () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition((pos) => {
        this.cb.onObserverChange?.({
          lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 0,
        });
      });
    });
    this._elPick.addEventListener('click', () => {
      this._placingLocation = !this._placingLocation;
      this._elPick.classList.toggle('active', this._placingLocation);
      this._elPick.textContent = this._placingLocation ? 'Click the map to set…' : 'Pick location on map';
    });

    const rangeEl = el.querySelector('#rdr-range');
    rangeEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nm]');
      if (btn) this.cb.onRangeChange?.(parseInt(btn.dataset.nm, 10));
    });
    el.querySelector('#rdr-recenter').addEventListener('click', () => this._recenter());

    el.querySelector('#rdr-basemap').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bm]');
      if (!btn) return;
      this.setBasemap(btn.dataset.bm);
    });

    const catBoxes = [...el.querySelectorAll('[data-rcat]')];
    for (const cb of catBoxes) {
      cb.addEventListener('change', () => {
        const cats = {};
        for (const b of catBoxes) cats[b.dataset.rcat] = b.checked;
        this.cb.onCatFilter?.(cats);
      });
    }

    const sweepCb = el.querySelector('#rdr-sweep-cb');
    sweepCb.addEventListener('change', () => { this.sweepOn = sweepCb.checked; });

    el.querySelector('[data-mode="ceiling"]').closest('.rdr-btnrow').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (btn) this.cb.onDisplayChange?.(btn.dataset.mode);
    });
  }

  setBasemap(mode) {
    this.basemap = mode;
    const el = this.overlay?.querySelector('#rdr-basemap');
    if (el) for (const b of el.querySelectorAll('[data-bm]')) b.classList.toggle('active', b.dataset.bm === mode);
    if (this._elAttrib) this._elAttrib.textContent = BASEMAPS[mode]?.attribution || '';
  }

  _syncCatCheckboxes(cats) {
    for (const b of this.overlay.querySelectorAll('[data-rcat]')) {
      b.checked = cats[b.dataset.rcat] !== false;
    }
  }

  _updateStatus() {
    const d = new Date();
    const z = (n) => String(n).padStart(2, '0');
    this._elClock.textContent =
      `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}Z  ` +
      `${this.observer.lat.toFixed(3)} ${this.observer.lon.toFixed(3)}`;
    const n = this._tracks.length;
    const statusText = { nominal: 'ADS-B: NOMINAL', stale: 'ADS-B: STALE', offline: 'ADS-B: OFFLINE' }[this._feedStatus] || 'ADS-B LINK';
    this._elFeed.textContent = `${statusText} · ${n} TRK · ${this.rangeNm}NM`;
    const dotColor = { nominal: '#3FCF6A', stale: '#FFB020', offline: '#FF3B47' }[this._feedStatus] || SWEEP;
    if (this._elFeedDot) { this._elFeedDot.style.background = dotColor; this._elFeedDot.style.boxShadow = `0 0 6px ${dotColor}`; }
    // keep the location inputs current (unless the user is actively editing them)
    if (document.activeElement !== this._elLat) this._elLat.value = this.observer.lat.toFixed(4);
    if (document.activeElement !== this._elLon) this._elLon.value = this.observer.lon.toFixed(4);
  }

  _updateTrackList() {
    const rows = this._tracks.slice(0, 40).map((tr) => {
      const st = CAT[tr.cat] || CAT.civ;
      const col = tr.emg ? tr.emg.hex : st.color;
      const sel = tr.id === this._selected ? ' sel' : '';
      return `<div class="rdr-tl-row${sel}" data-id="${tr.id}">` +
        `<span class="id" style="color:${col}">${tr.emg ? '⚠ ' : ''}${esc(tr.call)}</span>` +
        `<span style="color:${col}">${tr.emg ? tr.emg.code : st.tag}</span>` +
        `<span class="data">${String(Math.round(tr.brgDeg)).padStart(3, '0')}</span>` +
        `<span class="data">${tr.rangeNm.toFixed(0)}</span>` +
        `<span class="data">${tr.altFt != null ? Math.round(tr.altFt / 100) * 100 : '—'}</span>` +
        `<span class="data">${tr.spdKt != null ? Math.round(tr.spdKt) : '—'}</span></div>`;
    }).join('');
    this._elRows.innerHTML = rows || '<div class="rdr-tl-empty">— NO TRACKS IN RANGE —</div>';
  }

  _updateDetail() {
    const id = this._selected;
    const tr = id ? this._tracks.find((tt) => tt.id === id) : null;
    if (!tr) { this._elDetail.hidden = true; return; }
    const e = tr.entry, info = e.info || {};
    const st = CAT[tr.cat] || CAT.civ;
    const emg = tr.emg;
    const headCol = emg ? emg.hex : st.color;
    const type = info?.aircraft?.type || e.state?.type || '—';
    const mfr = info?.aircraft?.manufacturer;
    const reg = info?.aircraft?.registration || e.state?.registration || '—';
    const op = info?.aircraft?.owner || info?.route?.airline || '—';
    const airline = info?.route?.airline;
    const ap = (a) => (a ? `${a.iata || a.icao || '?'}${a.municipality ? ' ' + a.municipality : ''}` : '?');
    const route = info?.route ? `${ap(info.route.origin)} → ${ap(info.route.destination)}` : '—';
    const vr = e.state?.verticalRate;
    const vs = (vr != null && Math.abs(vr) > 0.4) ? `${vr > 0 ? '▲' : '▼'} ${Math.abs(Math.round(vr * 196.85)).toLocaleString()} FPM` : 'LEVEL';
    this._elDetail.hidden = false;
    this._elDetail.innerHTML =
      `<div class="rdr-d-head" style="border-color:${headCol}">` +
      `<span style="color:${headCol}">${emg ? '⚠ ' : ''}${esc(tr.call)}</span>` +
      `<span class="svc">${emg ? emg.code + ' ' + esc(emg.label) : st.tag}</span></div>` +
      (emg ? row('DISTRESS', `<b style="color:${emg.hex}">${emg.code} ${esc(emg.label)} · ${esc(emg.reason)}</b>`) : '') +
      row('TYPE', esc(mfr ? `${mfr} ${type}` : type)) + row('REG', esc(reg)) +
      row('OPERATOR', esc(op)) + (airline && airline !== op ? row('AIRLINE', esc(airline)) : '') +
      row('ROUTE', esc(route)) +
      row('SQUAWK', emg ? `<b style="color:${emg.hex}">${esc(e.state.squawk)}</b>` : esc(e.state?.squawk || '—')) +
      row('V/S', esc(vs)) +
      row('CATEGORY', esc(EMITTER[e.state?.category] || '—')) +
      row('ICAO24', esc(String(tr.id).toUpperCase())) +
      row('BEARING', String(Math.round(tr.brgDeg)).padStart(3, '0') + '°') +
      row('RANGE', tr.rangeNm.toFixed(1) + ' NM') +
      row('ALT', tr.altFt != null ? Math.round(tr.altFt).toLocaleString() + ' FT' : '—') +
      row('SPEED', tr.spdKt != null ? Math.round(tr.spdKt) + ' KT' : '—') +
      row('HEADING', tr.hdg != null ? String(Math.round(tr.hdg)).padStart(3, '0') + '°' : '—');
  }

  // --- pointer: click = select/deselect/place-location; drag = pan; wheel = zoom ---
  _wirePointer() {
    const c = this.canvas;
    let down = null;

    c.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, moved: false, startCenter: { ...this.center } };
      c.setPointerCapture?.(e.pointerId);
    });

    c.addEventListener('pointermove', (e) => {
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) down.moved = true;
        if (down.moved && !this._placingLocation) {
          const w0 = project(down.startCenter.lat, down.startCenter.lon, this.zoom);
          this.center = unproject(w0.x - dx, w0.y - dy, this.zoom);
          this.panned = true;
        }
      }
      this._hover = down?.moved ? null : this._hit(e.clientX, e.clientY);
      c.style.cursor = this._placingLocation ? 'crosshair' : (this._hover ? 'pointer' : (down ? 'grabbing' : 'grab'));
    });

    const finish = (e) => {
      if (down && !down.moved) {
        if (this._placingLocation) {
          const { lat, lon } = this._screenToLatLon(e.clientX, e.clientY);
          this.cb.onObserverChange?.({ lat, lon, alt: this.observer.alt || 0 });
          this._placingLocation = false;
          this._elPick.classList.remove('active');
          this._elPick.textContent = 'Pick location on map';
        } else {
          const id = this._hit(e.clientX, e.clientY);
          this._selected = id || null;
        }
      }
      down = null;
      c.releasePointerCapture?.(e.pointerId);
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', () => { down = null; });
    c.addEventListener('pointerleave', () => { this._hover = null; });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + (e.deltaY < 0 ? 1 : -1)));
    }, { passive: false });
  }

  _hit(px, py) {
    let best = null, bestD = 16 * 16;
    for (const tr of this._tracks) {
      const dx = tr.x - px, dy = tr.y - py, d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = tr.id; }
    }
    return best;
  }
}

function row(k, v) { return `<div class="rdr-d-row"><span>${k}</span><span class="data">${v}</span></div>`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
