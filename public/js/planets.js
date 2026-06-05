// planets.js — Sun, Moon, and the naked-eye planets, computed locally with
// astronomy-engine (no network, no key). The Sun and Moon are drawn at their
// TRUE angular size (~0.5°); the planets are bright points (as the eye sees them).

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { domePosition, azAltToVector } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

const R = SHELLS.planets;
const ang = (deg) => R * deg * Math.PI / 180; // world diameter for an angular size

// disc fill fractions: Sun leaves room for a corona; Moon nearly fills the sprite
const SUN_SIZE = ang(0.533) / 0.40;
const MOON_SIZE = ang(0.52) / 0.94;

const BODIES = [
  { name: 'Sun', kind: 'sun', color: 0xfff4c2, size: SUN_SIZE, core: 0.30, fade: 0.40 },
  { name: 'Moon', kind: 'moon', color: 0xe6ebf2, size: MOON_SIZE, core: 0.44, fade: 0.48, phase: true },
  { name: 'Mercury', kind: 'planet', color: 0xb9b2a6, size: 4 },
  { name: 'Venus', kind: 'planet', color: 0xfff0c2, size: 7 },
  { name: 'Mars', kind: 'planet', color: 0xff7043, size: 5 },
  { name: 'Jupiter', kind: 'planet', color: 0xe8d3a2, size: 8 },
  { name: 'Saturn', kind: 'planet', color: 0xe4c98a, size: 7 },
  { name: 'Uranus', kind: 'planet', color: 0x9fd6e0, size: 3 },
  { name: 'Neptune', kind: 'planet', color: 0x6f8fe8, size: 3 },
];

export class PlanetLayer {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'planets';
    this.objects = [];
    this.pickables = [];
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.sunAltitude = -90;

    for (const b of BODIES) {
      const mat = new THREE.SpriteMaterial({
        map: discTexture(b.color, b.core ?? 0.2, b.fade ?? 0.35),
        depthTest: false, transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(b.size, b.size, 1);

      const label = makeTextSprite(b.name, 0xcfe0f0, 24);
      sprite.userData = { kind: 'planet', name: b.name, label, info: { type: 'Solar System body' } };

      this.group.add(sprite);
      this.group.add(label);
      this.objects.push({ def: b, sprite, label });
      this.pickables.push(sprite);
    }
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }

  update(observer, date) {
    const time = Astronomy.MakeTime(date);
    const obs = new Astronomy.Observer(observer.lat, observer.lon, observer.alt || 0);

    // Always track the Sun direction (drives scene lighting even if hidden).
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
        const equ = Astronomy.Equator(body, time, obs, true, true);
        ra = equ.ra; dec = equ.dec;
      } catch { o.sprite.visible = false; o.label.visible = false; continue; }
      const hor = Astronomy.Horizon(time, obs, ra, dec, 'normal');

      const above = hor.altitude > -2;
      o.sprite.visible = above;
      o.label.visible = above && (o.def.kind !== 'planet' || o.def.size >= 7);

      if (!above) continue;
      const pos = domePosition(hor.azimuth, hor.altitude, SHELLS.planets);
      o.sprite.position.copy(pos);
      o.label.position.copy(pos);
      o.label.position.y += Math.max(o.def.size, 8) * 0.9 + 4;
      o.sprite.userData.info = {
        type: o.def.kind === 'planet' ? 'Planet' : o.def.name,
        azimuth: hor.azimuth, altitude: hor.altitude,
      };

      // The Moon dims with its phase (a thin crescent is much fainter than full).
      if (o.def.phase) {
        try {
          const illum = Astronomy.Illumination(body, time);
          o.sprite.material.opacity = 0.12 + 0.88 * illum.phase_fraction;
          o.sprite.userData.info.phase = `${Math.round(illum.phase_fraction * 100)}% illuminated`;
        } catch { /* ignore */ }
      }
    }
  }
}

const _texCache = new Map();
function discTexture(color, core, fade) {
  const key = `${color}-${core}-${fade}`;
  if (_texCache.has(key)) return _texCache.get(key);
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const col = new THREE.Color(color);
  const hex = `${col.r * 255 | 0},${col.g * 255 | 0},${col.b * 255 | 0}`;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, `rgba(${hex},1)`);
  g.addColorStop(core, `rgba(${hex},1)`);          // solid disc
  g.addColorStop(fade, `rgba(${hex},0.9)`);         // disc edge
  g.addColorStop(Math.min(fade + 0.15, 0.98), `rgba(${hex},0.12)`); // soft glow/corona
  g.addColorStop(1, `rgba(${hex},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  _texCache.set(key, tex);
  return tex;
}
