// meteors.js — shooting stars that are TRUE to the date, time and location.
//
// Real meteors are not random streaks: most belong to annual SHOWERS, each radiating
// from a fixed point on the sky (its "radiant") and only active around a known peak
// date. The rest are sporadic background meteors. This layer models that:
//
//   • A table of the major annual showers (radiant RA/Dec, peak date, ZHR). For the
//     current date we compute each shower's activity (a Gaussian around its peak) and
//     rotate its radiant into the observer's local sky using the sidereal time + their
//     latitude/longitude — exactly the frame the stars use. A shower only produces
//     meteors while its radiant is above the horizon.
//   • Shower meteors stream radially AWAY from the radiant (the real, beautiful effect).
//   • Sporadic background meteors fall toward the horizon (a downward-biased streak).
//
// So on, say, Aug 12 you get a busy Perseid shower out of Perseus; in mid-June (a quiet
// period) you get the occasional sporadic — honest to the real sky. Meteors only appear
// in real darkness and clear-ish skies. Streaks are pooled: zero per-frame heap
// allocation in steady state.

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { SHELLS } from './sky.js';
import { DEG } from './coords.js';

const R = SHELLS.stars;          // meteors streak across the star shell
const POOL = 14;                 // reusable streaks (ample even at a shower peak)
const SEG = 14;                  // points per streak (head .. tail)
const HEAD_COLOR = new THREE.Color(0.85, 0.93, 1.0);  // cool white-blue head
const TAIL_COLOR = new THREE.Color(1.0, 0.74, 0.5);   // warm fading tip

// VIS: a gentle visibility boost over the true observed rate — same "magnify so you can
// actually see it" philosophy the app uses for planes and the Sun/Moon. 1.0 = literal.
const VIS = 1.8;
// Sporadic background: ~10–15 meteors/hour under a dark sky, all year round.
const SPORADIC_ZHR = 13;

// Major annual showers. radiant = J2000 (RA, Dec) in degrees; peak = (month, day);
// hw = activity half-width in days (Gaussian sigma); zhr = zenithal hourly rate at peak;
// v = relative speed/length class 0..1 (fast showers draw longer, swifter streaks).
const SHOWERS = [
  { name: 'Quadrantids',     ra: 230, dec: 49,  m: 1,  d: 3,  hw: 0.8, zhr: 110, v: 0.85 },
  { name: 'Lyrids',          ra: 271, dec: 34,  m: 4,  d: 22, hw: 2.0, zhr: 18,  v: 0.90 },
  { name: 'Eta Aquariids',   ra: 338, dec: -1,  m: 5,  d: 6,  hw: 5.0, zhr: 50,  v: 1.00 },
  { name: 'Delta Aquariids', ra: 340, dec: -16, m: 7,  d: 30, hw: 8.0, zhr: 25,  v: 0.55 },
  { name: 'Perseids',        ra: 48,  dec: 58,  m: 8,  d: 12, hw: 6.0, zhr: 100, v: 0.95 },
  { name: 'Orionids',        ra: 95,  dec: 16,  m: 10, d: 21, hw: 6.0, zhr: 20,  v: 1.00 },
  { name: 'Leonids',         ra: 152, dec: 22,  m: 11, d: 17, hw: 3.0, zhr: 15,  v: 1.00 },
  { name: 'Geminids',        ra: 112, dec: 33,  m: 12, d: 14, hw: 4.0, zhr: 120, v: 0.55 },
  { name: 'Ursids',          ra: 217, dec: 76,  m: 12, d: 22, hw: 3.0, zhr: 10,  v: 0.55 },
];

// Module-scope scratch — the per-frame advance loop allocates nothing.
const _S = new THREE.Vector3();      // start (unit)
const _D = new THREE.Vector3();      // velocity (unit)
const _T = new THREE.Vector3();      // scratch
const _head = new THREE.Vector3();
const _tail = new THREE.Vector3();
const _DOWN = new THREE.Vector3(0, -1, 0);

export class MeteorLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'meteors';
    this.group.renderOrder = -1;     // background sky

    this.meteors = [];
    for (let i = 0; i < POOL; i++) {
      const positions = new Float32Array(SEG * 3);
      const colors = new Float32Array(SEG * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      line.raycast = () => {};
      this.group.add(line);
      this.meteors.push({
        line, positions, colors,
        pos: geo.getAttribute('position'), col: geo.getAttribute('color'),
        active: false, age: 0, life: 1, speed: 0, trailBase: 0.05,
        sx: 0, sy: 0, sz: 0, dx: 1, dy: 0, dz: 0,
      });
    }

    this._sources = [];      // [{ type, vec, v, weight }] rebuilt ~1 Hz
    this._ratePerHr = SPORADIC_ZHR;
    this._lastElapsed = 0;
    this._lastCalc = -999;
    this._obsKey = '';
    this._visible = true;
    scene.add(this.group);
  }

  setVisible(on) {
    this._visible = on;
    this.group.visible = on;
    if (!on) for (const m of this.meteors) { m.active = false; m.line.visible = false; }
  }

  // observer = { lat, lon }; date = current Date; elapsed = seconds; nightFactor 0..1;
  // cloudCover 0..1. Meteors only appear in real darkness and clear-ish skies, from the
  // showers actually active for this date/location (plus sporadics).
  update(observer, date, elapsed, nightFactor, cloudCover) {
    if (!this._visible) return;

    let dt = elapsed - this._lastElapsed;
    this._lastElapsed = elapsed;
    if (dt <= 0 || dt > 0.1) dt = Math.min(Math.max(dt, 0), 0.1);

    // Refresh active showers + radiant positions ~1 Hz (they drift slowly) or on a move.
    if (observer && date) {
      const key = `${observer.lat.toFixed(2)},${observer.lon.toFixed(2)}`;
      if (elapsed - this._lastCalc > 1 || key !== this._obsKey) {
        this._recalc(observer, date);
        this._lastCalc = elapsed; this._obsKey = key;
      }
    }

    // Darkness × clarity gate. nightFactor² keeps meteors a true-night thing.
    const gate = nightFactor * nightFactor * Math.max(0, 1 - cloudCover);
    if (gate > 0.01) {
      const perSec = (this._ratePerHr / 3600) * gate * VIS;
      if (Math.random() < perSec * dt) this._spawn();
    }

    for (let i = 0; i < this.meteors.length; i++) {
      const m = this.meteors[i];
      if (!m.active) continue;
      m.age += dt;
      const tNorm = m.age / m.life;
      if (tNorm >= 1) { m.active = false; m.line.visible = false; continue; }
      this._writeStreak(m, tNorm);
    }
  }

  // The single active shower with the most meteors right now (for a UI badge), or null.
  activeShower() { return this._topShower || null; }

  // Rebuild the weighted spawn sources for the current date/location.
  _recalc(observer, date) {
    const sources = this._sources;
    sources.length = 0;
    // sporadic background is always present
    sources.push({ type: 'sporadic', vec: null, v: 0.6, weight: SPORADIC_ZHR });
    let total = SPORADIC_ZHR;
    let topW = 0; this._topShower = null;

    for (const s of SHOWERS) {
      const act = showerActivity(s, date);
      if (act < 0.02) continue;                         // not in season
      const rad = radiantDir(s.ra, s.dec, observer, date);
      if (rad.altDeg <= 2) continue;                    // radiant below the horizon
      // Observed rate scales with ZHR, activity, and how high the radiant sits.
      const eff = s.zhr * act * Math.sin(rad.altDeg * DEG);
      if (eff < 0.2) continue;
      sources.push({ type: 'shower', vec: rad.vec, v: s.v, weight: eff });
      total += eff;
      if (eff > topW) { topW = eff; this._topShower = s.name; }
    }
    this._ratePerHr = total;
  }

  _spawn() {
    // Pick a free streak.
    let m = null;
    for (let i = 0; i < this.meteors.length; i++) {
      if (!this.meteors[i].active) { m = this.meteors[i]; break; }
    }
    if (!m) return;

    // Choose a source weighted by its rate.
    const src = this._pickSource();

    // Start point: a random spot in the visible upper sky.
    const az = Math.random() * 360;
    const alt = 15 + Math.random() * 65;     // 15°..80°
    azAltInto(_S, az, alt);                  // unit start direction

    if (src && src.type === 'shower' && src.vec) {
      // Velocity = tangent at _S pointing AWAY from the radiant → meteors stream out
      // of the radiant, the real shower look. (Project (S − radiant) onto S's tangent.)
      _T.copy(_S).sub(src.vec);
      tangent(_D, _S, _T);
    } else {
      // Sporadic: fall toward the horizon — a downward-biased tangent with some spread.
      tangent(_D, _S, _DOWN);                // steepest-descent direction at _S
      _T.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      tangent(_T, _S, _T);                   // a random tangent for variety
      _D.addScaledVector(_T, 0.6).normalize();
    }
    if (_D.lengthSq() < 1e-6) { _D.set(1, 0, 0); }

    const v = src ? src.v : 0.6;
    m.active = true;
    m.age = 0;
    m.life = 0.45 + Math.random() * 0.7;     // 0.45 .. 1.15 s
    m.speed = (0.09 + 0.07 * v) * R / m.life;
    m.trailBase = 0.04 + 0.05 * v;           // faster showers draw longer streaks
    m.sx = _S.x * R; m.sy = _S.y * R; m.sz = _S.z * R;
    m.dx = _D.x; m.dy = _D.y; m.dz = _D.z;

    this._writeStreak(m, 0);
    m.line.visible = true;
  }

  _pickSource() {
    const sources = this._sources;
    if (!sources.length) return null;
    let r = Math.random() * this._ratePerHr;
    for (let i = 0; i < sources.length; i++) {
      r -= sources[i].weight;
      if (r <= 0) return sources[i];
    }
    return sources[0];
  }

  // Write the SEG-point streak (head leads, tail trails along −velocity) + the baked
  // head→tail colour gradient scaled by the life-fade. Pure buffer writes, no alloc.
  _writeStreak(m, tNorm) {
    const travel = m.speed * m.age;
    _D.set(m.dx, m.dy, m.dz);
    _head.set(m.sx, m.sy, m.sz).addScaledVector(_D, travel);
    const fade = 1 - tNorm;
    const trailLen = (m.trailBase * (0.6 + 0.4 * fade)) * R;

    const pos = m.positions, col = m.colors;
    for (let i = 0; i < SEG; i++) {
      const f = i / (SEG - 1);                // 0 = head .. 1 = tail
      _tail.copy(_head).addScaledVector(_D, -f * trailLen);
      const k = i * 3;
      pos[k] = _tail.x; pos[k + 1] = _tail.y; pos[k + 2] = _tail.z;
      const along = 1 - f;
      const bright = along * along * fade;    // bright head, quadratic falloff, life-fade
      col[k]     = (HEAD_COLOR.r * (1 - f) + TAIL_COLOR.r * f) * bright;
      col[k + 1] = (HEAD_COLOR.g * (1 - f) + TAIL_COLOR.g * f) * bright;
      col[k + 2] = (HEAD_COLOR.b * (1 - f) + TAIL_COLOR.b * f) * bright;
    }
    m.pos.needsUpdate = true;
    m.col.needsUpdate = true;
  }
}

// --- helpers ---

// Write az/alt (deg) as a unit world vector (East +X, Up +Y, North −Z) into `out`.
function azAltInto(out, azDeg, altDeg) {
  const az = azDeg * DEG, al = altDeg * DEG, ca = Math.cos(al);
  return out.set(ca * Math.sin(az), Math.sin(al), -ca * Math.cos(az));
}

// Component of `v` tangent to the unit sphere at unit point `s` (remove the radial
// part), normalised, written into `out`. out and v may alias.
function tangent(out, s, v) {
  const d = v.x * s.x + v.y * s.y + v.z * s.z;
  out.set(v.x - d * s.x, v.y - d * s.y, v.z - d * s.z);
  const len = out.length();
  if (len > 1e-6) out.multiplyScalar(1 / len);
  return out;
}

// Activity 0..1 for a shower on `date` — a Gaussian around this year's peak day.
function showerActivity(s, date) {
  const year = date.getUTCFullYear();
  const peak = Date.UTC(year, s.m - 1, s.d);
  let dd = (date.getTime() - peak) / 86400000;          // days from peak
  if (dd > 182) dd -= 365; else if (dd < -182) dd += 365; // nearest occurrence
  return Math.exp(-(dd * dd) / (2 * s.hw * s.hw));
}

// Radiant (RA/Dec J2000, deg) → local horizontal, then a world unit vector. Uses the
// Greenwich sidereal time + observer lon for the hour angle and lat for the altitude —
// the same equatorial→horizontal transform the star field uses.
function radiantDir(raDeg, decDeg, observer, date) {
  const gast = Astronomy.SiderealTime(date);            // hours, Greenwich
  const lstDeg = gast * 15 + observer.lon;              // local sidereal time, deg
  const ha = (lstDeg - raDeg) * DEG;                    // hour angle
  const dec = decDeg * DEG, lat = observer.lat * DEG;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAlt = Math.cos(alt) || 1e-6;
  const sinAz = -Math.sin(ha) * Math.cos(dec) / cosAlt;
  const cosAz = (Math.sin(dec) - Math.sin(lat) * sinAlt) / ((Math.cos(lat) * cosAlt) || 1e-6);
  const azDeg = (Math.atan2(sinAz, cosAz) / DEG + 360) % 360;
  const vec = new THREE.Vector3();
  azAltInto(vec, azDeg, alt / DEG);
  return { vec, altDeg: alt / DEG };
}
