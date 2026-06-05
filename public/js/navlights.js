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
  update(planes, tSec) {
    if (!this.enabled || !this.group.visible) return;
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.color.array;
    const siz = this.geo.attributes.size.array;
    let n = 0;

    for (const [, e] of planes) {
      if (!e.mesh.visible || n >= this.max) continue;
      e.mesh.updateWorldMatrix(true, false);
      const m = e.mesh.matrixWorld;
      const bb = e.isHeli ? this.bb.heli : this.bb.plane;
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
    const zTail = bb.max.z * 0.92;
    const zNose = bb.min.z * 0.88;
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
function strobeFn(x) { return (x < 0.045 || (x > 0.10 && x < 0.145)) ? 1 : 0; }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

function navMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
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
