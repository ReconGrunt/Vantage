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
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
        uVisibility: { value: 1 },  // 0 in daylight .. 1 deep night
        uClouds: { value: 0 },      // 0..1 cloud cover dims the stars
      },
      vertexShader: `
        attribute float size; attribute float phase;
        varying vec3 vColor; varying float vTw; varying float vExt;
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
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * tw * uPixelRatio;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vTw; varying float vExt;
        uniform float uVisibility; uniform float uClouds;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv);
          float core = smoothstep(0.5, 0.0, d);
          float a = pow(core, 1.6) * vExt * uVisibility * (1.0 - 0.85 * uClouds);
          if (a < 0.003) discard;
          gl_FragColor = vec4(vColor * vTw, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: true,        // let the opaque ground occlude sub-horizon stars
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });

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
    // M_lat (rows): maps hour-angle frame -> world (East=+X, Up=+Y, North=-Z)
    const mLat = new THREE.Matrix4().set(
      0, 1, 0, 0,
      cf, 0, sf, 0,
      sf, 0, -cf, 0,
      0, 0, 0, 1,
    );
    const rz = new THREE.Matrix4().makeRotationZ(-theta);
    this.group.matrix.multiplyMatrices(mLat, rz);
    this.group.matrixWorldNeedsUpdate = true;
    this.labelGroup.matrixWorldNeedsUpdate = true;
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
