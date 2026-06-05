// aircraft.js — live planes as real 3D airliners with fading contrails.
//
// Each plane is the genuine reported flight (OpenSky state). We dead-reckon
// between ~12s polls using its true track + ground speed (and vertical rate, so
// it visibly climbs/descends), orient a 3D airliner model along its path, and
// trail a fading contrail behind it. Type + route are enriched on demand from
// adsbdb via our proxy.

import * as THREE from 'three';
import { lookAngles, domePosition, azAltToVector, DEG } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';
import { buildAirliner, buildHelicopter, aircraftMaterial } from './plane-model.js';
import { classify, isHelicopter, CATEGORY } from './classify.js';

const POLL_MS = 12_000;
const PLANE_SCALE = 22;
const HELI_SCALE = 16;
const TRAIL_MAX = 48;          // trail nodes
const TRAIL_DT = 180;          // ms between trail samples
const CONTRAIL_MIN_ALT = 7600; // m (~25,000 ft) — contrails only form up high

export class AircraftLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'aircraft';
    this.planes = new Map();   // id -> entry
    this.observer = null;
    this.showLabels = false;

    // two shared geometries (fixed-wing + rotary)
    this.geo = { plane: buildAirliner(), heli: buildHelicopter() };

    // one shared material + trail per service category (cheap, lets us colour-code)
    this.mat = {};
    this.trailMat = {};
    for (const [key, c] of Object.entries(CATEGORY)) {
      this.mat[key] = aircraftMaterial({ color: c.color, emissive: c.emissive, emissiveIntensity: c.ei });
      this.trailMat[key] = makeTrailMaterial(c.trail);
    }

    // which fields appear on the on-dome labels (callsign is always shown)
    this.labelFields = {
      route: true, type: true, altitude: true, speed: true,
      heading: false, squawk: false, registration: false, vrate: false,
    };

    this._enrichQueue = [];
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }

  setLabels(on) {
    this.showLabels = on;
    for (const [, e] of this.planes) if (e.label) e.label.visible = on && e.mesh.visible;
  }

  setLabelFields(fields) {
    this.labelFields = { ...this.labelFields, ...fields };
    for (const [, e] of this.planes) { e.labelText = null; e.lastLabel = 0; } // force rebuild
  }

  async poll(observer, radiusKm = 250) {
    this.observer = observer;
    let data;
    try {
      data = await (await fetch(`/api/aircraft?lat=${observer.lat}&lon=${observer.lon}&radius=${radiusKm}`)).json();
    } catch {
      return { error: true, count: this.planes.size };
    }

    const now = performance.now();
    const seen = new Set();
    for (const a of data.aircraft || []) {
      if (a.altitude == null) continue;
      seen.add(a.id);
      let entry = this.planes.get(a.id);
      if (!entry) entry = this._spawn(a);
      entry.cur = { lat: a.lat, lon: a.lon, alt: a.altitude };
      entry.state = a;
      entry.lastSeen = now;
    }

    for (const [id, entry] of this.planes) {
      if (now - entry.lastSeen > POLL_MS * 3) this._despawn(id, entry);
    }
    return { count: seen.size, time: data.time, stale: data.stale };
  }

  _spawn(a) {
    const mesh = new THREE.Mesh(this.geo.plane, this.mat.civ);
    mesh.scale.setScalar(PLANE_SCALE);
    mesh.frustumCulled = false;
    this.group.add(mesh);

    // trail
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
    tgeo.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX), 1));
    tgeo.setDrawRange(0, 0);
    const trail = new THREE.Line(tgeo, this.trailMat.civ);
    trail.frustumCulled = false;
    this.group.add(trail);

    const label = makeTextSprite(a.callsign || a.id, 0xdff1ff, 22);
    label.visible = false;
    this.group.add(label);

    const entry = {
      id: a.id,
      mesh, trail, label,
      history: [],            // {pos:Vector3, t}
      lastTrail: 0,
      info: null, enriching: false,
      category: 'civ', isHeli: false,
    };
    this.planes.set(a.id, entry);

    // Immediate classification from what we already know (ICAO24 → US military).
    entry.state = a;
    this._reclassify(entry);
    // Everyone gets enriched in the background so we can colour-code by operator.
    this._enrichQueue.push(entry);
    return entry;
  }

  // Decide category + heli from current state/info and update the visuals.
  _reclassify(entry) {
    const cat = classify(entry.state, entry.info);
    const heli = isHelicopter(entry.info);
    if (cat === entry.category && heli === entry.isHeli && entry._appliedOnce) return;
    entry.category = cat;
    entry.isHeli = heli;
    entry._appliedOnce = true;
    entry.mesh.geometry = heli ? this.geo.heli : this.geo.plane;
    entry.mesh.scale.setScalar(heli ? HELI_SCALE : PLANE_SCALE);
    entry.mesh.material = this.mat[cat];
    entry.trail.material = this.trailMat[cat];
  }

  _despawn(id, entry) {
    this.group.remove(entry.mesh, entry.trail, entry.label);
    entry.trail.geometry.dispose();
    this.planes.delete(id);
  }

  update(observer, nowMs) {
    if (!this.group.visible || !observer) return;
    const now = nowMs;

    for (const [, entry] of this.planes) {
      const s = entry.state;
      if (!s || !entry.cur) continue;

      const dt = Math.min((now - entry.lastSeen) / 1000, POLL_MS / 1000 * 2);
      const projected = deadReckon(entry.cur, s.velocity || 0, s.heading || 0, dt);
      projected.alt += (s.verticalRate || 0) * dt; // climb/descent

      const look = lookAngles(observer, projected);
      const above = look.altitude > -1.5;
      entry.mesh.visible = above;

      if (!above) { entry.trail.visible = false; if (entry.label) entry.label.visible = false; continue; }

      const pos = domePosition(look.azimuth, look.altitude, SHELLS.aircraft);
      entry.mesh.position.copy(pos);

      // Orient nose (-Z) along direction of travel on the dome.
      const ahead = deadReckon(projected, s.velocity || 0, s.heading || 0, 4);
      ahead.alt += (s.verticalRate || 0) * 4;
      const aheadLook = lookAngles(observer, ahead);
      const aheadPos = domePosition(aheadLook.azimuth, aheadLook.altitude, SHELLS.aircraft);
      entry.mesh.up.copy(pos).normalize();           // radial up = belly toward observer
      if (aheadPos.distanceToSquared(pos) > 1e-4) entry.mesh.lookAt(aheadPos);

      // Contrails only form high up (cold, humid air) — real jets above ~25,000 ft.
      // This is physically accurate AND avoids unrealistic long streaks from low,
      // fast-crossing overhead traffic.
      const contrail = projected.alt > CONTRAIL_MIN_ALT;
      entry.trail.visible = contrail;
      if (contrail) {
        if (now - entry.lastTrail > TRAIL_DT) {
          const prev = entry.history[entry.history.length - 1];
          // discontinuity guard: a real aircraft can't jump far in one sample
          // (happens near the zenith singularity or on a data snap) — reset instead
          // of drawing a streak across the dome.
          if (prev && pos.distanceTo(prev) > 90) entry.history.length = 0;
          entry.history.push(pos.clone());
          if (entry.history.length > TRAIL_MAX) entry.history.shift();
          entry.lastTrail = now;
          this._writeTrail(entry);
        } else if (entry.history.length) {
          entry.history[entry.history.length - 1].copy(pos); // keep head attached
          this._writeTrail(entry);
        }
      } else if (entry.history.length) {
        entry.history.length = 0;
        entry.trail.geometry.setDrawRange(0, 0);
      }

      if (entry.label) {
        entry.label.visible = this.showLabels;
        entry.label.position.copy(pos).addScaledVector(pos.clone().normalize(), 16);
        // refresh ~1/s so live height/speed stay current without rebuilding every frame
        if (this.showLabels && now - (entry.lastLabel || 0) > 900) {
          this._refreshLabel(entry); entry.lastLabel = now;
        }
      }

      entry.mesh.userData = this._userData(entry, look);
    }
  }

  _writeTrail(entry) {
    const h = entry.history;
    const n = h.length;
    const pos = entry.trail.geometry.attributes.position.array;
    const prog = entry.trail.geometry.attributes.aProgress.array;
    for (let i = 0; i < n; i++) {
      pos[i * 3] = h[i].x; pos[i * 3 + 1] = h[i].y; pos[i * 3 + 2] = h[i].z;
      prog[i] = i / (n - 1 || 1); // 0 at tail -> 1 at head
    }
    entry.trail.geometry.setDrawRange(0, n);
    entry.trail.geometry.attributes.position.needsUpdate = true;
    entry.trail.geometry.attributes.aProgress.needsUpdate = true;
  }

  _userData(entry, look) {
    const s = entry.state;
    const info = {
      type: entry.info?.aircraft?.type || 'Aircraft',
      callsign: s.callsign || '(none)',
      country: s.country,
      altitude: `${Math.round(s.altitude).toLocaleString()} m`,
      speed: `${Math.round((s.velocity || 0) * 3.6)} km/h`,
      heading: `${Math.round(s.heading || 0)}°`,
      azimuth: look.azimuth, altitude_deg: look.altitude,
    };
    if (entry.info?.aircraft) {
      const ac = entry.info.aircraft;
      info.aircraftType = [ac.manufacturer, ac.type].filter(Boolean).join(' ') || null;
      info.registration = ac.registration;
      info.owner = ac.owner;
    }
    if (entry.info?.route) {
      const r = entry.info.route;
      info.from = r.origin ? `${r.origin.iata || ''} ${r.origin.municipality || r.origin.name || ''}`.trim() : null;
      info.to = r.destination ? `${r.destination.iata || ''} ${r.destination.municipality || r.destination.name || ''}`.trim() : null;
      info.airline = r.airline;
    }
    const catLabel = CATEGORY[entry.category]?.label;
    if (catLabel) info.service = catLabel;
    if (entry.isHeli) info.airframe = 'Helicopter';
    return { kind: 'aircraft', name: (s.callsign || '').trim() || entry.id, info, entry };
  }

  pickables() {
    return [...this.planes.values()].filter((e) => e.mesh.visible).map((e) => e.mesh);
  }

  // Build the overhead arrivals report for the bottom board:
  //   overhead — flights currently high in the sky (near the zenith)
  //   inbound  — flights whose real track will carry them overhead soon (ETA)
  // We dead-reckon each flight forward along its great-circle path to predict it.
  overheadReport(observer, { overheadDeg = 45, inboundDeg = 25, windowMin = 15 } = {}) {
    const overhead = [];
    const inbound = [];
    for (const [, e] of this.planes) {
      const s = e.state;
      if (!s || !e.cur) continue;
      const look = lookAngles(observer, e.cur);
      if (look.altitude < 2) continue; // ignore right-at-horizon traffic

      if (look.altitude >= overheadDeg) {
        overhead.push(this._boardItem(e, look.altitude, 0, null, look.range));
        this.requestEnrich(e);
        continue;
      }
      // predict whether/when it climbs toward the zenith
      const pred = this._predictOverhead(observer, e, windowMin);
      if (pred && pred.maxEl >= inboundDeg && pred.etaMin > 0.3 && pred.maxEl > look.altitude + 3) {
        inbound.push(this._boardItem(e, look.altitude, pred.etaMin, pred.maxEl, look.range));
        this.requestEnrich(e);
      }
    }
    overhead.sort((a, b) => b.elevation - a.elevation);
    inbound.sort((a, b) => a.etaMin - b.etaMin);
    return { overhead, inbound };
  }

  _predictOverhead(observer, e, windowMin) {
    const s = e.state;
    if (!s.velocity || s.velocity < 20) return null;
    let maxEl = -90, etaMin = 0;
    const end = windowMin * 60;
    for (let t = 20; t <= end; t += 20) {
      const p = deadReckon(e.cur, s.velocity, s.heading || 0, t);
      p.alt += (s.verticalRate || 0) * Math.min(t, 300); // cap vertical extrapolation
      const look = lookAngles(observer, p);
      if (look.altitude > maxEl) { maxEl = look.altitude; etaMin = t / 60; }
    }
    return { maxEl, etaMin };
  }

  _boardItem(e, elevation, etaMin, maxEl = null, distM = null) {
    const s = e.state;
    const ac = e.info?.aircraft;
    const r = e.info?.route;
    return {
      callsign: (s.callsign || '').trim() || e.id,
      type: ac?.type || '',
      from: r?.origin?.iata || '',
      to: r?.destination?.iata || '',
      altM: s.altitude,
      spdKt: Math.round((s.velocity || 0) * 1.944),
      vRate: s.verticalRate || 0,
      category: e.category,
      isHeli: e.isHeli,
      elevation, etaMin, maxEl, distM,
    };
  }

  // Enrich a few planes per call (lazy, polite). Prioritises the queue.
  async pump(maxPerCall = 2) {
    let done = 0;
    while (this._enrichQueue.length && done < maxPerCall) {
      const entry = this._enrichQueue.shift();
      if (!entry || entry.info || entry.enriching || !this.planes.has(entry.id)) continue;
      this._enrich(entry); done++;
    }
  }

  async _enrich(entry) {
    if (entry.enriching || entry.info) return;
    entry.enriching = true;
    const s = entry.state;
    try {
      const url = `/api/flightinfo?callsign=${encodeURIComponent((s.callsign || '').trim())}&icao24=${encodeURIComponent(entry.id || '')}`;
      entry.info = await (await fetch(url)).json();
      this._reclassify(entry);                     // colour-code + heli swap
      if (this.showLabels && entry.label) this._refreshLabel(entry);
    } catch { /* leave un-enriched */ }
    entry.enriching = false;
  }

  // expose for on-demand enrichment from hover/selection
  requestEnrich(entry) { if (entry && !entry.info && !entry.enriching) this._enrich(entry); }

  _refreshLabel(entry) {
    const f = this.labelFields;
    const s = entry.state;
    const info = entry.info;
    const lines = [];

    // line 1 — callsign (always) + route
    let l1 = (s.callsign || '').trim() || entry.id;
    if (f.route && info?.route?.origin?.iata && info?.route?.destination?.iata) {
      l1 += `  ${info.route.origin.iata}→${info.route.destination.iata}`;
    }
    lines.push(l1);

    // line 2 — type + registration
    const l2 = [];
    if (f.type && info?.aircraft?.type) l2.push(info.aircraft.type);
    if (f.registration && info?.aircraft?.registration) l2.push(info.aircraft.registration);
    if (l2.length) lines.push(l2.join(' '));

    // line 3 — altitude / speed / heading (aviation units: ft, kt)
    const l3 = [];
    if (f.altitude && s.altitude != null) l3.push(`${(Math.round(s.altitude * 3.281 / 100) * 100).toLocaleString()}ft`);
    if (f.speed && s.velocity != null) l3.push(`${Math.round(s.velocity * 1.944)}kt`);
    if (f.heading && s.heading != null) l3.push(`${Math.round(s.heading)}°`);
    if (l3.length) lines.push(l3.join('  '));

    // line 4 — squawk / vertical rate
    const l4 = [];
    if (f.squawk && s.squawk) l4.push(`SQ ${s.squawk}`);
    if (f.vrate && s.verticalRate != null && Math.abs(s.verticalRate) > 0.4) {
      l4.push(`${s.verticalRate > 0 ? '▲' : '▼'}${Math.abs(Math.round(s.verticalRate * 196.85))}fpm`);
    }
    if (l4.length) lines.push(l4.join('  '));

    const text = lines.join('\n');
    if (entry.labelText === text) return;
    entry.labelText = text;
    const fresh = makeTextSprite(text, 0xdff1ff, 22);
    entry.label.material.map?.dispose();
    entry.label.material = fresh.material;
    entry.label.scale.copy(fresh.scale);
  }
}

function makeTrailMaterial(color = 0x9fd8ff) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      attribute float aProgress;
      varying float vP;
      void main() {
        vP = aProgress;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vP;
      void main() {
        // fade out toward the tail (low progress)
        float a = pow(vP, 1.8) * 0.55;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function deadReckon(p, speedMs, headingDeg, dt) {
  if (!speedMs || dt <= 0) return { ...p };
  const distance = speedMs * dt;
  const R = 6371000;
  const hdg = headingDeg * DEG;
  const lat1 = p.lat * DEG, lon1 = p.lon * DEG;
  const ang = distance / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(hdg));
  const lon2 = lon1 + Math.atan2(
    Math.sin(hdg) * Math.sin(ang) * Math.cos(lat1),
    Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
  );
  return { lat: lat2 / DEG, lon: lon2 / DEG, alt: p.alt };
}
