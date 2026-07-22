// stars.js — a real, position-accurate night sky.
//
// Stars come from the HYG catalogue (public domain) as RA/Dec/magnitude/colour.
// We place them on the celestial sphere in equatorial coordinates ONCE, then
// rotate the whole sphere each frame into the observer's horizontal frame using
// their latitude and the local sidereal time. So the sky wheels overhead exactly
// as it does in reality for your location and the current moment.

import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';
import { DEG } from './coords.js';
import { SHELLS, makeTextSprite } from './sky.js';

export class StarLayer {
  constructor(scene) {
    this.group = new THREE.Group();      // rotated each frame
    this.group.matrixAutoUpdate = false;
    this.group.name = 'stars';
    this.labelGroup = new THREE.Group();
    this.labelGroup.matrixAutoUpdate = false;
    this.labelGroup.visible = false;
    this.group.add(this.labelGroup);
    this.ready = false;
    this.observer = null;
    scene.add(this.group);
  }

  setVisible(v) { this.group.visible = v; }
  setLabels(v) { this.labelGroup.visible = v; }

  // sunAltDeg drives the day/night fade; clouds (0..1) dims the stars.
  setSky(sunAltDeg, clouds = 0) {
    if (!this.material) return;
    // stars emerge through twilight: gone by sunrise, full once the Sun is well down
    const vis = 1 - THREE.MathUtils.clamp((sunAltDeg + 12) / 12, 0, 1);
    this.material.uniforms.uVisibility.value = vis;
    this.material.uniforms.uClouds.value = clouds;
    // The Milky Way fades on exactly the same day/cloud curve as the stars — it is
    // part of the same night sky, so it must vanish in daylight and dim under cloud.
    if (this.milkyMat) {
      this.milkyMat.uniforms.uVisibility.value = vis;
      this.milkyMat.uniforms.uClouds.value = clouds;
    }
  }

  async load(url = 'data/stars.json') {
    const data = await (await fetch(url)).json();
    const n = data.count;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const sizes = new Float32Array(n);
    const phase = new Float32Array(n);
    const R = SHELLS.stars;

    for (let i = 0; i < n; i++) {
      const ra = data.ra[i] * DEG;     // already in degrees in the file
      const dec = data.dec[i] * DEG;
      const cosDec = Math.cos(dec);
      // Equatorial unit vector: x->vernal equinox, z->north celestial pole
      positions[i * 3] = cosDec * Math.cos(ra) * R;
      positions[i * 3 + 1] = cosDec * Math.sin(ra) * R;
      positions[i * 3 + 2] = Math.sin(dec) * R;

      const c = bvToColor(data.ci[i]);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;

      // Size from magnitude: bright stars markedly larger, with a floor.
      const m = data.mag[i];
      sizes[i] = THREE.MathUtils.clamp(9.0 - m * 1.15, 1.6, 12.0);
      phase[i] = Math.random() * Math.PI * 2;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
        uVisibility: { value: 1 },  // 0 in daylight .. 1 deep night
        uClouds: { value: 0 },      // 0..1 cloud cover dims the stars
      },
      vertexShader: `
        attribute float size; attribute float phase;
        varying vec3 vColor; varying float vTw; varying float vExt; varying float vBright;
        uniform float uTime; uniform float uPixelRatio;
        void main() {
          vColor = color;
          // twinkle increases toward the horizon (more atmosphere)
          vec3 worldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
          float altSin = worldDir.y;                       // sin(altitude)
          // atmospheric extinction: stars dim and vanish near/below the horizon
          vExt = smoothstep(-0.02, 0.30, altSin);
          float twAmt = mix(0.30, 0.12, clamp(altSin * 2.0, 0.0, 1.0));
          float tw = 1.0 - twAmt + twAmt * sin(uTime * 2.2 + phase);
          vTw = tw;
          // Brightness rank 0..1 from the point size (size is clamped 1.6..12 from
          // magnitude). Drives a stronger halo + a diffraction glint for ONLY the
          // brightest stars, leaving the faint background dots unbloated.
          vBright = smoothstep(5.0, 11.0, size);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // Bright stars get a slightly enlarged sprite to host the halo/glint; faint
          // stars are untouched (vBright≈0 → factor 1).
          gl_PointSize = size * tw * uPixelRatio * (1.0 + 0.9 * vBright);
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vTw; varying float vExt; varying float vBright;
        uniform float uVisibility; uniform float uClouds;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          // Tight core dot — identical look for faint stars.
          float core = smoothstep(0.5, 0.0, d);
          float a = pow(core, 1.6);

          // Brightest stars read on a projector: a wider, soft halo falloff plus a
          // faint 4-point diffraction glint. Both are gated by vBright so faint
          // background stars get essentially none of it (no bloat).
          if (vBright > 0.001) {
            float halo = exp(-d * 7.0) * 0.45 * vBright;     // broad soft bloom
            // 4-point glint: cross of two thin Gaussian streaks through the centre.
            float gx = exp(-pow(uv.y / 0.045, 2.0)) * smoothstep(0.5, 0.0, abs(uv.x));
            float gy = exp(-pow(uv.x / 0.045, 2.0)) * smoothstep(0.5, 0.0, abs(uv.y));
            float glint = (gx + gy) * 0.22 * vBright;
            a += halo + glint;
          }

          a *= vExt * uVisibility * (1.0 - 0.85 * uClouds);
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * vTw, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,        // let the opaque ground occlude sub-horizon stars
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

    // Build the Milky Way FIRST so it is added to the group before the stars.
    // It shares this rotated equatorial group, so it wheels with the real sky for
    // free, and being added first (plus renderOrder -1) it draws behind the stars.
    this._buildMilkyWay(R);

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    // Named-star labels (brightest only — already pre-filtered in the file)
    for (const s of data.named) {
      if (s.mag > 2.4) continue; // keep labels uncluttered
      const ra = s.ra * DEG, dec = s.dec * DEG, cosDec = Math.cos(dec);
      const sprite = makeTextSprite(s.name, 0x9fb8d0, 20);
      sprite.position.set(
        cosDec * Math.cos(ra) * R,
        cosDec * Math.sin(ra) * R,
        Math.sin(dec) * R,
      );
      sprite.scale.multiplyScalar(0.8);
      this.labelGroup.add(sprite);
    }

    this.ready = true;
    return n;
  }

  // Build the rotation that carries the equatorial sphere into the local sky.
  // world = M_lat * Rz(-theta),  theta = local sidereal time (radians).
  update(observer, date, elapsed) {
    if (!this.ready || !this.group.visible) return;
    this.material.uniforms.uTime.value = elapsed;

    const phi = observer.lat * DEG;
    const gast = Astronomy.SiderealTime(date);            // hours, Greenwich
    const lstDeg = gast * 15 + observer.lon;              // local sidereal time
    const theta = lstDeg * DEG;

    const cf = Math.cos(phi), sf = Math.sin(phi);
    // Reuse scratch matrices (this runs every frame stars are visible) — no per-frame
    // Matrix4 allocations feeding the GC on a 24/7 display.
    const mLat = this._mLat || (this._mLat = new THREE.Matrix4());
    const rz = this._rz || (this._rz = new THREE.Matrix4());
    // M_lat (rows): maps hour-angle frame -> world (East=+X, Up=+Y, North=-Z)
    mLat.set(
      0, 1, 0, 0,
      cf, 0, sf, 0,
      sf, 0, -cf, 0,
      0, 0, 0, 1,
    );
    rz.makeRotationZ(-theta);
    this.group.matrix.multiplyMatrices(mLat, rz);
    this.group.matrixWorldNeedsUpdate = true;
    this.labelGroup.matrixWorldNeedsUpdate = true;
  }

  // The Milky Way — a procedural, faint, mottled band painted on a sphere in the
  // SAME equatorial frame as the stars, so it sits on the real galactic plane and
  // wheels overhead correctly with no main.js wiring. Drawn behind the stars
  // (added first + renderOrder -1), additive, depthWrite off; depthTest stays on so
  // the opaque ground occludes the sub-horizon half just like the stars.
  _buildMilkyWay(R) {
    // A touch inside the star shell so the stars always read in front of the band.
    const geo = new THREE.SphereGeometry(R - 5, 64, 32);
    // Galactic frame unit vectors expressed in THIS equatorial frame
    // (x=cosDec·cosRA, y=cosDec·sinRA, z=sinDec). The galactic NORTH POLE sets the
    // plane (brightness peaks where dir⟂pole); the galactic CENTRE (Sagittarius)
    // gets the broad, brighter, faintly-warm bulge.
    const GPOLE = new THREE.Vector3(-0.868, -0.198, 0.456).normalize();
    const GCENTER = new THREE.Vector3(-0.055, -0.874, -0.484).normalize();

    this.milkyMat = new THREE.ShaderMaterial({
      uniforms: {
        uVisibility: { value: 1 },   // 0 daylight .. 1 deep night (driven in setSky)
        uClouds: { value: 0 },       // 0..1 cloud cover dims the band
        uGPole: { value: GPOLE },
        uGCenter: { value: GCENTER },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          // Direction in the (unrotated) equatorial model frame — the same frame the
          // galactic pole/centre vectors are expressed in. We deliberately use the
          // local position, NOT a world direction, so the band is fixed to the stars.
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform float uVisibility; uniform float uClouds;
        uniform vec3 uGPole; uniform vec3 uGCenter;

        // Cheap hash-based value noise + fbm for mottling and dark rifts (no texture).
        float hash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float vnoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
        float fbm(vec3 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }
          return v;
        }

        void main() {
          vec3 dir = normalize(vDir);
          // Galactic latitude proxy: 0 on the galactic equator, ±1 at the poles.
          float gl = dot(dir, uGPole);
          // Soft band: a Gaussian centred on the galactic equator. Kept narrow-ish so
          // the band reads as a band, not a wash.
          float band = exp(-(gl * gl) / (2.0 * 0.052));

          // fbm mottling + dark rifts. Sample in the galactic-ish frame for structure
          // that follows the band; subtract a floor to carve dark dust lanes.
          float n = fbm(dir * 6.0);
          float mottle = smoothstep(0.25, 0.95, n);          // dark rifts where n is low
          float band2 = band * (0.35 + 0.85 * mottle);

          // Brighter, broader bulge toward the galactic centre (Sagittarius).
          float gc = max(dot(dir, uGCenter), 0.0);
          float bulge = pow(gc, 3.0) * exp(-(gl * gl) / (2.0 * 0.14));
          float bright = band2 + bulge * 0.9;

          // Cool white base, warm tint blended in toward the bulge.
          vec3 cool = vec3(0.62, 0.70, 0.85);
          vec3 warm = vec3(0.92, 0.84, 0.70);
          vec3 col = mix(cool, warm, clamp(bulge * 1.4, 0.0, 1.0));

          // Keep it FAINT — the real Milky Way is subtle. Fades with day + cloud.
          float a = bright * 0.18 * uVisibility * (1.0 - 0.9 * uClouds);
          if (a < 0.002) discard;
          gl_FragColor = vec4(col * bright, a);
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,                 // ground occludes the sub-horizon half
      blending: THREE.AdditiveBlending,
    });

    this.milkyWay = new THREE.Mesh(geo, this.milkyMat);
    this.milkyWay.name = 'milkyway';
    this.milkyWay.frustumCulled = false;
    this.milkyWay.renderOrder = -1;    // draw behind the stars
    this.milkyWay.raycast = () => {};  // never pickable
    this.group.add(this.milkyWay);
  }
}

// Approximate a star's RGB colour from its B-V colour index.
// Cooler logic: very negative = blue, ~0 = white, positive = yellow/orange/red.
function bvToColor(bv) {
  const t = THREE.MathUtils.clamp(bv, -0.35, 2.0);
  let r, g, b;
  if (t < 0.0) { r = 0.6 + t * 0.4; g = 0.7 + t * 0.3; b = 1.0; }
  else if (t < 0.4) { r = 0.75 + t * 0.55; g = 0.85 + t * 0.25; b = 1.0 - t * 0.35; }
  else if (t < 0.8) { r = 1.0; g = 0.97 - (t - 0.4) * 0.25; b = 0.85 - (t - 0.4) * 0.55; }
  else if (t < 1.4) { r = 1.0; g = 0.87 - (t - 0.8) * 0.3; b = 0.63 - (t - 0.8) * 0.4; }
  else { r = 1.0; g = 0.7 - (t - 1.4) * 0.25; b = 0.4 - (t - 1.4) * 0.2; }
  return {
    r: THREE.MathUtils.clamp(r, 0, 1),
    g: THREE.MathUtils.clamp(g, 0, 1),
    b: THREE.MathUtils.clamp(b, 0, 1),
  };
}
