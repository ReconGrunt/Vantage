// hotspots.js — client-side hotspot engine for the Ground/City domain. PURE: given the
// current events + parameters it returns a ranked list of activity clusters (for a heat
// overlay + a "top hotspots" list). No DOM, no network, no per-frame allocation in the
// render loop — it runs once per incident poll / filter change, and the renderer only
// DRAWS the last result.
//
//   score(cell) = Σ_event  severityWeight(sev) · exp(-ageMinutes / halfLife)
//
// Recency is the point: a working structure fire from 4 minutes ago outweighs a hundred
// day-old 311 calls, so hotspots track what's happening NOW, not just where data is dense.

const SEV_WEIGHT = [0.35, 1.0, 2.4, 4.5]; // index by severity 0..3

export function severityWeight(sev) {
  const s = Math.max(0, Math.min(3, Math.round(sev || 0)));
  return SEV_WEIGHT[s];
}

// events: normalized Event[]; opts: { now, halfLifeMin, cellDeg, kinds:Set|null }
// Returns { ranked: [{ lat, lon, score, count, topKind, sample, sev }], maxScore }.
export function computeHotspots(events, { now = Date.now(), halfLifeMin = 45, cellDeg = 0.0045, kinds = null } = {}) {
  const cells = new Map();
  const decay = Math.LN2 / (halfLifeMin * 60_000); // per-ms decay for exp(-age/halfLife)
  for (const e of events) {
    if (!e || e.lat == null) continue;
    if (kinds && !kinds.has(e.kind)) continue;
    const age = now - (e.ts || now);
    const recency = age > 0 ? Math.exp(-decay * age) : 1;
    if (recency < 0.02) continue;                       // >~5.6 half-lives old → ignore
    const w = severityWeight(e.severity) * recency;
    if (w < 0.02) continue;
    const gx = Math.round(e.lon / cellDeg), gy = Math.round(e.lat / cellDeg);
    const key = gx + '_' + gy;
    let c = cells.get(key);
    if (!c) { c = { sumW: 0, sumLat: 0, sumLon: 0, count: 0, kinds: {}, sample: null, sev: 0 }; cells.set(key, c); }
    c.sumW += w; c.sumLat += e.lat * w; c.sumLon += e.lon * w; c.count += 1;
    c.kinds[e.kind] = (c.kinds[e.kind] || 0) + w;
    if (!c.sample || e.severity > c.sev || (e.severity === c.sev && (e.ts || 0) > (c.sample.ts || 0))) {
      c.sample = e; c.sev = Math.max(c.sev, e.severity || 0);
    }
  }
  const ranked = [];
  let maxScore = 0;
  for (const c of cells.values()) {
    if (c.sumW <= 0) continue;
    let topKind = 'civic', best = -1;
    for (const k in c.kinds) if (c.kinds[k] > best) { best = c.kinds[k]; topKind = k; }
    const h = { lat: c.sumLat / c.sumW, lon: c.sumLon / c.sumW, score: c.sumW, count: c.count, topKind, sample: c.sample, sev: c.sev };
    ranked.push(h);
    if (h.score > maxScore) maxScore = h.score;
  }
  ranked.sort((a, b) => b.score - a.score);
  return { ranked, maxScore };
}
