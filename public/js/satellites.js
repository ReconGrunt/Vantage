// satellites.js — real orbiting objects. TLEs come from CelesTrak (via our
// proxy) and are propagated locally every frame with SGP4 (satellite.js), so
// each dot is the genuine tracked object at its true look-angle from you.

import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { domePositionInto, DEG } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';
import { instantiate } from './assets.js';

const SAT_POOL = 36;     // how many sats get a 3D model (closest/highest)
const SAT_SIZE = 16;     // world size of a generic satellite model
const ISS_SIZE = 28;     // the ISS is bigger/iconic

export class SatelliteLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'satellites';
    this.satrecs = [];     // { name, satrec }
    this.group_name = 'visual';

    // One Points cloud for all sats — fast even with thousands. The position
    // buffer is preallocated ONCE and written in place every frame (we only ever
    // bump needsUpdate + setDrawRange), so the per-frame update allocates nothing
    // and never re-uploads a brand-new attribute to the GPU.
    this.maxPoints = 12000;            // generous: visual+active groups are well under this
    this._posArr = new Float32Array(this.maxPoints * 3);
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(this._posArr, 3));
    this.geom.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geom, new THREE.PointsMaterial({
      color: 0x7CFFB2, size: 7, sizeAttenuation: false,
      map: dotTexture(0x7CFFB2), transparent: true, depthTest: false,
    }));
    this.group.add(this.points);

    // A floating label for the currently highlighted sat (e.g. ISS).
    this.highlightLabel = makeTextSprite('', 0x7CFFB2, 36);
    this.highlightLabel.visible = false;
    this.group.add(this.highlightLabel);

    this.visibleSats = []; // parallel to point positions, for picking
    // Reusable per-visible-sat record objects (each owns a persistent Vector3
    // `pos`), so the hot update() loop below allocates nothing per frame.
    this._recPool = [];
    this.models = null;
    this.issMesh = null;
    this.satPool = [];     // reusable generic-satellite model clones

    // Off-thread SGP4: the worker owns its own satrec copies and answers `tick`s with the
    // visible set. If it fails to spin up, everything transparently falls back to the
    // synchronous path below (the sky never blanks). Main keeps this.satrecs for the
    // fallback and for the throttled overheadReport()/passLookahead() queries.
    this._satByName = new Map();   // name -> satrec, to re-attach a satrec to a worker record
    this._worker = null;
    this._workerData = null;       // latest {visible:[…]} reply
    this._lastTickMs = 0;
    this._initWorker();

    scene.add(this.group);
  }

  _initWorker() {
    try {
      const w = new Worker(new URL('./sat-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { if (e.data && e.data.type === 'positions') this._workerData = e.data.visible; };
      w.onerror = () => { this._worker = null; this._workerData = null; }; // dead worker → sync fallback
      this._worker = w;
    } catch {
      this._worker = null;   // e.g. module workers unsupported → sync path
    }
  }

  setVisible(v) { this.group.visible = v; }

  // Give satellites real shapes: the ISS uses the ISS model, others a generic
  // comms-sat model (pooled). Distant sats are still just glowing points.
  setModels(models) {
    this.models = models;
    if (models.iss) {
      this.issMesh = instantiate(models.iss);
      this.issMesh.scale.setScalar(ISS_SIZE);
      this.issMesh.visible = false;
      this.group.add(this.issMesh);
    }
    if (models.satellite) {
      for (let i = 0; i < SAT_POOL; i++) {
        const m = instantiate(models.satellite);
        m.scale.setScalar(SAT_SIZE);
        m.visible = false;
        this.satPool.push(m);
        this.group.add(m);
      }
    }
  }

  async load(group = 'visual') {
    this.group_name = group;
    const res = await fetch(`/api/tle?group=${encodeURIComponent(group)}`);
    const data = await res.json();
    this.satrecs = [];
    for (const s of data.sats || []) {
      try {
        const satrec = satellite.twoline2satrec(s.line1, s.line2);
        if (satrec.error === 0) this.satrecs.push({ name: s.name, satrec });
      } catch { /* skip bad TLE */ }
    }
    this._satByName = new Map(this.satrecs.map((s) => [s.name, s.satrec]));
    // Hand the raw TLE lines to the worker (it builds its own satrecs; none cross the boundary).
    if (this._worker) this._worker.postMessage({ type: 'load', sats: data.sats || [] });
    this._workerData = null; // force a fresh tick against the new elements
    return this.satrecs.length;
  }

  update(observer, date) {
    if (!this.group.visible || !this.satrecs.length) return;
    if (this._worker) {
      // Throttle ticks to ~10 Hz (sats crawl across the sky; a per-frame post floods the
      // worker), and apply the latest reply every frame for smooth motion. Until the first
      // reply lands (or if the worker is dead), fall through to the synchronous path so the
      // sky is never blank.
      const nowMs = date.getTime();
      if (nowMs - this._lastTickMs > 100) {
        this._lastTickMs = nowMs;
        this._worker.postMessage({ type: 'tick', observer: { lat: observer.lat, lon: observer.lon, alt: observer.alt || 0 }, dateMs: nowMs });
      }
      this._applyVisible(this._workerData || this._propagateAll(observer, date), date);
    } else {
      this._applyVisible(this._propagateAll(observer, date), date);
    }
  }

  // Synchronous SGP4 over every satrec — the fallback path AND the exact twin of what the
  // worker computes. Returns a plain-number visible set: {name,azDeg,altDeg,heightKm,speedKmS,
  // rangeKm,isISS}. No THREE/no pooled records here, so it's identical work to the worker.
  _propagateAll(observer, date) {
    const gmst = satellite.gstime(date);
    const gd = { longitude: observer.lon * DEG, latitude: observer.lat * DEG, height: (observer.alt || 0) / 1000 };
    const vis = [];
    for (const { name, satrec } of this.satrecs) {
      if (vis.length >= this.maxPoints) break;
      const pv = satellite.propagate(satrec, date);
      if (!pv || !pv.position) continue;
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const look = satellite.ecfToLookAngles(gd, ecf);
      const altDeg = look.elevation * (180 / Math.PI);
      if (altDeg < 0) continue; // below horizon
      const azDeg = (look.azimuth * (180 / Math.PI) + 360) % 360;
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const v = pv.velocity;
      const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null;
      vis.push({ name, azDeg, altDeg, heightKm: geo.height, speedKmS: speed, rangeKm: look.rangeSat, isISS: /ISS|ZARYA/i.test(name) });
    }
    return vis;
  }

  // Write a visible set into the preallocated GPU buffer + rebuild this.visibleSats (with the
  // satrec re-attached by name for overheadReport/passLookahead), place the 3D models, and
  // update the ISS label. Shared by the sync fallback and the worker path.
  _applyVisible(vis, date) {
    const posArr = this._posArr;
    let n = 0;
    const list = this.visibleSats;
    list.length = 0;
    let issRec = null;

    for (const s of vis) {
      if (n >= this.maxPoints) break;
      let rec = this._recPool[n];
      if (!rec) rec = this._recPool[n] = { pos: new THREE.Vector3() };
      domePositionInto(rec.pos, s.azDeg, s.altDeg, SHELLS.satellites);
      const p = rec.pos;
      posArr[n * 3] = p.x; posArr[n * 3 + 1] = p.y; posArr[n * 3 + 2] = p.z;
      n++;
      rec.name = s.name; rec.azimuth = s.azDeg; rec.altitude = s.altDeg; rec.rangeKm = s.rangeKm;
      rec.heightKm = s.heightKm; rec.speedKmS = s.speedKmS; rec.isISS = s.isISS;
      rec.satrec = this._satByName.get(s.name) || null; // re-attach for pass/overhead queries
      list.push(rec);
      if (s.isISS) issRec = rec;
    }

    // Commit in place: only flag the used range dirty + redraw n points. No new typed array,
    // no new attribute, no full re-upload. addUpdateRange narrows the GPU upload to the
    // 0..n*3 floats actually written (three r160 API); without it needsUpdate re-uploads the
    // whole 12000-point buffer (~144 KB) every frame regardless of how few sats are up.
    const posAttr = this.geom.attributes.position;
    posAttr.clearUpdateRanges?.();
    posAttr.addUpdateRange?.(0, n * 3);
    this.geom.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    if (!this.geom.boundingSphere) this.geom.boundingSphere = new THREE.Sphere();
    this.geom.boundingSphere.center.set(0, 0, 0);
    this.geom.boundingSphere.radius = SHELLS.satellites * 1.01;

    this._placeModels(date);

    if (issRec) {
      this.highlightLabel.visible = true;
      this.highlightLabel.position.copy(issRec.pos);
      this.highlightLabel.position.y += 14;
      const txt = `ISS\n${Math.round(issRec.heightKm)} km  ${(issRec.speedKmS || 0).toFixed(1)} km/s`;
      this._setLabel(txt);
    } else {
      this.highlightLabel.visible = false;
    }
  }

  // Position the 3D satellite models: the ISS gets its own model; the highest
  // (most prominent) sats get pooled generic comms-sat models. The rest stay as
  // glowing points.
  _placeModels(date) {
    if (!this.models) return;
    const t = (date.getTime() % 1e7) / 1000;
    if (this.issMesh) {
      const iss = this.visibleSats.find((s) => s.isISS);
      this.issMesh.visible = !!iss;
      if (iss) { this.issMesh.position.copy(iss.pos); this.issMesh.rotation.y = t * 0.12; }
    }
    if (this.satPool.length) {
      const others = this.visibleSats.filter((s) => !s.isISS).sort((a, b) => b.altitude - a.altitude);
      for (let i = 0; i < this.satPool.length; i++) {
        const m = this.satPool[i];
        const s = others[i];
        m.visible = !!s;
        if (s) { m.position.copy(s.pos); m.rotation.set(0.4, t * 0.25 + i, 0); }
      }
    }
  }

  // Satellites currently overhead, for the bottom board's own section. For each
  // we step the orbit forward a few minutes to find time-to-peak (culmination).
  overheadReport(observer, date, { minDeg = 18, top = 6 } = {}) {
    return this.visibleSats
      .filter((s) => s.altitude >= minDeg)
      .sort((a, b) => b.altitude - a.altitude)
      .slice(0, top)
      .map((s) => {
        const peak = this._peak(observer, s.satrec, date);
        return {
          name: s.name, heightKm: s.heightKm, speedKmS: s.speedKmS,
          elevation: s.altitude, peakSec: peak.sec, rising: peak.rising,
        };
      });
  }

  // ISS pass status: whether it's up now (with current/peak elevation) or, if
  // not, when the next pass rises and its peak elevation. Steps the orbit forward
  // up to ~2.5h. `sunlit` flags whether a pass would actually be visible (dark sky).
  issStatus(observer, date, sunAltDeg = -90) {
    const rec = this.satrecs.find((s) => /ISS|ZARYA/i.test(s.name));
    if (!rec) return null;
    const gd = { longitude: observer.lon * DEG, latitude: observer.lat * DEG, height: (observer.alt || 0) / 1000 };
    const elAt = (d) => {
      const pv = satellite.propagate(rec.satrec, d);
      if (!pv || !pv.position) return -90;
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(d));
      return satellite.ecfToLookAngles(gd, ecf).elevation * 180 / Math.PI;
    };
    const visible = sunAltDeg < -6; // dark enough at the observer to see a pass
    const now = elAt(date);
    if (now > 0) {
      let maxEl = now;
      for (let t = 20; t <= 600; t += 20) maxEl = Math.max(maxEl, elAt(new Date(date.getTime() + t * 1000)));
      return { up: true, elevation: now, maxEl, etaSec: 0, visible };
    }
    let prev = now, riseT = null;
    for (let t = 30; t <= 9000; t += 30) {
      const e = elAt(new Date(date.getTime() + t * 1000));
      if (prev < 0 && e >= 0) { riseT = t; break; }
      prev = e;
    }
    if (riseT == null) return { up: false, etaSec: null };
    let maxEl = 0;
    for (let t = riseT; t <= riseT + 700; t += 20) maxEl = Math.max(maxEl, elAt(new Date(date.getTime() + t * 1000)));
    return { up: false, etaSec: riseT, maxEl, visible };
  }

  // Upcoming-pass lookahead — a generalisation of issStatus() to the top-N sats, on the
  // SAME cached satrecs. NOT per-frame: call it on the throttled ISS/board cadence (it is
  // O(top · maxSec/stepSec) propagations). Returns PassPrediction[] (contract in AGENT_SWARM):
  //   { satName, isISS, state:'up'|'rising', nowElDeg, etaSec, peakElDeg, peakEtaSec,
  //     riseAzDeg, setEtaSec, sunlit } — az 0=N CW, el deg, times in seconds from `date`.
  passLookahead(observer, date, sunAltDeg = -90, opts = {}) {
    const { horizonDeg = 0, maxSec = 5400, stepSec = 30, top = 8 } = opts;
    const gd = { longitude: observer.lon * DEG, latitude: observer.lat * DEG, height: (observer.alt || 0) / 1000 };
    const sunlit = sunAltDeg < -6; // observer sky dark enough for a pass to be visible (best-effort)

    // Candidates: the currently-overhead sats (highest first), plus the ISS always, deduped.
    const cands = [];
    const seen = new Set();
    for (const s of [...this.visibleSats].sort((a, b) => b.altitude - a.altitude)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      cands.push({ name: s.name, satrec: s.satrec });
      if (cands.length >= top) break;
    }
    const iss = this.satrecs.find((s) => /ISS|ZARYA/i.test(s.name));
    if (iss && !seen.has(iss.name)) cands.push({ name: iss.name, satrec: iss.satrec });

    const out = [];
    for (const c of cands) {
      const p = this._predictPass(gd, c.satrec, date, horizonDeg, maxSec, stepSec);
      if (p) out.push({ satName: c.name, isISS: /ISS|ZARYA/i.test(c.name), sunlit, ...p });
    }
    // up-now first (highest peak), then rising by soonest ETA
    out.sort((a, b) => (a.state === b.state
      ? (a.state === 'up' ? b.peakElDeg - a.peakElDeg : (a.etaSec ?? 1e9) - (b.etaSec ?? 1e9))
      : (a.state === 'up' ? -1 : 1)));
    return out;
  }

  // One satellite's pass: elevation/azimuth stepped forward from `date`. Mirrors the
  // issStatus() stepping but returns the full PassPrediction fields (minus satName/isISS/sunlit).
  _predictPass(gd, satrec, date, horizonDeg, maxSec, stepSec) {
    const sample = (d) => {
      const pv = satellite.propagate(satrec, d);
      if (!pv || !pv.position) return null;
      const look = satellite.ecfToLookAngles(gd, satellite.eciToEcf(pv.position, satellite.gstime(d)));
      return { el: look.elevation * 180 / Math.PI, az: (look.azimuth * 180 / Math.PI + 360) % 360 };
    };
    const now = sample(date);
    if (!now) return null;
    const at = (t) => sample(new Date(date.getTime() + t * 1000));

    if (now.el >= horizonDeg) {           // up now → find culmination + set
      let peakEl = now.el, peakT = 0, setT = null;
      for (let t = stepSec; t <= maxSec; t += stepSec) {
        const s = at(t);
        if (!s) break;
        if (s.el > peakEl) { peakEl = s.el; peakT = t; }
        if (s.el < horizonDeg) { setT = t; break; }
      }
      return { state: 'up', nowElDeg: +now.el.toFixed(1), etaSec: 0, peakElDeg: +peakEl.toFixed(1), peakEtaSec: peakT, riseAzDeg: null, setEtaSec: setT };
    }

    let prev = now.el, riseT = null, riseAz = null;   // below horizon → find next rise
    for (let t = stepSec; t <= maxSec; t += stepSec) {
      const s = at(t);
      if (!s) break;
      if (prev < horizonDeg && s.el >= horizonDeg) { riseT = t; riseAz = s.az; break; }
      prev = s.el;
    }
    if (riseT == null) return { state: 'rising', nowElDeg: +now.el.toFixed(1), etaSec: null, peakElDeg: 0, peakEtaSec: 0, riseAzDeg: null, setEtaSec: null };
    let peakEl = 0, peakT = riseT, setT = null;
    for (let t = riseT; t <= riseT + 900; t += stepSec) {
      const s = at(t);
      if (!s) break;
      if (s.el > peakEl) { peakEl = s.el; peakT = t; }
      if (t > riseT && s.el < horizonDeg) { setT = t; break; }
    }
    return { state: 'rising', nowElDeg: +now.el.toFixed(1), etaSec: riseT, peakElDeg: +peakEl.toFixed(1), peakEtaSec: peakT, riseAzDeg: +riseAz.toFixed(0), setEtaSec: setT };
  }

  _peak(observer, satrec, date) {
    if (!satrec) return { sec: 0, rising: false };
    const gd = { longitude: observer.lon * DEG, latitude: observer.lat * DEG, height: (observer.alt || 0) / 1000 };
    let maxEl = -90, maxT = 0;
    for (let t = 0; t <= 600; t += 15) {
      const d = new Date(date.getTime() + t * 1000);
      const pv = satellite.propagate(satrec, d);
      if (!pv || !pv.position) break;
      const ecf = satellite.eciToEcf(pv.position, satellite.gstime(d));
      const el = satellite.ecfToLookAngles(gd, ecf).elevation * 180 / Math.PI;
      if (el > maxEl) { maxEl = el; maxT = t; }
    }
    return { sec: maxT, rising: maxT > 8 };
  }

  // For hover picking: map a Points intersection index to an info-card payload.
  pickInfo(index) {
    const s = this.visibleSats[index];
    if (!s) return null;
    return {
      kind: 'satellite', name: s.name,
      info: {
        type: 'Satellite',
        altitude: `${Math.round(s.heightKm).toLocaleString()} km`,
        speed: `${(s.speedKmS || 0).toFixed(2)} km/s`,
        rangeKm: s.rangeKm,
        azimuth: s.azimuth, altitude_deg: s.altitude,
      },
    };
  }

  _setLabel(text) {
    if (this._lastLabel === text) return;
    this._lastLabel = text;
    const fresh = makeTextSprite(text, 0x7CFFB2, 36);
    // Dispose the previous CanvasTexture + SpriteMaterial: the ISS label text
    // (height/speed) changes ~1×/s while overhead, so without this every pass
    // leaks hundreds of textures until WebGL context loss on a 24/7 run.
    const old = this.highlightLabel.material;
    this.highlightLabel.material = fresh.material;
    this.highlightLabel.scale.copy(fresh.scale);
    if (old) { old.map?.dispose(); old.dispose(); }
  }
}

let _dot;
function dotTexture(color) {
  if (_dot) return _dot;
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(color);
  const hex = `${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0}`;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, `rgba(${hex},1)`);
  g.addColorStop(0.5, `rgba(${hex},0.8)`);
  g.addColorStop(1, `rgba(${hex},0)`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}
