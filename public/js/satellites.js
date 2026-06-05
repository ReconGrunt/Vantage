// satellites.js — real orbiting objects. TLEs come from CelesTrak (via our
// proxy) and are propagated locally every frame with SGP4 (satellite.js), so
// each dot is the genuine tracked object at its true look-angle from you.

import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { domePosition, DEG } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

export class SatelliteLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'satellites';
    this.satrecs = [];     // { name, satrec }
    this.group_name = 'visual';

    // One Points cloud for all sats — fast even with thousands.
    this.geom = new THREE.BufferGeometry();
    this.geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    this.points = new THREE.Points(this.geom, new THREE.PointsMaterial({
      color: 0x7CFFB2, size: 7, sizeAttenuation: false,
      map: dotTexture(0x7CFFB2), transparent: true, depthTest: false,
    }));
    this.group.add(this.points);

    // A floating label for the currently highlighted sat (e.g. ISS).
    this.highlightLabel = makeTextSprite('', 0x7CFFB2, 24);
    this.highlightLabel.visible = false;
    this.group.add(this.highlightLabel);

    this.visibleSats = []; // parallel to point positions, for picking
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }

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
    return this.satrecs.length;
  }

  update(observer, date) {
    if (!this.group.visible || !this.satrecs.length) return;

    const gmst = satellite.gstime(date);
    const observerGd = {
      longitude: observer.lon * DEG,
      latitude: observer.lat * DEG,
      height: (observer.alt || 0) / 1000, // km
    };

    const positions = [];
    this.visibleSats = [];
    let issPos = null;

    for (const { name, satrec } of this.satrecs) {
      const pv = satellite.propagate(satrec, date);
      if (!pv || !pv.position) continue;
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const altDeg = look.elevation * (180 / Math.PI);
      if (altDeg < 0) continue; // below horizon

      const azDeg = (look.azimuth * (180 / Math.PI) + 360) % 360;
      const p = domePosition(azDeg, altDeg, SHELLS.satellites);
      positions.push(p.x, p.y, p.z);

      // height above Earth (km) and orbital speed (km/s)
      const gd = satellite.eciToGeodetic(pv.position, gmst);
      const v = pv.velocity;
      const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null;

      this.visibleSats.push({
        name, azimuth: azDeg, altitude: altDeg, rangeKm: look.rangeSat,
        heightKm: gd.height, speedKmS: speed, satrec,
      });

      if (/ISS|ZARYA/i.test(name)) {
        issPos = { p, name, heightKm: gd.height, speed };
      }
    }

    this.geom.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(positions), 3));
    this.geom.computeBoundingSphere();

    if (issPos) {
      this.highlightLabel.visible = true;
      this.highlightLabel.position.copy(issPos.p.clone());
      this.highlightLabel.position.y += 14;
      const txt = `ISS\n${Math.round(issPos.heightKm)} km  ${(issPos.speed || 0).toFixed(1)} km/s`;
      this._setLabel(txt);
    } else {
      this.highlightLabel.visible = false;
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
    const fresh = makeTextSprite(text, 0x7CFFB2, 24);
    this.highlightLabel.material = fresh.material;
    this.highlightLabel.scale.copy(fresh.scale);
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
