// open511sf.js — 511 SF Bay traffic events (MTC), the Open511 standard. Free token
// (511.org/open-data), so OFF until FIVE11_SF_TOKEN is set. Region-gated to the Bay Area.
// Pairs with the SF Police/Fire CAD feeds to add road incidents + closures.

import { getJson } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, numOrNull } from './types.js';

const BAY = { minLat: 36.9, maxLat: 38.9, minLon: -123.2, maxLon: -121.2 };
const SEV = { MINOR: 1, MODERATE: 2, MAJOR: 3, SEVERE: 3, UNKNOWN: 1 };

async function fetch511(bbox, cfg) {
  if (!bboxIntersects(bbox, BAY)) return [];
  const d = await getJson(`https://api.511.org/traffic/events?api_key=${encodeURIComponent(cfg.five11SfToken)}&format=json`);
  const list = d?.events || [];
  const out = [];
  for (const e of list) {
    const c = e.geography?.type === 'Point' ? e.geography.coordinates : null;
    const lo = numOrNull(c?.[0]), la = numOrNull(c?.[1]);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const kind = /construction|roadwork/i.test(e.event_type || '') ? 'civic' : 'traffic';
    const ev = makeEvent({
      source: '511sfbay', nativeId: e.id, kind, severity: SEV[(e.severity || '').toUpperCase()] ?? 1,
      lat: la, lon: lo, title: e.headline || e.event_type || 'Traffic event',
      description: (e.event_subtypes || []).join(', '), sourceUrl: e.url || 'https://511.org',
      ts: Date.parse(e.updated) || Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: '511sfbay', category: 'incidents', kinds: ['traffic', 'civic'], keyless: false,
  label: '511 SF Bay traffic', attribution: '511.org · MTC',
  enabled: (cfg) => !!cfg.five11SfToken,
  fetch: (b, c) => fetch511(b, c).catch(() => []),
}];
