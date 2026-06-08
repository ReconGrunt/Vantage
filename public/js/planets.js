// planets.js — Sun, Moon, and the naked-eye planets, computed locally with
// astronomy-engine (no network, no key). The Sun and Moon are drawn at their
// TRUE angular size (~0.5°); the planets are bright points (as the eye sees them).

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { domePosition, azAltToVector } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

const R = SHELLS.planets;
const ang = (deg) => R * deg * Math.PI / 180; // world diameter for an angular size

// The Sun and Moon are truly ~0.5° across, but at a from-the-ground projection
// that reads as a tiny dot. We magnify both (keeping their real 1:1 size ratio) so
// they look like the Sun/Moon you'd actually notice overhead — the same visibility
// boost philosophy as the aircraft. Tunable: bump CELESTIAL_BOOST for a bigger Sun.
const CELESTIAL_BOOST = 3.4;
// disc fill fractions: Sun leaves room for a corona; Moon nearly fills the sprite
const SUN_SIZE = ang(0.533) / 0.40 * CELESTIAL_BOOST;
const MOON_SIZE = ang(0.52) / 0.94 * CELESTIAL_BOOST;

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
    this._lastCompute = 0;   // ms timestamp of the last astronomy-engine solve (throttled)

    for (const b of BODIES) {
      const label = makeTextSprite(b.name, 0xcfe0f0, 24);

      if (b.kind === 'moon') {
        // The Moon is a real lit body, not a flat dimmed disc — a small sphere shaded
        // by the actual Sun direction so you see a physically-correct crescent/gibbous
        // terminator as seen from the ground. (See moonMaterial() for the shader.)
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(b.size / 2, 32, 16),
          moonMaterial(b.color),
        );
        mesh.renderOrder = 2;                     // over the sky/stars
        // Picking + main.js metadata contract: the MESH is the pickable now.
        mesh.userData = { kind: 'planet', name: b.name, label, info: { type: 'Solar System body' } };

        // A faint additive halo behind the Moon — a soft atmospheric glow, sized a
        // little larger than the disc. Purely cosmetic; not pickable.
        const haloMat = new THREE.SpriteMaterial({
          map: discTexture(0xbcc6d8, 0.0, 0.18),
          depthTest: false, transparent: true,
          blending: THREE.AdditiveBlending, opacity: 0.0,
        });
        const halo = new THREE.Sprite(haloMat);
        halo.scale.set(b.size * 2.0, b.size * 2.0, 1);
        halo.renderOrder = 1;

        this.group.add(halo);
        this.group.add(mesh);
        this.group.add(label);
        this.objects.push({ def: b, mesh, halo, label });
        this.pickables.push(mesh);
        continue;
      }

      // Sun + planets stay flat sprites (unchanged behaviour).
      const mat = new THREE.SpriteMaterial({
        map: discTexture(b.color, b.core ?? 0.2, b.fade ?? 0.35),
        depthTest: false, transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(b.size, b.size, 1);

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
    // The Sun, Moon and planets move only arcseconds per animation frame, so
    // solving the full astronomy-engine ephemeris every frame is wasted CPU.
    // Recompute at ~1 Hz (or immediately if the observer moved) and hold the
    // cached positions/sunDir between solves — the sprites don't move, sunDir /
    // sunAltitude consumers in main.js read these same fields and stay fresh
    // (1 Hz is far finer than twilight lighting needs). First call always runs.
    const ms = date.getTime();
    const moved = !this._obs || this._obs.lat !== observer.lat
      || this._obs.lon !== observer.lon || this._obs.alt !== observer.alt;
    if (!moved && this._lastCompute && ms - this._lastCompute < 1000) return;
    this._lastCompute = ms;
    this._obs = { lat: observer.lat, lon: observer.lon, alt: observer.alt };

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
      // The drawable is a sprite (Sun/planets) or a lit mesh (Moon); pick whichever
      // this object owns so the shared visibility/positioning logic stays uniform.
      const node = o.sprite || o.mesh;
      const body = Astronomy.Body[o.def.name];
      let ra, dec;
      try {
        const equ = Astronomy.Equator(body, time, obs, true, true);
        ra = equ.ra; dec = equ.dec;
      } catch { node.visible = false; o.label.visible = false; if (o.halo) o.halo.visible = false; continue; }
      const hor = Astronomy.Horizon(time, obs, ra, dec, 'normal');

      const above = hor.altitude > -2;
      node.visible = above;
      if (o.halo) o.halo.visible = above;
      o.label.visible = above && (o.def.kind !== 'planet' || o.def.size >= 7);

      if (!above) continue;
      const pos = domePosition(hor.azimuth, hor.altitude, SHELLS.planets);
      node.position.copy(pos);
      if (o.halo) o.halo.position.copy(pos);
      o.label.position.copy(pos);
      o.label.position.y += Math.max(o.def.size, 8) * 0.9 + 4;
      node.userData.info = {
        type: o.def.kind === 'planet' ? 'Planet' : o.def.name,
        azimuth: hor.azimuth, altitude_deg: hor.altitude,
      };

      // The Moon: feed the real Sun direction to its shader so the terminator (the
      // crescent/gibbous boundary) is physically correct as seen from the ground, and
      // report the illuminated fraction. We no longer just dim the whole disc.
      if (o.def.phase && o.mesh) {
        o.mesh.material.uniforms.uSunDir.value.copy(this.sunDir);
        try {
          const illum = Astronomy.Illumination(body, time);
          node.userData.info.phase = `${Math.round(illum.phase_fraction * 100)}% illuminated`;
          // The halo tracks brightness: barely there at new moon, soft at full.
          if (o.halo) o.halo.material.opacity = 0.05 + 0.30 * illum.phase_fraction;
        } catch { /* ignore */ }
      }
    }
  }
}

// The Moon's shader: shade a sphere by the real Sun direction (world space) so the
// lit limb always faces the Sun and the terminator is physically correct. A faint
// blue-grey earthshine floor keeps the dark side from going pure black, and a soft
// limb darkening + rim glow give the disc a little body. Sized to MOON_SIZE.
function moonMaterial(color) {
  const col = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },  // world-space Sun direction
      uColor: { value: new THREE.Vector3(col.r, col.g, col.b) },
    },
    transparent: true,
    depthTest: false,        // matches the Sun/planet sprites (always drawn on the dome)
    vertexShader: `
      varying vec3 vNormalW;   // world-space surface normal
      varying vec3 vViewN;     // view-space normal (for the limb falloff)
      void main() {
        // The planets group carries no rotation, but transform through normalMatrix
        // anyway so this stays correct if that ever changes.
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vNormalW; varying vec3 vViewN;
      uniform vec3 uSunDir; uniform vec3 uColor;
      void main() {
        vec3 N = normalize(vNormalW);
        // Lambert against the Sun → the phase, for free, as seen from the ground.
        float lambert = max(dot(N, normalize(uSunDir)), 0.0);
        // Soft terminator so the crescent edge isn't a razor line.
        float lit = smoothstep(0.0, 0.18, lambert);
        // A gentle limb darkening using the view-facing component.
        float limb = 0.55 + 0.45 * clamp(vViewN.z, 0.0, 1.0);

        vec3 sunlit = uColor * (0.25 + 0.95 * lit) * limb;
        // Earthshine: a faint cool floor on the dark side so it reads as a sphere,
        // not a void (the "old moon in the new moon's arms").
        vec3 earthshine = vec3(0.05, 0.07, 0.11) * (1.0 - lit);
        vec3 c = sunlit + earthshine;

        // Soft alpha at the very rim so the disc edge feathers into the sky.
        float edge = smoothstep(0.0, 0.12, vViewN.z);
        float a = max(lit, 0.22) * (0.6 + 0.4 * edge);
        gl_FragColor = vec4(c, a);
      }`,
  });
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
