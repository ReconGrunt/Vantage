// plane-model.js — a procedurally built, good-looking twin-engine airliner.
//
// The fuselage is a smooth lathe (body of revolution) with a tapered nose and
// tail; wings are cleanly swept and tapered with winglets; engines are smooth
// nacelles with dark intakes; plus tailplane and fin. Everything is merged into
// ONE vertex-coloured BufferGeometry so a whole sky of planes shares a single
// geometry + material. The nose points toward -Z so Object3D.lookAt() aims it
// along the direction of travel.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const WHITE = new THREE.Color(0xf2f5f9);
const GREY = new THREE.Color(0xcdd5de);
const DARK = new THREE.Color(0x222a33);
const ACCENT = new THREE.Color(0x2f6fd6); // fin / livery accent
const ENGINE = new THREE.Color(0x4a5560);

// Normalise every part to the SAME attribute set {position, normal, color} so
// mergeGeometries succeeds (it returns null if attribute sets differ). uv is
// dropped because the material is vertex-coloured and uses no textures.
function paint(geo, color) {
  geo.deleteAttribute('uv');
  geo.deleteAttribute('uv1');
  geo.deleteAttribute('uv2');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

const L = 10; // fuselage half-length reference

export function buildAirliner() {
  const parts = [];

  // --- fuselage: smooth body of revolution ---
  // profile points: Vector2(radius, lengthwise position from nose -L to tail +L)
  const R = 1.05;
  const profile = [
    [0.02, -L * 1.00],   // nose tip
    [0.34, -L * 0.93],
    [0.66, -L * 0.84],
    [0.90, -L * 0.70],
    [1.02, -L * 0.50],
    [R, -L * 0.30],
    [R, L * 0.20],       // constant-section cabin
    [R * 0.98, L * 0.40],
    [0.82, L * 0.62],
    [0.55, L * 0.80],
    [0.30, L * 0.92],
    [0.16, L * 1.02],    // tail cone tip
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fuse = new THREE.LatheGeometry(profile, 28);
  fuse.rotateX(Math.PI / 2);           // length -> Z, nose at -Z
  paint(fuse, WHITE);
  parts.push(fuse);

  // --- main wings (with winglets) ---
  parts.push(wing(+1), wing(-1));

  // --- engines ---
  parts.push(engine(+1), engine(-1));

  // --- horizontal stabilizers ---
  parts.push(tailplane(+1), tailplane(-1));

  // --- vertical fin (accent) ---
  parts.push(verticalFin());

  // mergeGeometries needs matching attributes AND uniform indexing
  // (LatheGeometry/primitives are indexed; ExtrudeGeometry is not).
  const norm = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(norm, false);
  if (!merged) throw new Error('airliner merge failed — attribute mismatch');
  merged.computeVertexNormals();
  merged.center();
  merged.scale(0.05, 0.05, 0.05);      // ~1 unit long; caller scales up
  return merged;
}

// A swept, tapered lifting surface in the XZ plane, thin in Y.
// span/chords in model units; returns an oriented, positioned geometry.
function liftingSurface({ rootChord, tipChord, span, sweep, thickness }) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);                       // root leading edge
  shape.lineTo(span, sweep);               // tip leading edge
  shape.lineTo(span, sweep + tipChord);    // tip trailing edge
  shape.lineTo(0, rootChord);              // root trailing edge
  shape.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(Math.PI / 2);                // u->X (span), v->Z (chord), thickness->Y
  return geo;
}

function wing(side) {
  const span = 9.0;
  const sweep = 3.2;
  const geo = liftingSurface({
    rootChord: 4.0, tipChord: 1.3, span, sweep, thickness: 0.4,
  });
  // winglet: a small upright fin at the tip, aligned with the swept leading edge
  const wl = liftingSurface({
    rootChord: 1.3, tipChord: 0.5, span: 1.1, sweep: 0.5, thickness: 0.28,
  });
  wl.rotateZ(-Math.PI / 2);                // stand it up
  wl.translate(span, 0, sweep);            // at the wing tip
  const merged = mergeGeometries([geo, wl], false);
  merged.scale(side, 1, 1);                // mirror for left/right
  merged.rotateZ(side * -0.06);            // dihedral
  merged.translate(side * R0(), -0.5, -0.5);
  paint(merged, GREY);
  return merged;
}

function tailplane(side) {
  const geo = liftingSurface({
    rootChord: 2.1, tipChord: 0.8, span: 3.4, sweep: 1.6, thickness: 0.24,
  });
  geo.scale(side, 1, 1);
  geo.translate(side * 0.5, 0.35, 7.4);
  paint(geo, GREY);
  return geo;
}

function verticalFin() {
  const geo = liftingSurface({
    rootChord: 3.0, tipChord: 1.1, span: 3.8, sweep: 1.9, thickness: 0.3,
  });
  geo.rotateZ(-Math.PI / 2);               // stand upright
  geo.translate(0, 0.7, 6.4);
  paint(geo, ACCENT);
  return geo;
}

function engine(side) {
  const len = 3.0;
  const cowl = new THREE.CylinderGeometry(0.52, 0.58, len, 18, 1, false);
  cowl.rotateX(Math.PI / 2);
  paint(cowl, ENGINE);
  // dark intake lip at the front (-Z)
  const lip = new THREE.TorusGeometry(0.52, 0.11, 10, 20);
  lip.translate(0, 0, -len / 2);
  paint(lip, DARK);
  // dark fan face just inside the intake
  const fan = new THREE.CircleGeometry(0.5, 18);
  fan.translate(0, 0, -len / 2 + 0.05);
  paint(fan, DARK);
  // exhaust cone at the back (+Z)
  const exhaust = new THREE.ConeGeometry(0.34, 0.9, 16);
  exhaust.rotateX(-Math.PI / 2);
  exhaust.translate(0, 0, len / 2 + 0.35);
  paint(exhaust, DARK);
  // pylon connecting up to the wing
  const pylon = new THREE.BoxGeometry(0.16, 0.85, 1.2);
  pylon.translate(0, 0.6, 0.2);
  paint(pylon, GREY);

  const nacelle = mergeGeometries(
    [cowl, lip, fan, exhaust, pylon].map((g) => (g.index ? g.toNonIndexed() : g)), false);
  // under the wing, a touch ahead of the (swept) leading edge at this span station
  nacelle.translate(side * 3.4, -1.25, -0.2);
  return nacelle;
}

// fuselage radius helper (root attach point for wings/tail)
function R0() { return 0.95; }

// A procedurally built light helicopter: cabin pod, tail boom + tail rotor,
// main rotor, and landing skids. Same conventions as the airliner — nose toward
// -Z, one merged vertex-coloured geometry.
export function buildHelicopter() {
  const parts = [];

  // cabin pod (rounded, slightly elongated, bubble nose toward -Z)
  const cabin = new THREE.SphereGeometry(1.4, 20, 16);
  cabin.scale(1.0, 1.05, 1.5);
  cabin.translate(0, 0, -0.6);
  paint(cabin, WHITE);
  parts.push(cabin);

  // tail boom (tapered, extends +Z)
  const boom = new THREE.CylinderGeometry(0.45, 0.16, 6.0, 14, 1);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 0.35, 3.6);
  paint(boom, GREY);
  parts.push(boom);

  // vertical tail fin (accent)
  const fin = liftingSurface({ rootChord: 1.4, tipChord: 0.6, span: 1.5, sweep: 0.7, thickness: 0.18 });
  fin.rotateZ(-Math.PI / 2);
  fin.translate(0, 0.4, 5.6);
  paint(fin, ACCENT);
  parts.push(fin);

  // tail rotor (thin disc on the side of the boom, spins about X)
  const tr = new THREE.CylinderGeometry(1.0, 1.0, 0.12, 16);
  tr.rotateZ(Math.PI / 2);            // axis along X
  tr.translate(0.3, 0.7, 6.2);
  paint(tr, DARK);
  parts.push(tr);

  // main rotor mast + hub
  const mast = new THREE.CylinderGeometry(0.16, 0.16, 0.9, 10);
  mast.translate(0, 1.7, -0.3);
  paint(mast, DARK);
  parts.push(mast);
  const hub = new THREE.CylinderGeometry(0.4, 0.4, 0.25, 12);
  hub.translate(0, 2.15, -0.3);
  paint(hub, DARK);
  parts.push(hub);

  // main rotor blades — two crossed long thin boxes (4-blade look)
  for (const rot of [0, Math.PI / 2]) {
    const blade = new THREE.BoxGeometry(13.5, 0.08, 0.55);
    blade.translate(0, 2.2, -0.3);
    blade.rotateY(rot);                // rotate about the mast
    paint(blade, DARK);
    parts.push(blade);
  }

  // landing skids (two long tubes + struts)
  for (const side of [-1, 1]) {
    const skid = new THREE.CylinderGeometry(0.12, 0.12, 4.2, 8);
    skid.rotateX(Math.PI / 2);
    skid.translate(side * 1.1, -1.5, -0.4);
    paint(skid, DARK);
    parts.push(skid);
    for (const z of [-1.4, 0.6]) {
      const strut = new THREE.CylinderGeometry(0.08, 0.08, 1.3, 6);
      strut.translate(side * 1.1, -0.95, z);
      paint(strut, DARK);
      parts.push(strut);
    }
  }

  const norm = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(norm, false);
  if (!merged) throw new Error('helicopter merge failed');
  merged.computeVertexNormals();
  merged.center();
  merged.scale(0.05, 0.05, 0.05);
  return merged;
}

// Standard material — light alloy with subtle reflectivity, plus a self-lit
// floor so aircraft stay readable against the night sky. `color` tints the whole
// airframe (used for service-category colour-coding); `emissive` makes that
// colour glow at night.
export function aircraftMaterial({ color = 0xffffff, emissive = 0x223040, emissiveIntensity = 0.35 } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    vertexColors: true,
    metalness: 0.30,
    roughness: 0.45,
    envMapIntensity: 0.9,
    emissive: new THREE.Color(emissive),
    emissiveIntensity,
  });
}
