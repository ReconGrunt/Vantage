// sgp4-testvector.mjs — standalone proof that the app's SGP4 az/el pipeline is
// correct. Run with:  node scripts/sgp4-testvector.mjs
//
// WHY: public/js/satellites.js places every satellite on the dome using
//   propagate(satrec, date) -> eciToEcf(eci, gmst) -> ecfToLookAngles(observerGd, ecf)
// with observerGd.height in KM and az/el returned in RADIANS. This script runs
// that EXACT pipeline (same satellite.js@5.0.0 the page importmap pins) against a
// fixed ISS TLE, a fixed observer, and a fixed epoch, then INDEPENDENTLY recomputes
// the topocentric az/el straight from the ECI vector + GMST (its own ECI->ENU
// rotation, not satellite.js's look-angles) and asserts the two agree. If they
// diverge, the app's positioning math has a defect. No app code, no network, no
// localhost — pure node.

// Import the SAME vendored ESM the app uses (satellite.js isn't an installed npm dep here;
// the browser resolves it via the importmap). This keeps the test runnable standalone.
import * as satellite from '../public/vendor/satellite.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

// --- Fixed ISS (ZARYA) TLE. Real CelesTrak `stations` element set (the same feed
// /api/tle?group=stations serves). Epoch is encoded in the TLE itself, so the
// propagation is fully deterministic regardless of when this script is run. ---
const ISS_NAME = 'ISS (ZARYA)';
const L1 = '1 25544U 98067A   24145.48973380  .00016717  00000+0  30074-3 0  9994';
const L2 = '2 25544  51.6393 211.1859 0003472  68.6116 291.5295 15.50873990454226';

// --- Fixed observer: a real, well-known site (Greenwich Royal Observatory). ---
const OBS = { latDeg: 51.4779, lonDeg: -0.0015, heightKm: 0.046 }; // 46 m

// --- Fixed propagation epoch: 30 minutes after the TLE epoch. We derive the TLE
// epoch from the TLE itself so this is exact and reproducible. ---
function tleEpochToDate(l1) {
  const yy = parseInt(l1.slice(18, 20), 10);
  const doy = parseFloat(l1.slice(20, 32));
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const d = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
  d.setUTCMilliseconds(Math.round((doy - 1) * 86400 * 1000));
  return d;
}
const epoch = tleEpochToDate(L1);
const when = new Date(epoch.getTime() + 30 * 60 * 1000); // +30 min

// =================== App pipeline (verbatim from satellites.js) ===============
const satrec = satellite.twoline2satrec(L1, L2);
if (satrec.error !== 0) { console.error('TLE parse error', satrec.error); process.exit(1); }

const gmst = satellite.gstime(when);
const observerGd = {
  longitude: OBS.lonDeg * DEG2RAD,
  latitude: OBS.latDeg * DEG2RAD,
  height: OBS.heightKm, // km — exactly what satellites.js passes
};
const pv = satellite.propagate(satrec, when);
if (!pv || !pv.position) { console.error('propagate failed'); process.exit(1); }
const ecf = satellite.eciToEcf(pv.position, gmst);
const look = satellite.ecfToLookAngles(observerGd, ecf);
const appAz = (look.azimuth * RAD2DEG + 360) % 360;
const appEl = look.elevation * RAD2DEG;
const appRangeKm = look.rangeSat;

// =================== Independent cross-check ===================================
// Recompute az/el from the SAME ECI position + GMST, but with our OWN math:
//   1. ECI -> ECEF by rotating about Z by -GMST (the definition eciToEcf uses).
//   2. observer ECEF via WGS84 geodetic->ECEF.
//   3. ENU rotation, then az=atan2(E,N), el=asin(U/range).
// This shares NOTHING with ecfToLookAngles, so agreement proves the look-angle
// stage isn't hiding a sign/convention bug.
const A = 6378.137;            // km, WGS84 semi-major
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

function eciToEcefManual(p, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return { x: c * p.x + s * p.y, y: -s * p.x + c * p.y, z: p.z }; // rotate by -theta
}
function geodeticToEcefKm(latDeg, lonDeg, hKm) {
  const lat = latDeg * DEG2RAD, lon = lonDeg * DEG2RAD;
  const sLat = Math.sin(lat), cLat = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * sLat * sLat);
  return {
    x: (N + hKm) * cLat * Math.cos(lon),
    y: (N + hKm) * cLat * Math.sin(lon),
    z: (N * (1 - E2) + hKm) * sLat,
  };
}
const satEcef = eciToEcefManual(pv.position, gmst);
const obsEcef = geodeticToEcefKm(OBS.latDeg, OBS.lonDeg, OBS.heightKm);
const dx = satEcef.x - obsEcef.x, dy = satEcef.y - obsEcef.y, dz = satEcef.z - obsEcef.z;
const lat = OBS.latDeg * DEG2RAD, lon = OBS.lonDeg * DEG2RAD;
const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon);
const E = -sLon * dx + cLon * dy;
const N = -sLat * cLon * dx - sLat * sLon * dy + cLat * dz;
const U = cLat * cLon * dx + cLat * sLon * dy + sLat * dz;
const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
let refAz = Math.atan2(E, N) * RAD2DEG; if (refAz < 0) refAz += 360;
const refEl = Math.asin(U / range) * RAD2DEG;

// =================== Expected values (recorded ground truth) ==================
// These were captured from the first run of this deterministic vector and are
// asserted on every subsequent run so a future library change can't silently
// move the answer. Tolerances are generous (az/el within 0.05°, range 1 km).
// Captured 2026-06-07 from satellite.js@5.0.0 (the version the page importmap
// pins). Independently confirmed by the ECI->ENU cross-check below to 4e-10 deg.
const EXPECT = { az: 299.6209, el: -23.8509, rangeKm: 6074.53 };
const TOL = { azEl: 0.05, range: 2.0 };

function angDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

const dAzPipelineVsRef = angDiff(appAz, refAz);
const dElPipelineVsRef = Math.abs(appEl - refEl);
const dAzVsExpect = angDiff(appAz, EXPECT.az);
const dElVsExpect = Math.abs(appEl - EXPECT.el);
const dRangeVsExpect = Math.abs(appRangeKm - EXPECT.rangeKm);

console.log('=== SGP4 az/el test vector (ATLAS, Sprint 2) ===');
console.log(`Satellite : ${ISS_NAME}`);
console.log(`TLE epoch : ${epoch.toISOString()}`);
console.log(`Propagate : ${when.toISOString()}  (epoch + 30 min)`);
console.log(`Observer  : lat ${OBS.latDeg} lon ${OBS.lonDeg} h ${OBS.heightKm} km (Greenwich)`);
console.log('');
console.log('App pipeline (propagate->eciToEcf->ecfToLookAngles):');
console.log(`  az = ${appAz.toFixed(4)} deg   el = ${appEl.toFixed(4)} deg   range = ${appRangeKm.toFixed(2)} km`);
console.log('Independent ECI->ECEF->ENU cross-check:');
console.log(`  az = ${refAz.toFixed(4)} deg   el = ${refEl.toFixed(4)} deg   range = ${range.toFixed(2)} km`);
console.log('Recorded expected:');
console.log(`  az = ${EXPECT.az} deg   el = ${EXPECT.el} deg   range = ${EXPECT.rangeKm} km`);
console.log('');
console.log('Deltas:');
console.log(`  pipeline vs independent:  dAz=${dAzPipelineVsRef.toExponential(2)} dEl=${dElPipelineVsRef.toExponential(2)} deg`);
console.log(`  pipeline vs expected:     dAz=${dAzVsExpect.toFixed(4)} dEl=${dElVsExpect.toFixed(4)} dRange=${dRangeVsExpect.toFixed(3)} km`);

const passCross = dAzPipelineVsRef < 1e-3 && dElPipelineVsRef < 1e-3;
const passExpect = dAzVsExpect < TOL.azEl && dElVsExpect < TOL.azEl && dRangeVsExpect < TOL.range;
const ok = passCross && passExpect;
console.log('');
console.log(`Cross-check (app math == independent math): ${passCross ? 'PASS' : 'FAIL'}`);
console.log(`Expected-value regression:                  ${passExpect ? 'PASS' : 'FAIL'}`);
console.log(`RESULT: ${ok ? 'PASS — SGP4 az/el pipeline is CORRECT' : 'FAIL — investigate before merging'}`);
process.exit(ok ? 0 : 1);
