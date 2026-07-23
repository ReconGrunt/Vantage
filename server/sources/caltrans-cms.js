// caltrans-cms.js — Caltrans Changeable Message Signs: what the freeway signs are saying
// RIGHT NOW. Free, no key, official, and small (~170 KB per district).
//
// This is a cheap, high-signal real-time source: when there's a crash, closure, fatality
// investigation, Amber/Silver alert or major delay, the CMS network is broadcasting it in
// plain text within minutes — often before any structured incident feed publishes. Most
// signs read "Blank" (nothing to report), so we emit only the ones actually displaying a
// message, which keeps the map quiet until something is genuinely happening.

import { getJson } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, numOrNull } from './types.js';

const DISTRICTS = [
  { d: 3, region: { minLat: 38.2, maxLat: 39.6, minLon: -122.1, maxLon: -119.9 } },
  { d: 4, region: { minLat: 36.9, maxLat: 38.6, minLon: -123.2, maxLon: -121.2 } },
  { d: 7, region: { minLat: 33.6, maxLat: 34.9, minLon: -119.7, maxLon: -117.6 } }, // LA / Ventura
  { d: 8, region: { minLat: 33.4, maxLat: 35.5, minLon: -117.8, maxLon: -114.4 } },
  { d: 11, region: { minLat: 32.5, maxLat: 33.5, minLon: -117.7, maxLon: -114.5 } },
  { d: 12, region: { minLat: 33.4, maxLat: 33.98, minLon: -118.2, maxLon: -117.4 } },
];

// Flatten phase1/2/3 LineN fields into one readable string.
function messageText(m) {
  if (!m || !m.display || m.display === 'Blank') return '';
  const parts = [];
  for (const phase of ['phase1', 'phase2', 'phase3']) {
    const p = m[phase];
    if (!p || typeof p !== 'object') continue;
    for (const k of Object.keys(p)) {
      if (!/Line\d+$/.test(k)) continue;
      const v = p[k];
      if (v && v !== 'Not Reported') parts.push(String(v).trim());
    }
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function severityOf(text) {
  const t = text.toLowerCase();
  if (/amber alert|silver alert|fatal|closed|full closure|evacuat/.test(t)) return 3;
  if (/accident|crash|collision|incident|delay|stalled|fire|police activity/.test(t)) return 2;
  return 1;
}

async function fetchDistrict(dist, bbox) {
  if (!bboxIntersects(bbox, dist.region)) return [];
  const url = `https://cwwp2.dot.ca.gov/data/d${dist.d}/cms/cmsStatusD${String(dist.d).padStart(2, '0')}.json`;
  const raw = await getJson(url, { timeout: 12_000 });
  const out = [];
  for (const rec of raw?.data || []) {
    const c = rec?.cms;
    if (!c || c.inService === 'false') continue;
    const text = messageText(c.message);
    if (!text) continue;                       // sign is blank — nothing happening
    const loc = c.location || {};
    const la = numOrNull(loc.latitude), lo = numOrNull(loc.longitude);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const where = [loc.route, loc.locationName, loc.nearbyPlace].filter((x) => x && x !== 'Not Reported').join(' · ');
    const ev = makeEvent({
      source: 'caltrans-cms', nativeId: c.index,
      kind: 'traffic', severity: severityOf(text), lat: la, lon: lo,
      title: text.slice(0, 120),
      description: `Freeway sign · ${where}`,
      sourceUrl: 'https://quickmap.dot.ca.gov',
      ts: Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'caltrans-cms', category: 'incidents', kinds: ['traffic'], keyless: true,
  label: 'Caltrans message signs (live)', attribution: 'Caltrans CWWP2 (no charge)',
  enabled: () => true,
  fetch: (bbox) => Promise.all(DISTRICTS.map((x) => fetchDistrict(x, bbox).catch(() => []))).then((a) => a.flat()),
}];
