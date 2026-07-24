// sat-worker.js — off-main-thread SGP4 propagation for the satellite layer.
//
// The per-frame propagate → eciToEcf → ecfToLookAngles → eciToGeodetic loop over every
// satrec is the #1 main-thread CPU cost (satellites.js). This worker owns the satrec array
// (built in-worker from the TLE lines so satrecs never cross the boundary) and answers each
// `tick` with the currently-visible set as plain numbers.
//
// Module worker: importmaps do NOT apply to workers, so satellite.js is imported by its
// ABSOLUTE served path (the same file the importmap points at). This is what lets a no-build
// worker share the exact SGP4 implementation the main thread uses.

import * as satellite from '/vendor/satellite.js';

const DEG = Math.PI / 180;
let satrecs = []; // { name, satrec }

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;

  if (m.type === 'load') {
    satrecs = [];
    for (const s of m.sats || []) {
      try {
        const r = satellite.twoline2satrec(s.line1, s.line2);
        if (r.error === 0) satrecs.push({ name: s.name, satrec: r });
      } catch { /* skip bad TLE — identical to the main-thread guard */ }
    }
    return;
  }

  if (m.type === 'tick') {
    const date = new Date(m.dateMs);
    const gmst = satellite.gstime(date);
    const gd = {
      longitude: m.observer.lon * DEG,
      latitude: m.observer.lat * DEG,
      height: (m.observer.alt || 0) / 1000, // km
    };
    const visible = [];
    for (const { name, satrec } of satrecs) {
      const pv = satellite.propagate(satrec, date);
      if (!pv || !pv.position) continue;
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const look = satellite.ecfToLookAngles(gd, ecf);
      const altDeg = look.elevation * 180 / Math.PI;
      if (altDeg < 0) continue; // below horizon → not drawn
      const azDeg = (look.azimuth * 180 / Math.PI + 360) % 360;
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const v = pv.velocity;
      const speed = v ? Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) : null;
      visible.push({
        name, azDeg, altDeg,
        heightKm: geo.height, speedKmS: speed, rangeKm: look.rangeSat,
        isISS: /ISS|ZARYA/i.test(name),
      });
    }
    self.postMessage({ type: 'positions', visible });
  }
};
