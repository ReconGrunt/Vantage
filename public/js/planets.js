// planets.js — Sun, Moon, and the naked-eye planets, computed locally with
// astronomy-engine (no network, no key). Positions are real ephemerides; sizes
// and colours are chosen for legibility but each body is the genuine article at
// its true az/alt.

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { domePosition, azAltToVector } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

const BODIES = [
  { name: 'Sun', color: 0xfff2b0, size: 26, glow: true },
  { name: 'Moon', color: 0xdfe6ee, size: 22, glow: true, phase: true },
  { name: 'Mercury', color: 0xb9b2a6, size: 7 },
  { name: 'Venus', color: 0xfff0c2, size: 12 },
  { name: 'Mars', color: 0xff7043, size: 9 },
  { name: 'Jupiter', color: 0xe8d3a2, size: 16 },
  { name: 'Saturn', color: 0xe4c98a, size: 14 },
  { name: 'Uranus', color: 0x9fd6e0, size: 8 },
  { name: 'Neptune', color: 0x6f8fe8, size: 8 },
];

export class PlanetLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'planets';
    this.objects = [];
    this.pickables = [];
    this.sunDir = new THREE.Vector3(0, 1, 0); // world direction toward the Sun
    this.sunAltitude = -90;                    // degrees

    for (const b of BODIES) {
      const mat = new THREE.SpriteMaterial({
        map: discTexture(b.color, b.glow),
        depthTest: false, transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(b.size, b.size, 1);

      const label = makeTextSprite(b.name, 0xcfe0f0, 26);
      label.userData.offset = b.size * 0.55;

      sprite.userData = {
        kind: 'planet', name: b.name, label,
        info: { type: 'Solar System body' },
      };

      this.group.add(sprite);
      this.group.add(label);
      this.objects.push({ def: b, sprite, label });
      this.pickables.push(sprite);
    }
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }

  // observer: { lat, lon, alt }   date: JS Date
  update(observer, date) {
    const time = Astronomy.MakeTime(date);
    const obs = new Astronomy.Observer(observer.lat, observer.lon, observer.alt || 0);

    // Always track the Sun's direction so it can light the rest of the scene,
    // even when the planet layer itself is hidden.
    try {
      const sunEqu = Astronomy.Equator(Astronomy.Body.Sun, time, obs, true, true);
      const sunHor = Astronomy.Horizon(time, obs, sunEqu.ra, sunEqu.dec, 'normal');
      this.sunDir.copy(azAltToVector(sunHor.azimuth, sunHor.altitude));
      this.sunAltitude = sunHor.altitude;
    } catch { /* keep last */ }

    if (!this.group.visible) return;

    for (const o of this.objects) {
      const body = Astronomy.Body[o.def.name];
      let ra, dec;
      try {
        const equ = Astronomy.Equator(body, time, obs, true, true); // of-date, aberration
        ra = equ.ra; dec = equ.dec;
      } catch {
        o.sprite.visible = false; o.label.visible = false; continue;
      }
      const hor = Astronomy.Horizon(time, obs, ra, dec, 'normal'); // refracted

      const above = hor.altitude > -2;
      o.sprite.visible = above;
      o.label.visible = above && o.def.size >= 12; // only label the bright ones

      if (above) {
        const pos = domePosition(hor.azimuth, hor.altitude, SHELLS.planets);
        o.sprite.position.copy(pos);
        o.label.position.copy(pos.clone().multiplyScalar(1.0));
        o.label.position.y += o.def.size * 0.9;
        o.sprite.userData.info = {
          type: o.def.name === 'Sun' || o.def.name === 'Moon' ? o.def.name : 'Planet',
          azimuth: hor.azimuth, altitude: hor.altitude,
        };
        if (o.def.phase) {
          try {
            const illum = Astronomy.Illumination(body, time);
            o.sprite.userData.info.phase = `${Math.round(illum.phase_fraction * 100)}% illuminated`;
          } catch { /* ignore */ }
        }
      }
    }
  }
}

const _texCache = new Map();
function discTexture(color, glow) {
  const key = `${color}-${glow}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(color);
  const hex = `${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0}`;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, `rgba(${hex},1)`);
  g.addColorStop(glow ? 0.25 : 0.5, `rgba(${hex},1)`);
  g.addColorStop(glow ? 0.6 : 0.7, `rgba(${hex},0.35)`);
  g.addColorStop(1, `rgba(${hex},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  _texCache.set(key, tex);
  return tex;
}
