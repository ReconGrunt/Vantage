// projection-test.mjs — LENS Sprint 2 P0 PROJECTION-CORRECTNESS TEST.
// Run with:  node scripts/projection-test.mjs
//
// WHY: a plane drawn in the wrong part of the ceiling sky is worse than any perf
// bug. This proves the EXACT app math — public/js/coords.js `azAltToVector` /
// `domePosition` (the real module, imported through a tiny `three` shim because
// the app pulls three from a CDN importmap that node can't see) — maps known
// az/alt positions to (1) the correct THREE world vector and (2) the correct
// on-SCREEN location in CEILING ("skylight") mode.
//
// Sky convention (coords.js header): az deg 0=N, 90=E, CW; alt deg 0=horizon,
// 90=zenith. World: +X=East, +Y=Up, -Z=North (right-handed).
//
// Ceiling camera (main.js:574-578): camera at origin, lookAt (0,2,0) i.e. straight
// up +Y; camera.up = (sin nr, 0, -cos nr) with nr = northDeg*DEG. With northDeg=0
// that up vector is (0,0,-1) = world North. So in the projected image:
//   - frame CENTER  = the view direction = +Y = ZENITH
//   - screen UP (+v) = camera.up projected = world North (-Z)
//   - screen RIGHT(+u) = (forward x up) for a camera looking along -? — three uses
//     a right-handed view basis where screenRight = normalize(up x (-viewDir)).
//     viewDir = +Y, up = -Z  ->  screenRight = up x (-viewDir) = (-Z) x (-Y)
//                                            = -( Z x Y ) = -(-X) = +X? — compute
//     numerically below rather than trust the hand-wave. The KEY assertion LENS
//     verified in Sprint 1: ceiling mode shows N=TOP, E=LEFT (the physically
//     correct view-from-below). We assert exactly that here.

import { register } from 'node:module';
register('./three-loader.mjs', import.meta.url);

const { azAltToVector, domePosition } = await import('../public/js/coords.js');

// --- screen mapping for CEILING mode, derived from main.js's camera setup ----
// We reproduce three's view-basis math (PerspectiveCamera looking from origin):
//   viewDir (into screen) = normalize(target - eye) = +Y
//   up      = camera.up   = (sin nr, 0, -cos nr)
// three builds the camera world matrix with: z-axis = -viewDir (points OUT of
// screen, toward viewer), x-axis = normalize(up x zAxis), y-axis = zAxis x xAxis.
// Screen +u (right) = camera x-axis; screen +v (up) = camera y-axis. A world point
// P projects to screen coords (u,v) = (P·xAxis, P·yAxis) (sign of those dots).
function ceilingScreen(P, northDeg = 0) {
  const nr = northDeg * Math.PI / 180;
  const up = { x: Math.sin(nr), y: 0, z: -Math.cos(nr) };
  const viewDir = { x: 0, y: 1, z: 0 };                 // lookAt straight up
  const zA = { x: -viewDir.x, y: -viewDir.y, z: -viewDir.z }; // out of screen
  // xAxis = up x zA
  const xA = {
    x: up.y * zA.z - up.z * zA.y,
    y: up.z * zA.x - up.x * zA.z,
    z: up.x * zA.y - up.y * zA.x,
  };
  const nx = Math.hypot(xA.x, xA.y, xA.z) || 1;
  xA.x /= nx; xA.y /= nx; xA.z /= nx;
  // yAxis = zA x xA
  const yA = {
    x: zA.y * xA.z - zA.z * xA.y,
    y: zA.z * xA.x - zA.x * xA.z,
    z: zA.x * xA.y - zA.y * xA.x,
  };
  return {
    u: P.x * xA.x + P.y * xA.y + P.z * xA.z,   // +u = screen RIGHT
    v: P.x * yA.x + P.y * yA.y + P.z * yA.z,   // +v = screen UP
  };
}

const R = 700; // an arbitrary shell radius for domePosition checks
const EPS = 1e-9;
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail) {
  (cond ? pass++ : fail++);
  results.push(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

// =================== The three known positions ===============================
// 1) Due NORTH at 45 deg elevation
// 2) Due EAST at 30 deg elevation
// 3) Near ZENITH (89.9 deg, due North so az is well-defined)
const cases = [
  { name: 'due NORTH @ 45 deg', az: 0, alt: 45 },
  { name: 'due EAST  @ 30 deg', az: 90, alt: 30 },
  { name: 'near ZENITH (alt 89.9)', az: 0, alt: 89.9 },
];

console.log('=== LENS Sprint 2 — projection-correctness test (coords.js) ===\n');

for (const c of cases) {
  const v = azAltToVector(c.az, c.alt);
  const d = domePosition(c.az, c.alt, R);
  const s = ceilingScreen(v, 0);
  console.log(`${c.name}:  az=${c.az} alt=${c.alt}`);
  console.log(`   world vector = (${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`);
  console.log(`   domePosition = (${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)})  (R=${R})`);
  console.log(`   ceiling screen (u=right,v=up) = (${s.u.toFixed(4)}, ${s.v.toFixed(4)})`);

  // domePosition must equal azAltToVector * R (direction exact, radius = scale)
  check(`${c.name}: domePosition == unit * R`,
    near(d.x, v.x * R) && near(d.y, v.y * R) && near(d.z, v.z * R));

  if (c.name.startsWith('due NORTH')) {
    // World: North = -Z. At 45 deg: x=0, y=z magnitude equal, z negative.
    check('NORTH -> world -Z (x~0, z<0)', near(v.x, 0, EPS) && v.z < 0);
    check('NORTH @45: y == -z (45 deg)', near(v.y, -v.z));
    // Screen: North must be at TOP -> v>0 and u~0 (centered horizontally)
    check('NORTH -> screen TOP (v>0, u~0)', s.v > 0 && near(s.u, 0, 1e-9));
  }
  if (c.name.startsWith('due EAST')) {
    // World: East = +X. So x>0, z~0.
    check('EAST -> world +X (x>0, z~0)', v.x > 0 && near(v.z, 0, EPS));
    check('EAST: x == cos(alt) (=cos30)', near(v.x, Math.cos(30 * Math.PI / 180)));
    // Screen: per view-from-below, EAST must be on the LEFT -> u<0
    check('EAST -> screen LEFT (u<0)', s.u < 0);
  }
  if (c.name.startsWith('near ZENITH')) {
    // World: zenith = +Y. y ~ 1, x,z ~ 0.
    check('ZENITH -> world +Y (y~1)', near(v.y, Math.sin(89.9 * Math.PI / 180)) && v.y > 0.999);
    // Screen: zenith maps to frame CENTER -> u~0 and v~0
    check('ZENITH -> screen CENTER (u~0, v~0)', Math.abs(s.u) < 0.02 && Math.abs(s.v) < 0.02);
  }
  console.log('');
}

// Bonus: northDeg rotation sanity — set north=90 (East at top). Due-East should
// then move to screen TOP (v>0) and North to the RIGHT or LEFT consistently.
{
  const east = azAltToVector(90, 45);
  const s = ceilingScreen(east, 90);
  check('northDeg=90 puts EAST at screen TOP (v>0)', s.v > 0,
    `screen=(${s.u.toFixed(3)}, ${s.v.toFixed(3)})`);
}

console.log('--- assertions ---');
for (const r of results) console.log(r);
console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
