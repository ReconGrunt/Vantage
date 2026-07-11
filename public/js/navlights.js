// navlights.js — realistic aircraft lighting, driven by each flight's status.
//
// Real-world rules we mimic:
//   · Position lights (steady): RED on the left/port wingtip, GREEN on the
//     right/starboard wingtip, WHITE facing aft on the tail.
//   · Anti-collision beacon (RED, slow flash) on the fuselage — on whenever the
//     aircraft is operating. (Everything we draw is airborne; ground traffic is
//     filtered out upstream.)
//   · Strobes (white, sharp double-flash) on the wingtips — airborne.
//   · Landing lights (bright white, forward) only at low altitude — i.e. on
//     approach/departure, just like real procedure.
//
// All lights for the whole sky are packed into ONE additive Points cloud that we
// refill each frame, so it's a single cheap draw call.

import * as THREE from 'three';

export class NavLights {
  constructor(scene, geos) {
    this.enabled = true;
    this.max = 5000;
    this.group = new THREE.Group();
    this.group.name = 'navlights';

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(this.max), 1));
    g.setDrawRange(0, 0);
    this.geo = g;
    this.points = new THREE.Points(g, navMaterial());
    this.points.frustumCulled = false;
    this.group.add(this.points);
    scene.add(this.group);

    this.bb = { plane: bboxOf(geos.plane), heli: bboxOf(geos.heli) };
    this._v = new THREE.Vector3();
  }

  setVisible(v) { this.enabled = v; this.group.visible = v; }

  // planes: Map of aircraft entries (each with .mesh, .state, .isHeli, .id)
  // night: 0 (day) .. 1 (full dark)   cloud: 0..1 cover (drives light scatter)
  update(planes, tSec, night = 0, cloud = 0) {
    if (!this.enabled || !this.group.visible) return;
    this.night = night;
    this.cloud = cloud;
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color.array;
    const siz = this.geo.attributes.size.array;
    let n = 0;

    for (const [, e] of planes) {
      if (!e.mesh.visible || n >= this.max) continue;
      e.mesh.updateWorldMatrix(true, false);
      const m = e.mesh.matrixWorld;
      // Prefer the actual model's bounding box so lights sit on the real airframe.
      const bb = e.modelBox || (e.isHeli ? this.bb.heli : this.bb.plane);
      const lights = this._lightsFor(e, bb, tSec);
      for (const L of lights) {
        if (n >= this.max) break;
        this._v.set(L[0], L[1], L[2]).applyMatrix4(m);
        pos[n * 3] = this._v.x; pos[n * 3 + 1] = this._v.y; pos[n * 3 + 2] = this._v.z;
        col[n * 3] = L[3]; col[n * 3 + 1] = L[4]; col[n * 3 + 2] = L[5];
        siz[n] = L[6];
        n++;
      }
    }

    this.geo.setDrawRange(0, n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }

  _lightsFor(e, bb, t) {
    const p = e._navPhase ?? (e._navPhase = hash(e.id || ''));
    const heli = e.isHeli;
    const xL = bb.min.x * (heli ? 0.42 : 0.95);
    const xR = bb.max.x * (heli ? 0.42 : 0.95);
    const yMid = (bb.min.y + bb.max.y) * 0.5;
    const yTop = bb.max.y * 0.9;
    // Models face nose = +Z (so lookAt points them forward), tail = -Z.
    const zNose = bb.max.z * 0.9;
    const zTail = bb.min.z * 0.92;
    const alt = e.state?.altitude ?? 9999;

    const beacon = frac(t / 1.25 + p) < 0.09 ? 1 : 0;          // red flash
    const strobe = strobeFn(frac(t / 1.45 + p * 1.7));         // white double-flash

    const out = [
      // steady position lights (with a small always-on floor so they read)
      [xL, yMid, zTail * 0.1, 1.0, 0.06, 0.06, 3.2],            // red  – left
      [xR, yMid, zTail * 0.1, 0.06, 1.0, 0.12, 3.2],            // green – right
      [0.0, yTop * 0.55, zTail, 1.0, 1.0, 1.0, 2.6],            // white – tail
    ];
    if (strobe > 0) {
      out.push([xL, yMid, zTail * 0.1, strobe, strobe, strobe, 6.0]);
      out.push([xR, yMid, zTail * 0.1, strobe, strobe, strobe, 6.0]);
    }
    if (beacon > 0) {
      out.push([0, yTop, 0, 1.0, 0.08, 0.08, 5.5]);            // top beacon
      out.push([0, bb.min.y * 0.9, 0, 1.0, 0.08, 0.08, 4.5]);  // belly beacon
    }
    if (alt < 2500) out.push([0, yMid, zNose, 1.5, 1.5, 1.3, 7.0]); // landing lights, low only

    // Airline livery accent — a brand-coloured "logo light" on the tail fin.
    const liv = e.livery;
    if (liv) {
      const b = 0.55 + 0.4 * (this.night || 0);
      out.push([0, yTop * 0.72, zTail * 0.7, liv.r * b, liv.g * b, liv.b * b, 5.2]);
    }

    // Night fog/landing-light glow. At night every aircraft throws a forward
    // light glint; when it's flying through cloud (overcast + within the cloud
    // band) the light scatters into a big soft halo — so you can see it lighting
    // up the cloud overhead even when the airframe itself is hidden.
    const night = this.night || 0, cloud = this.cloud || 0;

    // Forward landing/taxi-light glint at night.
    if (night > 0.04) {
      const nb = night;
      out.push([0, yMid * 0.5, zNose * 0.8, 1.1 * nb, 1.0 * nb, 0.85 * nb, 7 + nb * 3]);
    }

    // Cloud illumination: when the aircraft is INSIDE the cloud layer, its strobes
    // and beacon light up the surrounding cloud — a soft halo that FLASHES in time
    // with the lights, exactly like watching a jet pass through cloud. Brightest at
    // night/dusk, a faint hint by day. The halo is large and soft so it reads as
    // the cloud glowing, not a point light.
    const band = (alt > 500 && alt < 8500)
      ? smoothstep01(Math.min(alt - 500, 8500 - alt) / 1500) : 0;
    const inCloud = cloud * band;
    if (inCloud > 0.06) {
      const vis = clamp01(night * 1.6 + 0.12);           // day-faint .. night-strong
      const gs = Math.min(28 + inCloud * 64, 90);        // halo size (px)
      if (strobe > 0) {                                  // white double-flash lights the cloud
        const w = inCloud * vis;
        out.push([0, yMid, 0, w, w, w * 1.05, gs]);
        out.push([bb.max.x * 0.4, yMid, 0, w * 0.6, w * 0.6, w * 0.65, gs * 0.6]);
        out.push([bb.min.x * 0.4, yMid, 0, w * 0.6, w * 0.6, w * 0.65, gs * 0.6]);
      } else {                                           // soft presence between flashes
        const a = 0.12 * inCloud * vis;
        out.push([0, yMid, 0, a, a, a * 1.05, gs * 0.8]);
      }
      if (beacon > 0) {                                  // red beacon pulse tints the cloud
        const r = 0.85 * inCloud * vis;
        out.push([0, yMid, 0, r, r * 0.12, r * 0.12, gs * 0.85]);
      }
    }
    return out;
  }
}

function bboxOf(geo) {
  geo.computeBoundingBox();
  // bbox is in model-local units (caller scales the mesh); applyMatrix4 with the
  // mesh's world matrix (which includes that scale) maps these correctly.
  return geo.boundingBox.clone();
}

function frac(x) { return x - Math.floor(x); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep01(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
function strobeFn(x) { return (x < 0.045 || (x > 0.10 && x < 0.145)) ? 1 : 0; }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

function navMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) } },
    vertexShader: `
      attribute float size; varying vec3 vColor;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = size * uPixelRatio;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a * a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
}
