// snapmap.js — OPT-IN, DEFAULT OFF. Snap Map has no official API; this uses its public
// web endpoints. Enabled only when VANTAGE_ENABLE_SNAPMAP=1.
//
// STRICTLY AGGREGATE + PLACE-CENTRIC. We do NOT fetch, store, or map any individual
// snap, media, username, or device — only a single "public Snap activity is elevated
// here" density marker for the queried area. If it ever surfaced a person it would
// violate project rules, so it is deliberately built to be incapable of that. Degrades
// to empty on any failure (these endpoints are unofficial and frequently change).

import { getJson } from '../_http.js';
import { makeEvent } from '../types.js';

const HDRS = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://map.snapchat.com' };

async function latestEpoch() {
  const d = await getJson('https://ms.sc-jpl.com/web/getLatestTileSet', { method: 'POST', body: '{}', headers: HDRS });
  const infos = d?.tileSetInfos || [];
  const heat = infos.find((i) => String(i?.id?.type || '').toUpperCase().includes('HEAT')) || infos[0];
  return heat?.id?.epoch || null;
}

async function fetchSnap(bbox, cfg) {
  const epoch = await latestEpoch();
  if (!epoch) return [];
  const body = JSON.stringify({
    requestGeoPoint: { lat: bbox.lat, lon: bbox.lon },
    zoomLevel: 12,
    tileSetId: { flavor: 'default', epoch, type: 1 },
    radiusMeters: Math.min(bbox.radiusKm * 1000, 15000),
    maximumFuzzRadius: 0,
  });
  const d = await getJson('https://ms.sc-jpl.com/web/getPlaylist', { method: 'POST', body, headers: HDRS });
  const n = d?.manifest?.elements?.length || 0;
  if (!n) return [];
  // ONE aggregate density marker at the query centre — never per-snap, never a person.
  const ev = makeEvent({
    source: 'snapmap', nativeId: `heat:${bbox.lat.toFixed(2)},${bbox.lon.toFixed(2)}`,
    kind: 'social', severity: n >= 25 ? 2 : n >= 8 ? 1 : 0, lat: bbox.lat, lon: bbox.lon,
    title: `Public Snap activity: ${n} recent stories nearby`,
    description: 'Aggregate place-activity signal (no individuals).',
    sourceUrl: 'https://map.snapchat.com', ts: Date.now(), raw: null,
  });
  return ev ? [ev] : [];
}

export default [{
  id: 'snapmap', category: 'incidents', kinds: ['social'], keyless: true,
  optin: true, attribution: 'Snap Map (aggregate place-heat only)', label: 'Snap Map activity',
  enabled: (cfg) => !!cfg?.enableSnap,
  fetch: (bbox, cfg) => fetchSnap(bbox, cfg).catch(() => []),
}];
