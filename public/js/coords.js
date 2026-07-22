// coords.js — the geometry that keeps everything honest.
//
// Sky convention used everywhere in this app:
//   azimuth  — degrees, 0 = North, 90 = East, 180 = South, 270 = West (clockwise)
//   altitude — degrees, 0 = horizon, +90 = zenith, negative = below horizon
//
// Three.js world convention we map onto:
//   +X = East, +Y = Up (zenith), -Z = North   (right-handed; camera starts facing North)

import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// WGS84 ellipsoid
const A = 6378137.0;            // semi-major axis (m)
const F = 1 / 298.257223563;    // flattening
const E2 = F * (2 - F);         // eccentricity squared

// Geodetic (lat, lon in deg; height in m) -> ECEF (m)
export function geodeticToEcef(latDeg, lonDeg, h = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return {
    x: (N + h) * cosLat * Math.cos(lon),
    y: (N + h) * cosLat * Math.sin(lon),
    z: (N * (1 - E2) + h) * sinLat,
  };
}

// Azimuth/altitude (deg) of a target geodetic point as seen from an observer
// geodetic point. Accounts for Earth curvature via ECEF->ENU. Range in metres.
export function lookAngles(obs, target) {
  const o = geodeticToEcef(obs.lat, obs.lon, obs.alt || 0);
  const t = geodeticToEcef(target.lat, target.lon, target.alt || 0);
  const dx = t.x - o.x, dy = t.y - o.y, dz = t.z - o.z;

  const lat = obs.lat * DEG, lon = obs.lon * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);

  const e = -sinLon * dx + cosLon * dy;
  const n = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const u = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let az = Math.atan2(e, n) * RAD;
  if (az < 0) az += 360;
  const alt = Math.asin(u / range) * RAD;
  return { azimuth: az, altitude: alt, range };
}

// Map azimuth/altitude to a unit direction in Three.js world space, writing into
// `out` (no allocation) — use this on hot per-frame paths (satellites, planets).
export function azAltInto(out, azDeg, altDeg) {
  const az = azDeg * DEG, alt = altDeg * DEG;
  const cosAlt = Math.cos(alt);
  return out.set(
    cosAlt * Math.sin(az),   // East  (+X)
    Math.sin(alt),           // Up    (+Y)
    -cosAlt * Math.cos(az),  // North (-Z)
  );
}

// Convenience allocating variant (fine for one-shot/setup callers).
export function azAltToVector(azDeg, altDeg) {
  return azAltInto(new THREE.Vector3(), azDeg, altDeg);
}

// Place an object on the dome. We compress altitude/range non-linearly so a
// plane 8 km up and a satellite 500 km up are both visible on the same dome,
// while preserving their true direction (az/alt). Direction is exact; radius is
// a legibility choice, not a physical distance.
export function domePosition(azDeg, altDeg, shellRadius) {
  return azAltToVector(azDeg, altDeg).multiplyScalar(shellRadius);
}

// Allocation-free dome placement: write straight into a caller-owned Vector3.
export function domePositionInto(out, azDeg, altDeg, shellRadius) {
  return azAltInto(out, azDeg, altDeg).multiplyScalar(shellRadius);
}
