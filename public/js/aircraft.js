// aircraft.js — live planes as real 3D airliners with fading contrails.
//
// Each plane is the genuine reported flight (OpenSky state). We dead-reckon
// between ~12s polls using its true track + ground speed (and vertical rate, so
// it visibly climbs/descends), orient a 3D airliner model along its path, and
// trail a fading contrail behind it. Type + route are enriched on demand from
// adsbdb via our proxy.

import * as THREE from 'three';
import { lookAngles, domePosition, DEG } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';
import { buildAirliner, buildHelicopter, aircraftMaterial } from './plane-model.js';
import { classify, isHelicopter, CATEGORY } from './classify.js';
import { instantiate } from './assets.js';
import { liveryColor } from './airlines.js';
import { EMERGENCY, emergencyFor } from './emergency.js';

// Regexes matching ICAO type designators to a model bucket. Checked in order:
// jumbo (widebody) → bizjet → small GA → airliner (default for everything else,
// which covers narrowbodies, regional jets and turboprops).
// Widebodies. Note: anchored prefixes only — avoid bare numerics or short stems
// like "C5"/"C17" that would clobber Cessna types (C172, C525). Military heavy
// lifters (C-5/C-17) fall to 'fighter' via the military flag instead.
const RE_JUMBO = /^(B74|B77|B78|A38|A35|A34|A33|MD11|L101|DC10|B76|A310|A300|IL9|IL96|A124|A225)/;
const RE_BIZJET = /^(GLF|GLEX|GL\d|G150|G250|G280|G450|G550|G650|LJ\d|LEAR|C25|C50|C51|C52|C55|C56|C5\d\d|C65|C68|C70|C75|CL30|CL35|CL60|CL65|CL85|FA\d|F2TH|F900|E50P|E55P|PRM1|EA50|SF50|HDJT|GALX|BD100|BD700|BE40|MU30|J328|ASTR)/;
// Small general-aviation singles/light twins (real ICAO designators, anchored).
const RE_GA = /^(C150|C152|C162|C170|C172|C175|C177|C180|C182|C185|C190|C195|C206|C205|C207|C208|C210|C310|C337|P28|P32|PA2|PA3|PA4|PA46|PAY|SR20|SR22|S22T|DA40|DA42|DA62|DA20|DV20|BE33|BE35|BE36|BE19|BE23|BE24|BE55|BE58|BE60|BE76|M20|M7|PC12|PC6|TBM7|TBM8|TBM9|RV\d|GA8|AC11|F406|EPIC|COL3|COL4|LNC2)/;

// Map an aircraft to the best-matching 3D model. Prefer the INSTANT ADS-B ICAO
// type (state.type) for accurate, immediate selection; fall back to the slow
// enrichment type and finally the ADS-B emitter category / military flag.
function modelKeyFor(entry) {
  if (entry.isHeli) return 'heli';
  const s = entry.state || {};
  if (entry.category === 'mil' || s.military) return 'fighter';

  const t = (s.type || entry.info?.aircraft?.type || '').toUpperCase().trim();
  if (t) {
    if (RE_JUMBO.test(t)) return 'jumbo';
    if (RE_BIZJET.test(t)) return 'bizjet';
    if (RE_GA.test(t)) return 'cessna';
    return 'airliner'; // narrowbody / regional / turboprop and anything else typed
  }

  // No type string — lean on the ADS-B emitter category as a coarse fallback.
  switch (s.category) {
    case 'A5': return 'jumbo';     // heavy
    case 'A1': return 'cessna';    // light (< 7t)
    case 'A2': return 'cessna';    // small
    default: return 'airliner';
  }
}

// reusable temporaries for the per-frame orientation damping (see update())
const _qPrev = new THREE.Quaternion();
const _qTgt = new THREE.Quaternion();

const POLL_MS = 4_000;
// Real airframe lengths (m) per model bucket — keeps relative sizes honest (a
// Cessna stays smaller than a 747) while VIS_BOOST magnifies everything enough
// to actually SEE what's overhead (this is a ceiling projection, not a telescope).
const LEN_M = { jumbo: 70, airliner: 40, bizjet: 18, cessna: 9, fighter: 17, heli: 14 };
const EYE_HEIGHT_M = 1.83;     // a ~6 ft observer standing at their location
const VIS_BOOST = 9;           // magnification so overhead traffic is clearly visible
const VIS_MIN = 20;            // distant/high traffic still reads as a clear shape (not a speck)
const VIS_MAX = 70;            // free-look cap
const CEIL_BOOST = 2.4;        // extra size in the "see through the roof" ceiling view
const FLYOVER_BOOST = 0.8;     // gentle swell toward the zenith — bounded low-pass emphasis
const VIS_MAX_CEIL = 100;      // ceiling cap — overhead reads big but never fills the screen
const TRAIL_MAX = 48;          // trail nodes
const TRAIL_DT = 180;          // ms between trail samples
const CONTRAIL_MIN_ALT = 7600; // m (~25,000 ft) — contrails only form up high
const SNAP_MS = 500;           // snap-free convergence window after a poll
const MIN_ELEV_DEG = 5;        // hide horizon-skimming traffic (not naked-eye visible)
const MIN_AGL_M = 450;         // hide pattern/approach traffic (~1500 ft AGL and below)

// ADS-B emitter category → human label (surfaced in the info / detail panels).
const EMITTER = {
  A1: 'Light', A2: 'Small', A3: 'Large', A4: 'Large (high-wake)', A5: 'Heavy',
  A6: 'High-performance', A7: 'Rotorcraft', B1: 'Glider', B2: 'Balloon / airship',
  B4: 'UAV', B6: 'Spacecraft', C1: 'Emergency vehicle', C2: 'Service vehicle',
};

// Scratch objects reused every frame to avoid per-plane allocation.
const _fwd = new THREE.Vector3(), _rUp = new THREE.Vector3(), _right = new THREE.Vector3();
const _up = new THREE.Vector3(), _up2 = new THREE.Vector3(), _right2 = new THREE.Vector3();
const _negFwd = new THREE.Vector3(), _UPY = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _lblOff = new THREE.Vector3();   // scratch for label radial offset (no per-frame alloc)

export class AircraftLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'aircraft';
    this.planes = new Map();   // id -> entry
    this.observer = null;
    this.showLabels = false;
    this.catFilter = null;   // null = show all; else {mil,law,ems,civ:boolean} service filter
    this.speakingId = null;  // id of the flight whose ATC feed is currently transmitting
    this.emergencyCode = new Map(); // id -> current emergency code (enter/escalation detect + cleanup)
    this.onIncident = null;  // callback(evt) fired when a flight ENTERS an emergency squawk

    // fallback procedural geometries (used until the glTF models finish loading,
    // or if a model is missing)
    this.geo = { plane: buildAirliner(), heli: buildHelicopter() };
    this.models = null; // filled async with real per-type glTF models

    // trail colour per service category; fallback material per category
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

    // Hovered flight-path legs: orange = where it came from, cyan = where it's going.
    this.pathCame = makePathLine(0xffa033);
    this.pathGoing = makePathLine(0x49d6ff);
    this.group.add(this.pathCame, this.pathGoing);

    this._enrichQueue = [];
    scene.add(this.group);
  }

  // Draw the great-circle flight path of one aircraft, projected onto the sky and
  // clipped at the horizon: origin→plane (came-from) + plane→destination (going-to).
  // Falls back to a heading-extrapolated track when the route isn't known yet.
  showPath(entry, observer) {
    const s = entry?.state;
    // Anchor the path at the plane's SMOOTHED rendered position (not the raw poll
    // position, which steps every 4 s) so the line stays glued to the model and
    // glides instead of snapping. Use the same eye height as the model placement.
    const cur = entry?.render || entry?.cur;
    if (!s || !cur || !this.group.visible) { this.hidePath(); return; }
    const eye = { lat: observer.lat, lon: observer.lon, alt: (observer.alt || 0) + EYE_HEIGHT_M };
    const alt = cur.alt;
    const h = s.heading || 0;
    // Draw ONE clean straight track THROUGH the plane along its real heading: a
    // leg back along the reverse heading (orange = came from) and a leg forward
    // (cyan = going to), each clipped at the horizon. We deliberately do NOT route
    // the line through the origin/destination airports — that great-circle could
    // curve oddly across the dome or, with stale route data, send both legs the
    // same way. The airports still appear as text in the info card.
    const behind = deadReckon(cur, 800000, (h + 180) % 360, 1);
    const ahead = deadReckon(cur, 800000, h, 1);
    buildLegToward(this.pathCame, cur, behind, eye, alt);
    buildLegToward(this.pathGoing, cur, ahead, eye, alt);
  }

  hidePath() { this.pathCame.visible = this.pathGoing.visible = false; }

  setVisible(v) { this.group.visible = v; }

  // Filter which service categories are shown (mil/law/ems/civ). Applies in the dome
  // views; the radar reads the same filter from state.cats. null/all-true = show all.
  setCatFilter(cats) { this.catFilter = cats; }

  // Mark which flight's ATC feed is currently transmitting (adds a teal "on-air" halo).
  setSpeaking(id) { this.speakingId = id || null; }

  // Current in-range aircraft squawking an emergency, most-severe first — powers the
  // distress box + incident log. Range (NM) / bearing are from the observer's eye.
  emergencies(observer) {
    if (!observer) return [];
    const eye = { lat: observer.lat, lon: observer.lon, alt: (observer.alt || 0) + EYE_HEIGHT_M };
    const out = [];
    for (const [, e] of this.planes) {
      const emg = emergencyFor(e.state?.squawk);
      if (!emg) continue;
      const cur = e.render || e.cur;
      if (!cur) continue;
      const look = lookAngles(eye, cur);
      out.push({
        id: e.id, callsign: (e.state.callsign || '').trim() || e.id,
        code: emg.code, label: emg.label, reason: emg.reason, sev: emg.sev, hex: emg.hex,
        rangeNm: look.range / 1852, brgDeg: look.azimuth, altFt: cur.alt * 3.28084,
        type: e.info?.aircraft?.type || e.state.type || '',
      });
    }
    out.sort((a, b) => b.sev - a.sev || a.rangeNm - b.rangeNm);
    return out;
  }

  // Called once the real glTF models finish loading; upgrades every plane.
  setModels(models) {
    this.models = models;
    for (const [, e] of this.planes) this._applyModel(e, true);
  }

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

      // The new truth becomes the dead-reckoning ANCHOR. To avoid a visible snap,
      // we record where the plane was being *displayed* the instant before this
      // poll arrived; update() then eases the rendered position from that old
      // displayed point onto the freshly-anchored prediction over ~0.5 s.
      if (entry.cur && entry.render) {
        entry.snapFrom = { ...entry.render };  // last displayed lat/lon/alt
        entry.snapStart = now;
      }

      // Turn rate from the heading change between this poll and the last, used to
      // bank the aircraft. Measured per-poll (heading only updates per poll), so
      // it stays stable instead of spiking on the one frame the data refreshes.
      const prevHdg = entry.state?.heading;
      if (prevHdg != null && a.heading != null && entry.anchorAt) {
        const pdt = Math.max((now - entry.anchorAt) / 1000, 1e-3);
        const dHdg = ((a.heading - prevHdg + 540) % 360) - 180;
        entry.turnRate = dHdg / pdt;          // deg/s
      } else {
        entry.turnRate = 0;
      }

      entry.cur = { lat: a.lat, lon: a.lon, alt: a.altitude };
      entry.state = a;
      entry.lastSeen = now;
      entry.anchorAt = now;

      // Emergency-squawk transition → log an incident on ENTER or on ESCALATION to a new code.
      const prevCode = this.emergencyCode.get(a.id);
      const isEmg = emergencyFor(a.squawk);
      if (isEmg && isEmg.code !== prevCode) {
        this.emergencyCode.set(a.id, isEmg.code);
        this.onIncident?.({
          id: a.id, callsign: (a.callsign || '').trim() || a.id,
          code: isEmg.code, label: isEmg.label, reason: isEmg.reason, sev: isEmg.sev, hex: isEmg.hex,
        });
      } else if (!isEmg && prevCode) {
        this.emergencyCode.delete(a.id);
      }
    }

    // At a 4 s cadence give an aircraft a few missed polls before we drop it, so
    // brief feed gaps don't make planes blink out.
    for (const [id, entry] of this.planes) {
      if (now - entry.lastSeen > POLL_MS * 4) this._despawn(id, entry);
    }
    return { count: seen.size, time: data.time, stale: data.stale };
  }

  _spawn(a) {
    // trail
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
    tgeo.setAttribute('aProgress', new THREE.BufferAttribute(new Float32Array(TRAIL_MAX), 1));
    tgeo.setDrawRange(0, 0);
    const trail = new THREE.Line(tgeo, this.trailMat.civ);
    trail.frustumCulled = false;
    this.group.add(trail);

    const label = makeTextSprite(a.callsign || a.id, 0xdff1ff, 36);
    label.visible = false;
    this.group.add(label);

    const entry = {
      id: a.id,
      mesh: null, trail, label,
      history: [], lastTrail: 0,
      info: null, enriching: false,
      category: 'civ', isHeli: false, modelKey: null,
      livery: liveryColor(a.callsign),   // airline brand-colour accent (or null)
      state: a,
      render: null,        // last displayed {lat,lon,alt} (for snap-free easing)
      snapFrom: null, snapStart: 0,
      anchorAt: 0,
      bank: 0,             // current roll angle (rad), eased toward target
      turnRate: 0,         // deg/s, measured per-poll
      lastOrientMs: 0,
    };
    this.planes.set(a.id, entry);

    // Immediate classification (ICAO24 → US military) + build the mesh.
    this._reclassify(entry);
    this._enrichQueue.push(entry);  // enrich in background for type/operator
    return entry;
  }

  // Decide category + heli from current state/info, then ensure the right model.
  _reclassify(entry) {
    entry.category = classify(entry.state, entry.info);
    entry.isHeli = isHelicopter(entry.info, entry.state);
    entry.trail.material = this.trailMat[entry.category] || this.trailMat.civ;
    this._applyModel(entry);
  }

  // Swap in the correct per-type model (real glTF if loaded, else procedural).
  _applyModel(entry, force = false) {
    const key = modelKeyFor(entry);
    const usingGlb = !!(this.models && this.models[key]);
    if (!force && entry.mesh && entry.modelKey === key && entry._glb === usingGlb) return;
    const prevMesh = entry.mesh, prevGlb = entry._glb;
    entry.modelKey = key;
    entry._glb = usingGlb;

    if (prevMesh) {
      this.group.remove(prevMesh);
      // glTF instances own per-instance cloned materials (assets.js instantiate);
      // free them on swap. Procedural meshes share this.mat/this.geo — never dispose those.
      if (prevGlb) disposeInstance(prevMesh);
    }
    let mesh;
    if (usingGlb) {
      mesh = instantiate(this.models[key]);   // real model, nose at -Z, unit size
    } else {
      mesh = new THREE.Mesh(this.geo[entry.isHeli ? 'heli' : 'plane'], this.mat[entry.category]);
    }
    mesh.frustumCulled = false;
    this.group.add(mesh);
    entry.mesh = mesh;

    // Capture the model's own (unit-normalised, unrotated) bounding box so nav
    // lights can sit on the ACTUAL airframe — wingtips, nose, tail — rather than
    // a generic placeholder box. Computed now while the mesh is at identity scale.
    mesh.position.set(0, 0, 0); mesh.scale.set(1, 1, 1); mesh.quaternion.identity();
    mesh.updateWorldMatrix(true, true);
    entry.modelBox = new THREE.Box3().setFromObject(mesh);
  }

  _despawn(id, entry) {
    this.group.remove(entry.mesh, entry.trail, entry.label);
    if (entry.aura) { this.group.remove(entry.aura); entry.aura.material.dispose(); }
    entry.trail.geometry.dispose();
    // Free per-instance GPU resources so a 24/7 kiosk with constant plane churn
    // doesn't leak VRAM: cloned glTF materials + the label's CanvasTexture/material.
    if (entry._glb && entry.mesh) disposeInstance(entry.mesh);
    if (entry.label) { entry.label.material.map?.dispose(); entry.label.material.dispose(); }
    this.planes.delete(id);
    this.emergencyCode.delete(id);   // so a re-appearing emergency is treated as a fresh ENTER + re-logged
  }

  update(observer, nowMs) {
    if (!this.group.visible || !observer) return;
    const now = nowMs;
    // Look from the observer's EYES: their ground elevation (MSL) + ~6 ft. Aircraft
    // altitudes are MSL too, so all the look angles/ranges are true to what someone
    // standing here would actually see.
    const eye = { lat: observer.lat, lon: observer.lon, alt: (observer.alt || 0) + EYE_HEIGHT_M };

    for (const [, entry] of this.planes) {
      const s = entry.state;
      if (!s || !entry.cur) continue;

      // Dead-reckon from the latest anchor along the reported great-circle track,
      // applying vertical rate so the plane visibly climbs/descends. The ADS-B
      // position was already `seenPos` seconds old when fetched, so we advance by
      // that PLUS the time since we received it — putting the plane where it truly
      // is right now, not where it was a few seconds ago. Capped to stay sane.
      const sourceAge = Math.min(s.seenPos || 0, 12);
      const dt = Math.min(sourceAge + (now - (entry.anchorAt || entry.lastSeen)) / 1000, 20);
      const projected = deadReckon(entry.cur, s.velocity || 0, s.heading || 0, dt);
      projected.alt += (s.verticalRate || 0) * dt; // climb/descent

      // Snap-free convergence: for a short window after a poll, blend from where
      // the plane was last DISPLAYED toward the freshly-anchored prediction. The
      // new poll's track is usually a continuation of the old one, so the offset
      // is tiny — this just removes the residual jump.
      let displayed = projected;
      if (entry.snapFrom && entry.snapStart) {
        const k = (now - entry.snapStart) / SNAP_MS;
        if (k >= 1) { entry.snapFrom = null; }
        else {
          const e = THREE.MathUtils.smoothstep(k, 0, 1);
          displayed = lerpGeo(entry.snapFrom, projected, e);
        }
      }
      entry.render = displayed; // remember for the next poll's snap-from anchor

      const look = lookAngles(eye, displayed);
      // Only show traffic that's genuinely up in the sky and naked-eye plausible —
      // not skimming the horizon (those are tens-to-hundreds of km away and would
      // be invisible in real life). Also drop anything still in the low climb-out /
      // approach band so we only show aircraft that are actually "up there".
      const aglM = displayed.alt - (observer.alt || 0);
      const catOk = !this.catFilter || this.catFilter[entry.category] !== false;
      const visible = catOk && look.altitude >= MIN_ELEV_DEG && aglM >= MIN_AGL_M;
      entry.mesh.visible = visible;

      if (!visible) { entry.trail.visible = false; if (entry.label) entry.label.visible = false; if (entry.aura) entry.aura.visible = false; continue; }

      const pos = domePosition(look.azimuth, look.altitude, SHELLS.aircraft);
      entry.mesh.position.copy(pos);

      // Size from true angular size (length / slant-range) scaled up by VIS_BOOST
      // so traffic is actually visible, with per-type lengths keeping a Cessna
      // smaller than a jumbo. The ceiling/fisheye projector view — the "seeing
      // through the roof" mode — gets a uniform extra bump (NOT a per-angle swell,
      // which distorted the model up close) so overhead planes read clearly.
      const lenM = LEN_M[entry.modelKey] || (entry.isHeli ? LEN_M.heli : LEN_M.airliner);
      // Slant-range floor (3 km): a genuinely-close low plane can no longer balloon
      // unbounded — the principled cap on "low planes are huge" — while distant traffic
      // (range > 3 km) is untouched, so only the runaway near case is clamped.
      let sc = SHELLS.aircraft * lenM * VIS_BOOST / Math.max(look.range, 3000);
      let cap = VIS_MAX;
      if (this.ceilingMode) {
        // Low-flyover drama: as a plane climbs toward the zenith — which is screen
        // CENTRE in the ceiling/fisheye view, where perspective distortion is least —
        // swell it up so an overhead pass reads like a dramatic low flyover and you can
        // actually see the airframe + livery. Distant/horizon traffic stays normal-sized
        // (and undistorted near the frame edge). The swell is uniform (setScalar), so the
        // model never stretches — it just gets closer-looking the more overhead it is.
        const zen = THREE.MathUtils.clamp((look.altitude - 25) / 65, 0, 1); // 0 @25° → 1 @zenith
        sc *= CEIL_BOOST * (1 + FLYOVER_BOOST * zen * zen);
        // De-emphasise low, near-the-mask-rim traffic (still slightly perspective-stretched
        // at the frame edge): taper it down so the eye stays on the clean overhead cone.
        // Full size by ~45° elevation, ~60% at ~20°.
        const edge = THREE.MathUtils.smoothstep(look.altitude, 20, 45);
        sc *= 0.6 + 0.4 * edge;
        cap = VIS_MAX_CEIL;
      }
      entry.mesh.scale.setScalar(THREE.MathUtils.clamp(sc, VIS_MIN, cap));

      // ---- Orientation: LEVEL FLIGHT (up = world up, yaw to heading) ----
      // Real aircraft fly level, so the model's UP is simply world up (+Y) and it
      // only yaws to its heading — no roll, no pitch. Tying "up" to the radial made
      // every plane tip a different way (looked rolled); world-up keeps them all
      // consistently flat. Belly faces down, so looking up at the ceiling you get a
      // clean top-down planform, and from the side (free look) it flies level. The
      // nose follows the HORIZONTAL apparent track. (Models calibrated nose=+Z, top=+Y.)
      const fwdSpeed = Math.max(s.velocity || 0, 55);
      const aheadGeo = deadReckon(displayed, fwdSpeed, s.heading || 0, 2.5);
      const aheadLook = lookAngles(eye, aheadGeo);
      const aheadPos = domePosition(aheadLook.azimuth, aheadLook.altitude, SHELLS.aircraft);
      // Ceiling / fisheye (looking UP through the roof): the belly must face the viewer at
      // EVERY elevation, so "up" is the RADIAL from the dome centre (pos). This presents a
      // clean top-down planform overhead and removes the edge-on / rolled look off-zenith
      // that wide-FOV perspective was exaggerating. Free look keeps world-up level flight.
      if (this.ceilingMode) _up.copy(pos).normalize(); else _up.set(0, 1, 0);
      _fwd.copy(aheadPos).sub(pos);
      if (!this.ceilingMode) _fwd.y = 0;               // free look: horizontal heading only
      if (_fwd.lengthSq() > 1e-8) {
        _fwd.normalize();
        _right.crossVectors(_up, _fwd).normalize();
        _fwd.crossVectors(_right, _up).normalize();    // re-orthogonalise nose ⟂ up (no shear)
        _m.makeBasis(_right, _up, _fwd);               // +X right, +Y up, +Z = nose
        _qTgt.setFromRotationMatrix(_m);
        // Ease toward the new heading and clamp the per-frame turn, so the fast
        // azimuth swing as a plane crosses the zenith glides instead of snapping.
        if (entry._oriented) {
          _qPrev.copy(entry.mesh.quaternion);
          const ang = _qPrev.angleTo(_qTgt);
          let blend = 0.2;
          if (ang > 1e-4) blend = Math.min(blend, 0.14 / ang);
          entry.mesh.quaternion.copy(_qPrev).slerp(_qTgt, THREE.MathUtils.clamp(blend, 0, 1));
        } else {
          entry.mesh.quaternion.copy(_qTgt);
          entry._oriented = true;
        }
      }

      // EMERGENCY: a serious transponder squawk gives the aircraft a pulsing
      // aura — yellow for lost-comms, red for general emergency / hijack, pulsing
      // faster and brighter with severity so it's instantly spottable.
      const emg = EMERGENCY[s.squawk];
      const speaking = entry.id === this.speakingId;
      if (emg || speaking) {
        if (!entry.aura) { entry.aura = makeAura(); this.group.add(entry.aura); }
        entry.aura.visible = true;
        entry.aura.position.copy(pos);
        if (emg) {
          // Emergency: red/amber, pulsing faster + brighter with severity.
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.001 * (4 + emg.sev * 6));
          entry.aura.scale.setScalar(entry.mesh.scale.x * (4 + emg.sev * 3) * (0.8 + 0.35 * pulse));
          entry.aura.material.color.setHex(emg.color);
          entry.aura.material.opacity = (0.22 + 0.6 * pulse) * (0.6 + 0.4 * emg.sev);
        } else {
          // ATC transmitting on this flight's feed: a calm teal "on-air" halo.
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
          entry.aura.scale.setScalar(entry.mesh.scale.x * 3.2 * (0.85 + 0.25 * pulse));
          entry.aura.material.color.setHex(0x24d3c9);
          entry.aura.material.opacity = 0.18 + 0.32 * pulse;
        }
      } else if (entry.aura) {
        entry.aura.visible = false;
      }

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
        _lblOff.copy(pos).normalize();
        entry.label.position.copy(pos).addScaledVector(_lblOff, 16);
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
      // instant ICAO type from ADS-B; replaced by the richer enriched name below
      type: entry.info?.aircraft?.type || s.type || 'Aircraft',
      callsign: s.callsign || '(none)',
      country: s.country,
      // Aircraft altitude in FEET (aviation standard / native ADS-B unit).
      altitude: `${Math.round(s.altitude * 3.28084).toLocaleString()} ft`,
      speed: `${Math.round((s.velocity || 0) * 3.6)} km/h`,
      heading: `${Math.round(s.heading || 0)}°`,
      squawk: s.squawk || null,
      azimuth: look.azimuth, altitude_deg: look.altitude,
      icao24: entry.id,
      rangeKm: look.range / 1000,
      emitter: EMITTER[s.category] || null,
    };
    if (s.verticalRate != null && Math.abs(s.verticalRate) > 0.4) {
      info.vspeed = `${s.verticalRate > 0 ? '▲' : '▼'} ${Math.abs(Math.round(s.verticalRate * 196.85)).toLocaleString()} fpm`;
      info.phase = s.verticalRate > 0 ? 'Climbing' : 'Descending';
    } else { info.phase = 'Level'; }
    const emgU = emergencyFor(s.squawk);
    if (emgU) info.squawkAlert = `${emgU.code} · ${emgU.label}`;
    if (entry.info?.aircraft) {
      const ac = entry.info.aircraft;
      info.aircraftType = [ac.manufacturer, ac.type].filter(Boolean).join(' ') || null;
      info.registration = ac.registration || s.registration;
      info.owner = ac.owner;
    } else if (s.registration) {
      info.registration = s.registration;
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
  overheadReport(observer, { overheadDeg = 45, windowMin = 10 } = {}) {
    const overhead = [];
    const inbound = [];
    const eye = { lat: observer.lat, lon: observer.lon, alt: (observer.alt || 0) + EYE_HEIGHT_M };
    for (const [, e] of this.planes) {
      const s = e.state;
      if (!s || !e.cur) continue;
      const cur = e.render || e.cur;
      const look = lookAngles(eye, cur);

      if (look.altitude >= overheadDeg) {                 // genuinely overhead now
        overhead.push(this._boardItem(e, look.altitude, 0, null, look.range));
        this.requestEnrich(e);
        continue;
      }
      if (look.altitude < MIN_ELEV_DEG) continue;         // not even up in the sky yet
      // INBOUND = its actual track will carry it INTO the overhead cone (>= overheadDeg)
      // within the window. ETA is the interpolated time it crosses that threshold —
      // a well-defined event, so the countdown is stable instead of jumping.
      const pred = this._predictOverhead(eye, e, windowMin, overheadDeg);
      if (pred) {
        inbound.push(this._boardItem(e, look.altitude, pred.etaSec / 60, pred.maxEl, look.range));
        this.requestEnrich(e);
      }
    }
    overhead.sort((a, b) => b.elevation - a.elevation);
    inbound.sort((a, b) => a.etaMin - b.etaMin);
    return { overhead, inbound };
  }

  // The single plane closest to the zenith right now (>= overheadDeg), or null.
  // Returns the live `entry` (with .cur and .state) so the caller can auto-tune
  // that aircraft's nearest ATC facility hands-free, without a plane being hovered.
  topOverheadEntry(observer, overheadDeg = 45) {
    const eye = { lat: observer.lat, lon: observer.lon, alt: (observer.alt || 0) + EYE_HEIGHT_M };
    let best = null, bestEl = overheadDeg;
    for (const [, e] of this.planes) {
      if (!e.state || !e.cur) continue;
      const el = lookAngles(eye, e.render || e.cur).altitude;
      if (el >= bestEl) { bestEl = el; best = e; }
    }
    return best;
  }

  // Returns { maxEl, etaSec } only if the flight will actually cross into the
  // overhead cone within the window; null otherwise (so we never list traffic
  // that isn't really going to pass over). etaSec is interpolated for smoothness.
  _predictOverhead(eye, e, windowMin, overheadDeg) {
    const s = e.state;
    if (!s.velocity || s.velocity < 25) return null;       // parked/hovering — no pass
    const cur = e.render || e.cur;
    let maxEl = lookAngles(eye, cur).altitude;
    let prevEl = maxEl, etaSec = null;
    const end = windowMin * 60, step = 15;
    for (let t = step; t <= end; t += step) {
      const p = deadReckon(cur, s.velocity, s.heading || 0, t);
      p.alt += (s.verticalRate || 0) * Math.min(t, 300);   // cap vertical extrapolation
      const el = lookAngles(eye, p).altitude;
      if (el > maxEl) maxEl = el;
      if (etaSec == null && prevEl < overheadDeg && el >= overheadDeg) {
        const frac = (overheadDeg - prevEl) / ((el - prevEl) || 1);
        etaSec = (t - step) + frac * step;
      }
      prevEl = el;
    }
    return etaSec == null ? null : { maxEl, etaSec };
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
      // The plane can despawn during the in-flight fetch (requestEnrich from hover
      // skips the pre-check entirely). Rebuilding its mesh now would add() a brand-new
      // orphan Object3D that's never updated, picked, or removed — a permanent leak.
      if (!this.planes.has(entry.id)) return;
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

    // line 2 — type + registration (instant from ADS-B, enrichment refines it)
    const l2 = [];
    const typeStr = info?.aircraft?.type || s.type;
    const regStr = info?.aircraft?.registration || s.registration;
    if (f.type && typeStr) l2.push(typeStr);
    if (f.registration && regStr) l2.push(regStr);
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
    const fresh = makeTextSprite(text, 0xdff1ff, 36);
    const old = entry.label.material;
    entry.label.material = fresh.material;
    entry.label.scale.copy(fresh.scale);
    old.map?.dispose();
    old.dispose();               // free the old SpriteMaterial too, not just its texture
  }
}

// Soft radial glow sprite for the emergency aura (tinted per severity at runtime).
let _auraTex;
function auraTexture() {
  if (_auraTex) return _auraTex;
  const s = 128, c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  _auraTex = new THREE.CanvasTexture(c);
  return _auraTex;
}
function makeAura() {
  const mat = new THREE.SpriteMaterial({
    map: auraTexture(), color: 0xffffff, transparent: true,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sp = new THREE.Sprite(mat);
  sp.frustumCulled = false; sp.renderOrder = 4;
  return sp;
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

const PATH_MAX = 256;
function makePathLine(color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_MAX * 3), 3));
  g.setDrawRange(0, 0);
  // Normal blending (not additive): additive over the bright daytime sky washes the
  // orange/cyan toward white so you can't tell the legs apart. Normal keeps them true.
  const m = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.95, depthTest: false,
  });
  const line = new THREE.Line(g, m);
  line.frustumCulled = false; line.visible = false; line.renderOrder = 6;
  return line;
}

// Step from the aircraft toward a target point along their great circle, in fixed
// distance increments, projecting each to the dome and stopping at the horizon.
const _A = new THREE.Vector3(), _B = new THREE.Vector3(), _V = new THREE.Vector3();
function buildLegToward(line, cur, target, observer, alt, stepM = 14000) {
  toUnit(cur, _A); toUnit(target, _B);
  const omega = Math.acos(THREE.MathUtils.clamp(_A.dot(_B), -1, 1));
  const Dm = omega * 6371000;
  const so = Math.sin(omega);
  const arr = line.geometry.attributes.position.array;
  let n = 0;
  for (let d = 0; d <= Dm + 1; d += stepM) {
    const f = Dm > 0 ? Math.min(d / Dm, 1) : 0;
    let lat, lon;
    if (so < 1e-6) { lat = cur.lat; lon = cur.lon; } else {
      const s1 = Math.sin((1 - f) * omega) / so, s2 = Math.sin(f * omega) / so;
      _V.set(_A.x * s1 + _B.x * s2, _A.y * s1 + _B.y * s2, _A.z * s1 + _B.z * s2).normalize();
      lat = Math.asin(_V.z) / DEG; lon = Math.atan2(_V.y, _V.x) / DEG;
    }
    const look = lookAngles(observer, { lat, lon, alt });
    if (look.altitude < -0.6 && d > 0) break; // dipped below the horizon
    const dp = domePosition(look.azimuth, Math.max(look.altitude, -0.6), SHELLS.aircraft);
    if (n >= PATH_MAX) break;
    arr[n * 3] = dp.x; arr[n * 3 + 1] = dp.y; arr[n * 3 + 2] = dp.z; n++;
  }
  line.geometry.setDrawRange(0, n);
  line.geometry.attributes.position.needsUpdate = true;
  line.geometry.computeBoundingSphere();
  line.visible = n >= 2;
}

function toUnit(p, out) {
  const la = p.lat * DEG, lo = p.lon * DEG, c = Math.cos(la);
  return out.set(c * Math.cos(lo), c * Math.sin(lo), Math.sin(la));
}

// Free a glTF instance's per-instance cloned materials (see assets.js instantiate,
// which clones materials but SHARES geometry — so never dispose the geometry here).
function disposeInstance(obj) {
  obj.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) m.dispose();
  });
}

// Linear blend between two geodetic points. Longitude is wrapped to the short way
// so a blend across the antimeridian doesn't sweep the long way round the globe.
function lerpGeo(a, b, t) {
  let dlon = ((b.lon - a.lon + 540) % 360) - 180;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + dlon * t,
    alt: a.alt + (b.alt - a.alt) * t,
  };
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
