// sky.js — the static planetarium furniture: horizon ring, cardinal markers,
// altitude/azimuth grid, ground plane, and a subtle gradient dome backdrop.

import * as THREE from 'three';
import { azAltToVector, DEG } from './coords.js';

export const SHELLS = {
  stars: 1000,      // background sky dome radius
  planets: 940,
  satellites: 820,
  aircraft: 700,
  grid: 980,
};

export function buildSky(scene) {
  const group = new THREE.Group();
  group.name = 'sky-furniture';

  // --- physically-flavoured sky backdrop, driven by the real Sun ---
  // The colour shifts with the Sun's altitude: deep night, a twilight band and
  // sunset glow toward the Sun, and a blue daytime sky. So it resembles the sky
  // the observer would actually see right now.
  const domeGeo = new THREE.SphereGeometry(SHELLS.stars + 20, 48, 32);
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunAlt: { value: -90 },   // degrees
      uHaze: { value: 0 },       // 0..1 extra horizon haze from weather
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uSunDir; uniform float uSunAlt; uniform float uHaze;
      void main() {
        float h = clamp(vDir.y, -1.0, 1.0);            // sin(altitude) of this pixel
        float day = smoothstep(-6.0, 8.0, uSunAlt);     // 0 night .. 1 day
        float civil = smoothstep(-14.0, -2.0, uSunAlt); // twilight presence

        // base palettes
        vec3 nightZen = vec3(0.012, 0.018, 0.045);
        vec3 nightHor = vec3(0.030, 0.045, 0.075);
        vec3 dayZen   = vec3(0.16, 0.33, 0.62);
        vec3 dayHor   = vec3(0.55, 0.70, 0.88);

        float t = clamp(h * 0.5 + 0.5, 0.0, 1.0);
        vec3 night = mix(nightHor, nightZen, t);
        vec3 dayc  = mix(dayHor, dayZen, pow(t, 0.8));
        vec3 col = mix(night, dayc, day);

        // sunset / sunrise glow toward the Sun, strongest near the horizon
        float sd = max(dot(vDir, normalize(uSunDir)), 0.0);
        float horizon = 1.0 - smoothstep(0.0, 0.35, h);
        vec3 glow = vec3(1.0, 0.45, 0.18) * pow(sd, 6.0) * horizon * civil * 1.2;
        col += glow;

        // weather haze lifts/greys the horizon
        col = mix(col, vec3(0.5, 0.55, 0.62), uHaze * horizon * (0.25 + 0.5 * day));

        // below the horizon fades to a dark ground tone, so there's a natural
        // floor without a hard opaque disc walling off the view
        float below = smoothstep(0.0, -0.14, h);
        col = mix(col, vec3(0.018, 0.022, 0.032), below);

        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const backdrop = new THREE.Mesh(domeGeo, domeMat);
  backdrop.name = 'backdrop';
  group.add(backdrop);

  // --- ground plane (below horizon) ---
  const groundGeo = new THREE.CircleGeometry(SHELLS.stars, 64);
  const groundMat = new THREE.MeshBasicMaterial({
    color: 0x070a11, side: THREE.DoubleSide,   // opaque: writes depth, hides sub-horizon stars
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  group.add(ground);

  // --- horizon ring ---
  group.add(circle(SHELLS.grid, 0, 0x3a6ea5, 2));

  // --- altitude rings at 30 and 60 deg ---
  for (const alt of [30, 60]) {
    group.add(circle(SHELLS.grid, alt, 0x223a55, 1));
  }

  // --- azimuth spokes every 30 deg ---
  for (let az = 0; az < 360; az += 30) {
    const isCardinal = az % 90 === 0;
    const pts = [];
    for (let alt = 0; alt <= 88; alt += 4) {
      pts.push(azAltToVector(az, alt).multiplyScalar(SHELLS.grid));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: isCardinal ? 0x2d4d6e : 0x172838,
    });
    group.add(new THREE.Line(geo, mat));
  }

  // --- cardinal + intercardinal labels ---
  const dirs = [
    ['N', 0, 0xff6b6b], ['NE', 45], ['E', 90, 0xffffff], ['SE', 135],
    ['S', 180, 0xffffff], ['SW', 225], ['W', 270, 0xffffff], ['NW', 315],
  ];
  for (const [label, az, color] of dirs) {
    const sprite = makeTextSprite(label, color || 0x9fb8d0, az % 90 === 0 ? 44 : 30);
    sprite.position.copy(azAltToVector(az, 3).multiplyScalar(SHELLS.grid));
    sprite.scale.multiplyScalar(az % 90 === 0 ? 1 : 0.7);
    group.add(sprite);
  }

  // zenith marker
  group.add(makeDot(azAltToVector(0, 90).multiplyScalar(SHELLS.grid), 0x2d4d6e, 6));

  scene.add(group);
  return group;
}

// Drive the backdrop from the real Sun each frame so the sky colour matches the
// time of day. haze (0..1) lifts the horizon when it's cloudy.
const _groundDay = new THREE.Color(0x3a4250);
const _groundNight = new THREE.Color(0x070a11);
export function updateSky(group, sunDir, sunAltDeg, haze = 0) {
  const backdrop = group.getObjectByName('backdrop');
  if (backdrop) {
    const u = backdrop.material.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunAlt.value = sunAltDeg;
    u.uHaze.value = haze;
  }
  const ground = group.getObjectByName('ground');
  if (ground) {
    const day = THREE.MathUtils.clamp((sunAltDeg + 6) / 14, 0, 1);
    ground.material.color.copy(_groundNight).lerp(_groundDay, day);
  }
}

// For passthrough AR (Quest), hide the opaque backdrop + ground so the real room
// shows through; the celestial/aircraft overlays remain.
export function setPassthrough(group, on) {
  const backdrop = group.getObjectByName('backdrop');
  const ground = group.getObjectByName('ground');
  if (backdrop) backdrop.visible = !on;
  if (ground) ground.visible = !on;
}

function circle(radius, altDeg, color, width = 1) {
  const pts = [];
  for (let az = 0; az <= 360; az += 3) {
    pts.push(azAltToVector(az, altDeg).multiplyScalar(radius));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, linewidth: width }));
}

function makeDot(pos, color, size) {
  const geo = new THREE.BufferGeometry().setFromPoints([pos]);
  const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: false });
  return new THREE.Points(geo, mat);
}

// A canvas-texture text sprite. Cheap and crisp enough for labels.
// Supports multiple lines via "\n".
export function makeTextSprite(text, color = 0xffffff, fontPx = 32) {
  const pad = 10;
  const lines = String(text).split('\n');
  const lineH = fontPx * 1.25;
  const font = `600 ${fontPx}px Inter, Arial, sans-serif`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  canvas.width = Math.ceil(w + pad * 2);
  canvas.height = Math.ceil(lineH * lines.length + pad * 2);

  ctx.font = font;
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const y = pad + lineH * (i + 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(line, pad + 1, y + 1);
    ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    ctx.fillText(line, pad, y);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const worldH = canvas.height * 0.34;            // px -> world units (readable on a TV)
  sprite.scale.set(worldH * (canvas.width / canvas.height), worldH, 1);
  sprite.userData.isLabel = true;
  return sprite;
}
