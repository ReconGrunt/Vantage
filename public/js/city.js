// city.js — the Ground/City domain view: a top-down GEOGRAPHIC common-operating-picture
// of what's happening on the ground right now. It reuses the radar scope's Web-Mercator
// engine (same project()/unproject(), same /api/tile basemaps) but plots normalized
// city Events (fire/medical/police/traffic/hazard/quake/weather/social/civic/outage)
// and public Cameras instead of aircraft, with a client-side HOTSPOT heat overlay.
//
// Same design language + honesty rules as radar.js: near-black, hairline chrome, teal =
// live, amber = the selected item; the status strip reports REAL per-source feed health
// (which feeds are nominal / stale / offline), never a costume. Controls live in the one
// shared command panel (ui.js drives the public methods here); this module owns only the
// map-side chrome (status strip, event list, detail, camera popup, hotspot board, log).

import { project, unproject } from './radar.js';
import { computeHotspots } from './hotspots.js';
import { groundKind, GROUND_SEVERITY } from './emergency.js';

const TAU = Math.PI * 2;
const TILE = 256;
const MIN_ZOOM = 3, MAX_ZOOM = 18;
const TILE_CACHE_MAX = 500;
const DEG = Math.PI / 180;

const ACCENT = '#E8552A';   // selection / attention (rare)
const LIVE = '#21D3C9';     // live / ownship / nominal
const TEXT = '#E8ECEF', TEXT_DIM = '#7C8894', TEXT_MUTE = '#5A6672';
const GRID = '#21323a', GRID_HI = '#2f4a55';

const BASEMAPS = {
  none: { attribution: '' },
  sat: { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  terrain: { attribution: 'Map data © Esri' },
};

function haversineKm(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * DEG, dLon = (bLon - aLon) * DEG;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}
function metersPerPixel(lat, zoom) { return 156543.03392804097 * Math.cos(lat * DEG) / (2 ** zoom); }
function zoomForRange(rangeKm, radiusPx, lat) {
  const desiredMpp = (rangeKm * 1000) / radiusPx;
  const z = Math.log2(156543.03392804097 * Math.cos(lat * DEG) / desiredMpp);
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
}
function ageStr(ms) {
  const s = Math.max(0, ms / 1000);
  if (s < 90) return Math.round(s) + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Co-located feeds ("Oat Mtn. North 1", "Oat Mtn. South 2", …) share ONE site pin. The
// site's display name is the longest common prefix of its feed names ("Oat Mtn."); each
// feed's label is what remains ("North 1"). Mixed-provider coincidences with no common
// prefix fall back to the first feed's full name.
function siteNames(cams) {
  if (cams.length === 1) return { site: cams[0].name, labels: [cams[0].name] };
  let pre = cams[0].name;
  for (const c of cams.slice(1)) {
    while (pre && !c.name.startsWith(pre)) pre = pre.slice(0, -1);
  }
  pre = pre.replace(/[\s\-–—:/]+$/, '');
  if (pre.length < 4) return { site: `${cams[0].name} +${cams.length - 1}`, labels: cams.map((c) => c.name) };
  return { site: pre, labels: cams.map((c) => c.name.slice(pre.length).trim() || c.name) };
}

export class CityRenderer {
  // callbacks: { onObserverChange(obs), onDisplayChange(mode), onPickModeChange(bool) }
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = 0; this.h = 0; this.cx = 0; this.cy = 0;

    this.rangeKm = 25;
    this.zoom = 12;
    this.observer = { lat: 0, lon: 0, alt: 0 };
    this.center = { lat: 0, lon: 0 };
    this.panned = false;
    this.basemap = 'sat';
    this.windowMin = 1440;
    this._needsFit = true;

    // layer toggles: every ground kind + the camera & heat overlays
    this.layers = {
      fire: true, medical: true, police: true, traffic: true, hazard: true, quake: true,
      weather: true, 'fire-wildland': true, social: true, civic: true, outage: true,
    };
    this.showCameras = true;
    this.showHeat = true;
    this.showCones = true;     // PTZ camera view-direction wedges

    this.active = false;
    this.events = [];
    this.cameras = [];
    this.sources = [];
    this.camSources = [];      // per-source health for the CAMERA feeds (from /api/cameras)
    this.catalog = [];
    this.hotspots = { ranked: [], maxScore: 0 };
    this._visEvents = [];
    this._markers = [];
    this._camSites = [];       // cameras grouped by site (co-located feeds collapse to ONE pin)
    this._camMarkers = [];
    this._hover = null;
    this._selected = null;
    this._selSite = null;      // key of the site whose grid popup is open
    this._camFeeds = [];       // live feeds in the open grid popup
    this._tab = 'events';      // the one list panel shows Events, Hotspots or Cameras
    this._placingLocation = false;
    this._tiles = new Map();
    this._feedTs = 0;
    this._stale = false;

    this._reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._buildOverlay();
    this._wirePointer();
    this.resize();
  }

  // --- lifecycle -----------------------------------------------------------------
  setActive(on) {
    this.active = on;
    this.canvas.style.display = on ? 'block' : 'none';
    this.overlay.style.display = on ? 'block' : 'none';
    document.body.classList.toggle('city-on', on);
    if (on) { this.resize(); this._needsFit = true; this._recompute(); }
  }
  // A NEW location must re-anchor the view. Without this, any manual pan — dragging the
  // map, clicking a hotspot, or just selecting an event in the list — latches `panned`,
  // and render() then refuses to recentre, so the next city's events load but draw
  // off-screen and get culled. That reads as "no refresh is happening".
  setObserver(o) {
    if (!o) return;
    const moved = !this.observer
      || Math.abs(o.lat - this.observer.lat) > 1e-6
      || Math.abs(o.lon - this.observer.lon) > 1e-6;
    this.observer = o;
    if (moved) { this.panned = false; this._needsFit = true; this._lastChrome = 0; }
  }

  setData({ events, cameras, sources, camSources, stale }) {
    if (Array.isArray(events)) this.events = events;
    if (Array.isArray(cameras) && cameras !== this.cameras) { this.cameras = cameras; this._groupCameras(); }
    if (Array.isArray(sources)) this.sources = sources;
    if (Array.isArray(camSources)) this.camSources = camSources;
    this._stale = !!stale;
    this._feedTs = performance.now();
    this._recompute();
    this._logNewIncidents();
    this._lastChrome = 0; // force a chrome refresh next frame
  }

  // Group the raw camera list into SITE pins: feeds sharing a pole (rounded to ~11 m)
  // collapse into one marker with a count badge, and the popup shows ALL of them. This
  // is what makes a 4-head wildfire site (e.g. Oat Mtn.) reachable — before grouping,
  // the feeds stacked into a single pin and only one was clickable.
  _groupCameras() {
    const map = new Map();
    for (const c of this.cameras) {
      const key = `${c.lat.toFixed(4)},${c.lon.toFixed(4)}`;
      let s = map.get(key);
      if (!s) { s = { key, lat: 0, lon: 0, cams: [], name: '', labels: [] }; map.set(key, s); }
      s.cams.push(c);
    }
    for (const s of map.values()) {
      let la = 0, lo = 0;
      for (const c of s.cams) { la += c.lat; lo += c.lon; }
      s.lat = la / s.cams.length; s.lon = lo / s.cams.length;
      s.cams.sort((a, b) => a.name.localeCompare(b.name));
      const { site, labels } = siteNames(s.cams);
      s.name = site; s.labels = labels;
    }
    this._camSites = [...map.values()];
    this._heatDirty = true;
  }

  setRange(km) { this.rangeKm = km; this._fit(); }
  setBasemap(mode) { this.basemap = mode; if (this._elAttrib) this._elAttrib.textContent = BASEMAPS[mode]?.attribution || ''; }
  setWindow(min) { this.windowMin = min; this._recompute(); this._lastChrome = 0; }
  setLayer(kind, on) { if (kind in this.layers) this.layers[kind] = on; this._recompute(); this._lastChrome = 0; }
  setShowCameras(on) { this.showCameras = on; }
  setShowHeat(on) { this.showHeat = on; }
  setShowCones(on) { this.showCones = on; }
  setCatalog(list) { this.catalog = Array.isArray(list) ? list : []; this._lastChrome = 0; }
  recenter() { this._fit(); }
  togglePickMode() { this._placingLocation = !this._placingLocation; return this._placingLocation; }

  _fit() {
    const fitRadiusPx = Math.min(this.w, this.h) * 0.44 || 320;
    this.zoom = zoomForRange(this.rangeKm, fitRadiusPx, this.observer.lat || 0);
    this.center = { lat: this.observer.lat, lon: this.observer.lon };
    this.panned = false;
  }

  _recompute() {
    const now = Date.now();
    const cutoff = this.windowMin > 0 ? now - this.windowMin * 60_000 : 0;
    this._visEvents = this.events.filter((e) => {
      if (this.layers[e.kind] === false) return false;
      if ((e.ts || now) >= cutoff) return true;
      // Ongoing conditions stay visible while still in effect. A road closure that began
      // weeks ago but runs until tomorrow is live RIGHT NOW — filtering it out by start
      // time would hide active closures from any short window.
      return e.expiresTs != null && e.expiresTs > now;
    });
    const kinds = new Set(Object.keys(this.layers).filter((k) => this.layers[k]));
    const halfLife = this.windowMin > 0 ? Math.min(180, Math.max(15, this.windowMin / 8)) : 120;
    this.hotspots = computeHotspots(this._visEvents, { now, halfLifeMin: halfLife, kinds });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.w = w; this.h = h; this.cx = Math.round(w / 2); this.cy = Math.round(h / 2);
  }

  _latLonToScreen(lat, lon) {
    // `this._wc` is hoisted once per render() — projecting the centre per MARKER was
    // ~750 redundant trig calls per frame. Outside render (hit tests) it may be stale
    // by a pan-drag, so recompute when missing.
    const wc = this._wc || project(this.center.lat, this.center.lon, this.zoom);
    const p = project(lat, lon, this.zoom);
    return { x: this.cx + (p.x - wc.x), y: this.cy + (p.y - wc.y) };
  }
  _screenToLatLon(px, py) {
    const wc = project(this.center.lat, this.center.lon, this.zoom);
    return unproject(wc.x + (px - this.cx), wc.y + (py - this.cy), this.zoom);
  }

  // --- main render ---------------------------------------------------------------
  render(t, observer) {
    if (!this.active) return;
    if (observer) { this.observer = observer; if (!this.panned) this.center = { lat: observer.lat, lon: observer.lon }; }
    if (this._needsFit) { this._fit(); this._needsFit = false; }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#080A0C'; ctx.fillRect(0, 0, this.w, this.h);
    this._wc = project(this.center.lat, this.center.lon, this.zoom); // once per frame

    this._drawBasemap(ctx);
    this._drawRange(ctx);
    if (this.showHeat) this._drawHeat(ctx, t);

    this._collect();
    for (const m of this._markers) this._drawEvent(ctx, m, t);
    if (this.showCameras) {
      this._collectCams();
      if (this.showCones) for (const c of this._camMarkers) this._drawCones(ctx, c);
      for (const c of this._camMarkers) this._drawCam(ctx, c);
    } else {
      // Cameras hidden: drop the on-screen markers so a click where a pin USED to be no
      // longer opens the camera popup (_hitSite iterates this array).
      this._camMarkers.length = 0;
    }

    this._drawOwnship(ctx);
    this._drawLabels(ctx);
    this._corners(ctx);

    if (t - (this._lastChrome || 0) > 300) {
      this._updateStatus(); this._updateList(); this._updateDetail();
      this._updateHealth(); this._refreshCam();
      this._lastChrome = t;
    }
  }

  _drawBasemap(ctx) {
    if (this.basemap === 'none') return;
    const wc = project(this.center.lat, this.center.lon, this.zoom);
    const left = wc.x - this.w / 2, top = wc.y - this.h / 2;
    const n = 2 ** this.zoom;
    const tx0 = Math.floor(left / TILE), tx1 = Math.floor((left + this.w) / TILE);
    const ty0 = Math.max(0, Math.floor(top / TILE)), ty1 = Math.min(n - 1, Math.floor((top + this.h) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = (((tx % n) + n) % n);
        const img = this._getTile(this.basemap, this.zoom, wx, ty);
        if (img && img.loaded) ctx.drawImage(img.img, tx * TILE - left, ty * TILE - top, TILE, TILE);
      }
    }
    // darken the imagery a touch so bright glyphs + heat read on top
    ctx.fillStyle = 'rgba(8,10,12,0.32)'; ctx.fillRect(0, 0, this.w, this.h);
  }
  _getTile(style, z, x, y) {
    const key = `${style}/${z}/${x}/${y}`;
    let tItem = this._tiles.get(key);
    if (tItem) return tItem;
    tItem = { img: new Image(), loaded: false };
    tItem.img.onload = () => { tItem.loaded = true; };
    tItem.img.onerror = () => { tItem.failed = true; };
    tItem.img.src = `/api/tile/${style}/${z}/${x}/${y}`;
    if (this._tiles.size >= TILE_CACHE_MAX) this._tiles.delete(this._tiles.keys().next().value);
    this._tiles.set(key, tItem);
    return tItem;
  }

  _drawRange(ctx) {
    const own = this._latLonToScreen(this.observer.lat, this.observer.lon);
    const rpx = (this.rangeKm * 1000) / metersPerPixel(this.observer.lat, this.zoom);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); ctx.arc(own.x, own.y, rpx, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = '10px "IBM Plex Mono","Roboto Mono",ui-monospace,monospace';
    ctx.fillStyle = TEXT_MUTE; ctx.fillText(`${this.rangeKm}KM`, own.x + 4, own.y - rpx - 4);
  }

  // hotspot heat: additive radial blobs, hottest cells on top, capped for perf. Rendered
  // into an offscreen canvas at ~10 Hz (and on pan/zoom/data change) then blitted per
  // frame — building ~70 radial gradients 60×/s was the city view's dominant CPU cost.
  _drawHeat(ctx, t) {
    const hs = this.hotspots;
    if (!hs.ranked.length || hs.maxScore <= 0) { this._heatAt = 0; return; }
    if (!this._heatOff) this._heatOff = document.createElement('canvas');
    const off = this._heatOff;
    const moved = !this._heatCenter || this._heatCenter.lat !== this.center.lat || this._heatCenter.lon !== this.center.lon || this._heatZoom !== this.zoom;
    if (off.width !== this.canvas.width || off.height !== this.canvas.height) {
      off.width = this.canvas.width; off.height = this.canvas.height;
      this._heatDirty = true;
    }
    if (this._heatDirty || moved || t - (this._heatAt || 0) > 100) {
      const octx = off.getContext('2d');
      octx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      octx.clearRect(0, 0, this.w, this.h);
      const pulse = this._reduceMotion ? 1 : 0.9 + 0.1 * Math.sin(t * 0.004);
      octx.globalCompositeOperation = 'lighter';
      const top = hs.ranked.slice(0, 70);
      for (const h of top) {
        const p = this._latLonToScreen(h.lat, h.lon);
        if (p.x < -120 || p.x > this.w + 120 || p.y < -120 || p.y > this.h + 120) continue;
        const norm = h.score / hs.maxScore;
        const r = (26 + 74 * Math.sqrt(norm)) * pulse;
        const a = 0.10 + 0.34 * norm;
        const col = h.sev >= 3 ? '232,85,42' : h.sev >= 2 ? '255,140,40' : '255,190,60';
        const g = octx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(${col},${a})`);
        g.addColorStop(0.6, `rgba(${col},${a * 0.35})`);
        g.addColorStop(1, `rgba(${col},0)`);
        octx.fillStyle = g;
        octx.beginPath(); octx.arc(p.x, p.y, r, 0, TAU); octx.fill();
      }
      this._heatAt = t; this._heatDirty = false;
      this._heatCenter = { lat: this.center.lat, lon: this.center.lon }; this._heatZoom = this.zoom;
    }
    ctx.drawImage(off, 0, 0, this.w, this.h);
  }

  _collect() {
    const m = this._markers; m.length = 0;
    const obs = this.observer;
    for (const e of this._visEvents) {
      const p = this._latLonToScreen(e.lat, e.lon);
      if (p.x < -40 || p.x > this.w + 40 || p.y < -40 || p.y > this.h + 40) continue;
      m.push({ e, x: p.x, y: p.y, rangeKm: haversineKm(obs.lat, obs.lon, e.lat, e.lon) });
    }
    // draw/list lowest-severity first so majors land on top
    m.sort((a, b) => (a.e.severity - b.e.severity) || (a.e.ts - b.e.ts));
  }
  _collectCams() {
    const m = this._camMarkers; m.length = 0;
    for (const s of this._camSites) {
      const p = this._latLonToScreen(s.lat, s.lon);
      if (p.x < -20 || p.x > this.w + 20 || p.y < -20 || p.y > this.h + 20) continue;
      m.push({ site: s, x: p.x, y: p.y });
    }
  }

  _drawEvent(ctx, m, t) {
    const e = m.e, st = groundKind(e.kind), col = st.hex;
    const sel = this._selected === e.id, hov = this._hover === e.id;
    const x = m.x, y = m.y;
    const s = 4 + e.severity * 1.4;

    ctx.fillStyle = 'rgba(6,9,12,0.65)'; ctx.beginPath(); ctx.arc(x, y, s + 2, 0, TAU); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill();
    if (s >= 6) {
      ctx.fillStyle = '#06090C'; ctx.font = `bold ${Math.round(s + 2)}px "IBM Plex Mono",monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, x, y + 0.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    if (e.severity >= 2) {
      const pr = e.severity >= 3 && !this._reduceMotion ? s + 4 + 2.5 * (0.5 + 0.5 * Math.sin(t * 0.006)) : s + 4;
      ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (hov && !sel) { ctx.strokeStyle = TEXT; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, s + 6, 0, TAU); ctx.stroke(); }
    if (sel) this._selBrackets(ctx, x, y, s + 7, t);
  }

  // PTZ view-direction wedges: each feed with an az/fovDeg (ALERTCalifornia units) casts
  // a soft cone toward where it actually looks RIGHT NOW — a 4-head site shows four
  // different bearings. Screen-space length so cones read at every zoom.
  _drawCones(ctx, m) {
    const R = 30;
    for (const c of m.site.cams) {
      if (c.az == null || !(c.fovDeg > 0)) continue;
      const a = (c.az - 90) * DEG;              // compass az (0=N CW) -> canvas angle (0=E CCW)
      const half = (c.fovDeg / 2) * DEG;
      ctx.fillStyle = 'rgba(33,211,201,0.10)';
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.arc(m.x, m.y, R, a - half, a + half);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(33,211,201,0.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.x, m.y);
      ctx.arc(m.x, m.y, R, a - half, a + half);
      ctx.closePath(); ctx.stroke();
    }
  }

  _drawCam(ctx, m) {
    const x = m.x, y = m.y, sel = this._selSite === m.site.key, n = m.site.cams.length;
    ctx.strokeStyle = sel ? ACCENT : LIVE; ctx.fillStyle = 'rgba(6,12,14,0.7)'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.rect(x - 5, y - 4, 10, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = sel ? ACCENT : LIVE; ctx.beginPath(); ctx.arc(x, y, 1.7, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x + 5, y - 3); ctx.lineTo(x + 8, y - 4.5); ctx.lineTo(x + 8, y + 4.5); ctx.lineTo(x + 5, y + 3); ctx.closePath(); ctx.stroke();
    if (n > 1) {
      // count badge: this pin hides N feeds — the popup grid shows them all
      const label = String(n);
      ctx.font = 'bold 8px "IBM Plex Mono",monospace';
      const wpx = 7 + label.length * 5;
      ctx.fillStyle = sel ? ACCENT : LIVE;
      ctx.beginPath(); ctx.rect(x + 3, y - 11, wpx, 9); ctx.fill();
      ctx.fillStyle = '#06090C'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 3 + wpx / 2, y - 6.5);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  }

  _selBrackets(ctx, x, y, r, t) {
    const p = r + 2 + (this._reduceMotion ? 0 : Math.sin(t * 0.006) * 1.5);
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; const leg = 6;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x + sx * p, y + sy * p - sy * leg); ctx.lineTo(x + sx * p, y + sy * p); ctx.lineTo(x + sx * p - sx * leg, y + sy * p);
      ctx.stroke();
    }
  }

  _drawOwnship(ctx) {
    const { x, y } = this._latLonToScreen(this.observer.lat, this.observer.lon);
    ctx.strokeStyle = LIVE; ctx.fillStyle = LIVE; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x, y + 2); ctx.lineTo(x - 5, y + 5); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
  }

  _drawLabels(ctx) {
    ctx.font = '11px "IBM Plex Mono","Roboto Mono",ui-monospace,monospace'; ctx.textBaseline = 'middle';
    for (const m of this._markers) {
      const e = m.e, sel = this._selected === e.id, hov = this._hover === e.id;
      if (!sel && !hov) continue;
      const st = groundKind(e.kind);
      const tx = m.x + 12, ty = m.y - 12;
      ctx.strokeStyle = TEXT_DIM; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx - 2, ty); ctx.stroke();
      ctx.fillStyle = sel ? ACCENT : st.hex; ctx.fillText(e.title.slice(0, 40), tx, ty);
      ctx.fillStyle = TEXT_DIM; ctx.fillText(`${st.label} · ${ageStr(Date.now() - e.ts)} · ${m.rangeKm.toFixed(1)}km`, tx, ty + 12);
    }
  }

  _corners(ctx) {
    ctx.strokeStyle = GRID_HI; ctx.lineWidth = 1; const mm = 14, leg = 20, w = this.w, h = this.h;
    for (const [cx, cy, sx, sy] of [[mm, mm, 1, 1], [w - mm, mm, -1, 1], [w - mm, h - mm, -1, -1], [mm, h - mm, 1, -1]]) {
      ctx.beginPath(); ctx.moveTo(cx, cy + sy * leg); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * leg, cy); ctx.stroke();
    }
  }

  // --- overlay DOM ---------------------------------------------------------------
  _buildOverlay() {
    const el = document.createElement('div');
    el.id = 'city-ui';
    el.innerHTML = `
      <div id="cty-status">
        <span class="cty-brand"><span class="cty-mode">Ground · City Activity</span></span>
        <span class="cty-sys"><i class="dot"></i><span id="cty-feed">CITY FEEDS</span></span>
        <span id="cty-clock" class="data"></span>
      </div>
      <div id="cty-attrib"></div>
      <div id="cty-list">
        <div class="cty-tabs" id="cty-tabs">
          <button type="button" data-tab="events" class="active">Events</button>
          <button type="button" data-tab="hotspots">▲ Hotspots</button>
          <button type="button" data-tab="cameras">◱ Cams</button>
        </div>
        <div class="cty-tl-head" id="cty-tl-head"><span>KIND</span><span>EVENT</span><span>SEV</span><span>AGE</span><span>RNG</span></div>
        <div id="cty-tl-rows"></div>
      </div>
      <div id="cty-detail" hidden></div>
      <div id="cty-cam" hidden>
        <div class="cty-cam-head"><span id="cty-cam-name">Camera</span><button type="button" id="cty-cam-close" aria-label="Close">✕</button></div>
        <div id="cty-cam-grid"></div>
        <div id="cty-cam-meta" class="cty-cam-meta"></div>
      </div>`;
    document.body.appendChild(el);
    el.style.display = 'none';
    this.overlay = el;
    this._elClock = el.querySelector('#cty-clock');
    this._elFeed = el.querySelector('#cty-feed');
    this._elFeedDot = el.querySelector('#cty-status .dot');
    this._elRows = el.querySelector('#cty-tl-rows');
    this._elDetail = el.querySelector('#cty-detail');
    this._elAttrib = el.querySelector('#cty-attrib');
    this._elTabs = el.querySelector('#cty-tabs');
    this._elHead = el.querySelector('#cty-tl-head');
    this._elCam = el.querySelector('#cty-cam');
    this._elCamName = el.querySelector('#cty-cam-name');
    this._elCamGrid = el.querySelector('#cty-cam-grid');
    this._elCamMeta = el.querySelector('#cty-cam-meta');

    // ONE list panel serves all tabs, so the view floats fewer panels.
    this._elTabs.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-tab]');
      if (!b) return;
      this._tab = b.dataset.tab;
      for (const x of this._elTabs.querySelectorAll('[data-tab]')) x.classList.toggle('active', x === b);
      this._elHead.style.display = this._tab === 'events' ? '' : 'none';
      this._updateList(true);
    });
    this._elRows.addEventListener('click', (ev) => {
      const hs = ev.target.closest('[data-i]');
      if (hs) {
        const h = this.hotspots.ranked[+hs.dataset.i];
        if (h) { this.center = { lat: h.lat, lon: h.lon }; this.panned = true; this.zoom = Math.max(this.zoom, 14); }
        return;
      }
      const site = ev.target.closest('[data-site]');
      if (site) {
        const s = this._camSites.find((x) => x.key === site.dataset.site);
        if (s) { this.center = { lat: s.lat, lon: s.lon }; this.panned = true; this.zoom = Math.max(this.zoom, 13); this._openSite(s); }
        return;
      }
      const row = ev.target.closest('[data-id]');
      if (row) { this._selected = row.dataset.id; this._closeSite(); this._panToSelected(); this._updateList(); this._updateDetail(); }
    });
    el.querySelector('#cty-cam-close').addEventListener('click', () => this._closeSite());
    // Event→camera crosslink: the detail panel's "📷 N cams within 2 km" button opens the
    // NEAREST site's grid — eyes on a dispatch in one click.
    this._elDetail.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-cams]');
      if (!b) return;
      const e = this.events.find((x) => x.id === this._selected);
      const s = e && this._nearestSite(e.lat, e.lon, 2);
      if (s) this._openSite(s);
    });
  }

  _nearestSite(lat, lon, maxKm = Infinity) {
    let best = null, bestD = maxKm;
    for (const s of this._camSites) {
      const d = haversineKm(lat, lon, s.lat, s.lon);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  _panToSelected() {
    const m = this._markers.find((mm) => mm.e.id === this._selected);
    if (m) { this.center = { lat: m.e.lat, lon: m.e.lon }; this.panned = true; }
  }

  _updateStatus() {
    const d = new Date(); const z = (n) => String(n).padStart(2, '0');
    this._elClock.textContent = `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}Z  ${this.observer.lat.toFixed(3)} ${this.observer.lon.toFixed(3)}`;
    const okN = this.sources.filter((s) => s.ok).length, total = this.sources.length;
    const status = this._stale ? 'STALE' : okN ? 'NOMINAL' : (total ? 'OFFLINE' : 'STANDBY');
    this._elFeed.textContent = `FEEDS: ${status} · ${okN}/${total} · ${this._visEvents.length} EVT · ${this.cameras.length} CAM`;
    const color = this._stale ? '#FFB020' : okN ? '#3FCF6A' : (total ? '#FF3B47' : LIVE);
    if (this._elFeedDot) { this._elFeedDot.style.background = color; this._elFeedDot.style.boxShadow = `0 0 6px ${color}`; }
  }

  _updateList(force) {
    // Signature skip: chrome refreshes ~3×/s, but the list only needs a rebuild when
    // the data, selection, tab, or a coarse age bucket actually changes — rebuilding
    // 60 rows of innerHTML at 3 Hz was pure churn (and it killed scroll position).
    const bucket = Math.floor(Date.now() / 5000);
    if (this._tab === 'hotspots') {
      const sig = `hs|${this.hotspots.ranked.slice(0, 14).map((h) => `${h.lat.toFixed(3)},${h.lon.toFixed(3)},${h.count}`).join('|')}`;
      if (!force && sig === this._listSig) return;
      this._listSig = sig;
      return this._renderHotspotRows();
    }
    if (this._tab === 'cameras') {
      const sig = `c|${this._selSite}|${this._camSites.length}|${this.observer.lat.toFixed(2)},${this.observer.lon.toFixed(2)}`;
      if (!force && sig === this._listSig) return;
      this._listSig = sig;
      return this._renderCameraRows();
    }
    const sig = `e|${this._selected}|${bucket}|${this._markers.length ? this._markers[0].e.id : ''}|${this._visEvents.length}`;
    if (!force && sig === this._listSig) return;
    this._listSig = sig;
    const rows = this._markers.slice().reverse().slice(0, 60).map((m) => {
      const e = m.e, st = groundKind(e.kind), sel = this._selected === e.id ? ' sel' : '';
      return `<div class="cty-tl-row${sel}" data-id="${esc(e.id)}">`
        + `<span style="color:${st.hex}">${st.label}</span>`
        + `<span class="ttl" title="${esc(e.title)}">${esc(e.title)}</span>`
        + `<span class="data" style="color:${st.hex}">${e.severity}</span>`
        + `<span class="data">${this._ageCell(e)}</span>`
        + `<span class="data">${m.rangeKm.toFixed(1)}</span></div>`;
    }).join('');
    this._elRows.innerHTML = rows || `<div class="cty-tl-empty">${this._emptyReason()}</div>`;
  }

  // Every camera within range, nearest first — the full enumeration that makes "every
  // feed is reachable" true: multi-feed sites show their count and open the grid popup.
  _renderCameraRows() {
    if (!this._camSites.length) {
      this._elRows.innerHTML = '<div class="cty-tl-empty">— no public cameras in range —<span class="cty-sub">widen the radius or move the map</span></div>';
      return;
    }
    const obs = this.observer;
    const rows = this._camSites
      .map((s) => ({ s, d: haversineKm(obs.lat, obs.lon, s.lat, s.lon) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 120);
    this._elRows.innerHTML = rows.map(({ s, d }) => {
      const sel = this._selSite === s.key ? ' sel' : '';
      const prov = s.cams[0].provider;
      const n = s.cams.length;
      return `<div class="cty-tl-row cty-cam-row${sel}" data-site="${esc(s.key)}">`
        + `<span class="cty-cam-ico" style="color:${LIVE}">◱</span>`
        + `<span class="ttl" title="${esc(s.cams.map((c) => c.name).join(' · '))}">${esc(s.name)}${n > 1 ? ` <em class="cty-cam-n">×${n}</em>` : ''}</span>`
        + `<span class="data cty-cam-prov">${esc(prov)}</span>`
        + `<span class="data">${d.toFixed(1)}</span></div>`;
    }).join('');
  }

  // Say WHY the list is empty. An empty map must never be ambiguous with a broken app:
  // distinguish "no feed covers here" from "your time window hides them" from "you've
  // panned away". Each case has a different fix, so name it.
  // A still-in-effect condition that began weeks ago should read "ongoing", not "1455d" —
  // the raw age of a multi-year road closure is noise, not information.
  _ageCell(e) {
    const age = Date.now() - e.ts;
    if (e.expiresTs != null && e.expiresTs > Date.now() && age > 7 * 24 * 3600e3) return 'ongoing';
    return ageStr(age);
  }
  _windowLabel() {
    const w = this.windowMin;
    return w === 0 ? 'all-time' : w >= 1440 ? `${Math.round(w / 1440)}d` : `${Math.round(w / 60)}h`;
  }
  _emptyReason() {
    const total = this.events.length;
    if (total === 0) {
      const reporting = (this.sources || []).filter((s) => s.ok).length;
      return reporting
        ? '— no city incident feed covers this location —<span class="cty-sub">national hazard feeds + cameras only</span>'
        : '— waiting for feeds —';
    }
    if (this._visEvents.length === 0) {
      return `— ${total} events outside the ${this._windowLabel()} window —<span class="cty-sub">widen the time window to see them</span>`;
    }
    return '— events are outside the current view —<span class="cty-sub">hit Recentre</span>';
  }

  _updateDetail() {
    const e = this._selected ? this.events.find((x) => x.id === this._selected) : null;
    if (!e) { this._elDetail.hidden = true; return; }
    const st = groundKind(e.kind);
    const m = this._markers.find((mm) => mm.e.id === e.id);
    const rng = m ? m.rangeKm.toFixed(2) + ' KM' : '—';
    const row = (k, v) => `<div class="cty-d-row"><span>${k}</span><span class="data">${v}</span></div>`;
    // Event→camera crosslink: count the feeds with eyes near this incident. Clicking
    // opens the NEAREST site's live grid (wired in _buildOverlay).
    let nearCams = 0, feedCount = 0;
    for (const s of this._camSites) {
      if (haversineKm(e.lat, e.lon, s.lat, s.lon) <= 2) { nearCams++; feedCount += s.cams.length; }
    }
    this._elDetail.hidden = false;
    this._elDetail.innerHTML =
      `<div class="cty-d-head" style="border-color:${st.hex}"><span style="color:${st.hex}">${esc(e.title)}</span>`
      + `<span class="svc">${st.label} · ${GROUND_SEVERITY[e.severity] || ''}</span></div>`
      + (e.description ? row('DETAIL', esc(e.description)) : '')
      + row('KIND', st.label) + row('SEVERITY', `<b style="color:${st.hex}">${e.severity} ${GROUND_SEVERITY[e.severity] || ''}</b>`)
      + row('SOURCE', esc(e.source)) + row('TIME', new Date(e.ts).toISOString().slice(5, 16).replace('T', ' ') + 'Z')
      + row('RANGE', rng) + row('POSITION', `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`)
      + (nearCams ? `<div class="cty-d-link"><button type="button" class="cty-d-cams" data-cams>◱ ${feedCount} cam${feedCount > 1 ? 's' : ''} within 2 km — view live ▸</button></div>` : '')
      + (e.sourceUrl ? `<div class="cty-d-link"><a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener">source ↗</a></div>` : '');
  }

  // Hotspots render into the SAME list panel (tabbed), so the view floats one list, one
  // detail panel and one status strip instead of scattering boards around the screen.
  _renderHotspotRows() {
    const top = this.hotspots.ranked.slice(0, 14);
    if (!top.length) { this._elRows.innerHTML = '<div class="cty-tl-empty">— quiet —</div>'; return; }
    this._elRows.innerHTML = top.map((h, i) => {
      const st = groundKind(h.topKind);
      const bar = Math.max(6, Math.round(100 * h.score / (this.hotspots.maxScore || 1)));
      return `<div class="cty-hs-row" data-i="${i}">`
        + `<span class="cty-hs-dot" style="background:${st.hex}"></span>`
        + `<span class="cty-hs-lbl">${st.label} <em>${h.count} events</em></span>`
        + `<span class="cty-hs-bar"><i style="width:${bar}%;background:${st.hex}"></i></span></div>`;
    }).join('');
  }

  // Merge the live per-source health (from the incidents poll) with the full adapter
  // catalog (/api/sources) so the panel shows EVERY feed: live count, "key" (keyed feed
  // off until you add its key), or "opt-in" (gray source). Camera feeds report separately.
  _updateHealth() {
    const host = document.getElementById('cty-health');
    if (!host) return;
    // Incident-feed health and camera-feed health arrive on different routes — merge
    // both so EVERY source reports its real ok/count, plus any honest ops note.
    const live = new Map();
    for (const s of this.sources || []) live.set(s.id, s);
    for (const s of this.camSources || []) live.set(s.id, s);
    const cat = (this.catalog && this.catalog.length) ? this.catalog
      : [...live.values()].map((s) => ({ id: s.id, label: s.id, category: 'incidents', optin: s.optin, keyed: false, enabled: true }));
    if (!cat.length) { host.innerHTML = '<span class="hint">— standby —</span>'; return; }
    const rank = (a) => { const s = live.get(a.id); if (s && s.ok && s.count) return 0; if (a.category === 'cameras' && a.enabled) return 1; if (a.enabled) return 2; return 3; };
    const rows = cat.slice().sort((a, b) => rank(a) - rank(b) || String(a.label).localeCompare(String(b.label)));
    host.innerHTML = rows.map((a) => {
      const s = live.get(a.id);
      let col, note;
      if (s && s.ok) { col = s.count ? '#3FCF6A' : '#7C8894'; note = String(s.count); }
      else if (s && !s.ok) { col = '#FF3B47'; note = '✗'; }  // genuinely failed — say so
      else if (a.category === 'cameras') {
        if (a.enabled) { col = '#21D3C9'; note = 'cam'; } else if (a.keyed) { col = '#3a4652'; note = 'key'; } else { col = '#3a4652'; note = 'off'; }
      }
      else if (a.enabled) { col = '#FFB020'; note = '·'; }
      else if (a.keyed) { col = '#3a4652'; note = 'key'; }
      else if (a.optin) { col = '#3a4652'; note = 'opt-in'; }
      else { col = '#3a4652'; note = 'off'; }
      const tag = a.optin ? ' <em>opt-in</em>' : a.keyed ? ' <em>key</em>' : '';
      const why = s && !s.ok && s.error ? ` title="${esc(s.error)}"` : (s && s.note ? ` title="${esc(s.note)}"` : '');
      const suffix = s && s.note ? `<span class="cty-src-note">${esc(s.note)}</span>` : '';
      return `<div class="cty-src"${why}><span class="cty-src-dot" style="background:${col}"></span>`
        + `<span class="cty-src-id">${esc(a.label || a.id)}${tag}${suffix}</span>`
        + `<span class="cty-src-n data">${note}</span></div>`;
    }).join('');
  }

  // --- camera site popup: a LIVE GRID of every feed at the site ----------------------
  // One feed  → a single large view (the classic popup). A multi-head site (a wildfire
  // mast with N/S units, an interchange with a camera per direction) → a 2-column grid
  // where every cell refreshes independently and fails independently (one dead head
  // never blanks the others).
  _openSite(site) {
    this._selSite = site.key; this._selected = null; this._elDetail.hidden = true;
    this._elCamName.textContent = site.cams.length > 1 ? `${site.name} · ${site.cams.length} feeds` : site.name;
    this._elCamMeta.textContent = `${site.cams.map((c) => c.provider).filter((v, i, a) => a.indexOf(v) === i).join(' · ')} · ${site.lat.toFixed(3)}, ${site.lon.toFixed(3)}`;
    this._elCamGrid.className = site.cams.length === 1 ? 'single' : '';
    this._elCamGrid.innerHTML = site.cams.map((c, i) =>
      `<div class="cty-cam-cell" data-cam="${esc(c.id)}">`
      + `<div class="cty-cam-cell-head"><span class="cty-cam-cell-name" title="${esc(c.name)}">${esc(site.labels[i])}</span><span class="cty-cam-age"></span></div>`
      + `<img alt="${esc(c.name)}" />`
      + `<div class="cty-cam-cell-meta">${esc(c.provider)}</div>`
      + `</div>`).join('');
    this._camFeeds = site.cams.map((c, i) => {
      const cell = this._elCamGrid.children[i];
      const feed = {
        cam: c,
        src: c.proxied ? `/api/camimg/${encodeURIComponent(c.id)}` : (c.still || c.stream),
        img: cell.querySelector('img'),
        age: cell.querySelector('.cty-cam-age'),
        meta: cell.querySelector('.cty-cam-cell-meta'),
        next: 0,
      };
      // Say "offline" instead of showing a broken image icon — agencies take units out
      // of service constantly and a silent broken <img> reads as "the app is broken".
      // The cell keeps retrying on the normal cadence: a blip self-heals.
      feed.img.onerror = () => { cell.classList.add('off'); feed.meta.textContent = `${c.provider} · offline`; };
      feed.img.onload = () => { cell.classList.remove('off'); feed.meta.textContent = c.provider; };
      return feed;
    });
    this._elCam.hidden = false;
    this._refreshCam(true);
  }
  _closeSite() {
    this._selSite = null; this._camFeeds = []; this._elCam.hidden = true;
  }
  _refreshCam(force) {
    if (this._elCam.hidden || !this._camFeeds.length) return;
    const now = performance.now();
    for (const f of this._camFeeds) {
      // re-pull each still every ~5 s while the popup is open (server caches ~15 s)
      if (force || now >= f.next) {
        f.img.src = f.src + (f.src.includes('?') ? '&' : '?') + 't=' + Math.floor(now);
        f.next = now + 5000;
      }
      // Honest frame age where the source reports it (ALERTCalifornia last_frame_ts) —
      // a PTZ unit stuck on an old frame is visibly "stale", not silently wrong.
      if (f.cam.frameTs) {
        const age = Date.now() - f.cam.frameTs;
        f.age.textContent = age < 90_000 ? `${Math.max(1, Math.round(age / 1000))}s` : ageStr(age);
        f.age.title = `frame ${ageStr(age)} old`;
      }
    }
  }

  // --- city-incident log: newly-seen higher-severity events, newest first ----------
  _logNewIncidents() {
    const host = document.getElementById('cty-log');
    if (!host) return;
    if (!this._logSeen) { this._logSeen = new Set(); this._log = []; }
    for (const e of this.events) {
      if (e.severity < 2 || this._logSeen.has(e.id)) continue;
      this._logSeen.add(e.id);
      this._log.unshift({ id: e.id, kind: e.kind, title: e.title, sev: e.severity, ts: Date.now() });
    }
    if (this._log.length > 60) this._log.length = 60;
    if (this._logSeen.size > 4000) this._logSeen = new Set(this._log.map((x) => x.id));
    const cnt = document.getElementById('cty-log-count'); if (cnt) cnt.textContent = this._log.length ? `${this._log.length} logged` : 'log';
    host.innerHTML = this._log.length ? this._log.slice(0, 30).map((x) => {
      const st = groundKind(x.kind); const d = new Date(x.ts); const z = (n) => String(n).padStart(2, '0');
      return `<div class="cty-log-row"><span class="cty-log-time">${z(d.getUTCHours())}:${z(d.getUTCMinutes())}Z</span>`
        + `<span class="cty-log-ttl" title="${esc(x.title)}">${esc(x.title)}</span>`
        + `<span class="cty-log-kind" style="color:${st.hex}">${st.label}</span></div>`;
    }).join('') : '<span class="hint">— none yet —</span>';
  }

  // --- pointer -------------------------------------------------------------------
  _wirePointer() {
    const c = this.canvas; let down = null;
    c.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, moved: false, startCenter: { ...this.center } }; c.setPointerCapture?.(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (down) {
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) down.moved = true;
        if (down.moved && !this._placingLocation) {
          const w0 = project(down.startCenter.lat, down.startCenter.lon, this.zoom);
          this.center = unproject(w0.x - dx, w0.y - dy, this.zoom); this.panned = true;
        }
      }
      if (!down || !down.moved) this._hover = this._hitEvent(e.clientX, e.clientY);
      c.style.cursor = this._placingLocation ? 'crosshair' : ((this._hover || this._hitCam(e.clientX, e.clientY)) ? 'pointer' : (down ? 'grabbing' : 'grab'));
    });
    const finish = (e) => {
      if (down && !down.moved) {
        if (this._placingLocation) {
          const { lat, lon } = this._screenToLatLon(e.clientX, e.clientY);
          this.cb.onObserverChange?.({ lat, lon, alt: this.observer.alt || 0 });
          this._placingLocation = false; this.cb.onPickModeChange?.(false);
        } else {
          const id = this._hitEvent(e.clientX, e.clientY);
          if (id) { this._selected = id; this._closeSite(); this._updateList(); this._updateDetail(); }
          else {
            const site = this._hitSite(e.clientX, e.clientY);
            if (site) this._openSite(site); else { this._selected = null; this._updateDetail(); }
          }
        }
      }
      down = null; c.releasePointerCapture?.(e.pointerId);
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', () => { down = null; });
    c.addEventListener('pointerleave', () => { this._hover = null; });
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom + (e.deltaY < 0 ? 1 : -1))); }, { passive: false });
  }

  _hitEvent(px, py) {
    let best = null, bestD = 15 * 15;
    for (const m of this._markers) { const dx = m.x - px, dy = m.y - py, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = m.e.id; } }
    return best;
  }
  _hitCam(px, py) { return !!this._hitSite(px, py); }
  _hitSite(px, py) {
    let best = null, bestD = 12 * 12;
    for (const m of this._camMarkers) { const dx = m.x - px, dy = m.y - py, d = dx * dx + dy * dy; if (d < bestD) { bestD = d; best = m.site; } }
    return best;
  }
}
