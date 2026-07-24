// alertca.js — ALERTCalifornia (UC San Diego) wildfire/PTZ camera network. ~2,100 public
// pan-tilt-zoom cameras across California, hundreds in the SoCal mountains ringing LA
// (San Gabriels, Santa Monicas, Santa Susanas). Free, keyless, CORS-open — the same feed
// Watch Duty integrates.
//
// List: GET /public-camera-data/all_cameras-v3.json  (GeoJSON FeatureCollection, ~2.6 MB).
//   geometry.coordinates = [lon, lat, elev]   properties.id -> image key, properties.name.
// Snapshot: /public-camera-data/{id}/latest-frame.jpg  (refreshed ~every 10 s).
// No Referer/UA/key needed on any endpoint, but we proxy the image anyway (one code path,
// server-side caching, honest offline handling) — so alertcalifornia.org is host-allowlisted.

import { getJson } from './_http.js';
import { makeCamera, inBbox, bboxIntersects, numOrNull } from './types.js';

const BASE = 'https://cameras.alertcalifornia.org/public-camera-data';
// The network is CA-wide with a few NV/OR border units — skip the fetch entirely unless the
// observer is somewhere in the western US near that footprint.
const CA_REGION = { minLat: 32.0, maxLat: 43.0, minLon: -124.6, maxLon: -114.0 };

async function fetchAlertCa(bbox) {
  if (!bboxIntersects(bbox, CA_REGION)) return [];
  const fc = await getJson(`${BASE}/all_cameras-v3.json`);
  const feats = Array.isArray(fc?.features) ? fc.features : [];
  const out = [];
  for (const ft of feats) {
    const c = ft?.geometry?.coordinates;
    const lo = numOrNull(c?.[0]), la = numOrNull(c?.[1]);   // GeoJSON is [lon, lat]
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;   // null-coord cams dropped
    const p = ft.properties || {};
    const id = String(p.id || '').trim();
    if (!id) continue;
    const cam = makeCamera({
      provider: 'alertca', nativeId: id,
      name: p.name || id,
      lat: la, lon: lo,
      still: `${BASE}/${encodeURIComponent(id)}/latest-frame.jpg`,
      stream: null,
      proxied: true,
    });
    if (cam) out.push(cam);
  }
  return out;
}

export default [{
  id: 'alertca-cam', category: 'cameras', kinds: ['camera'], keyless: true,
  attribution: 'ALERTCalifornia · UC San Diego', label: 'ALERTCalifornia PTZ cameras',
  enabled: () => true,
  fetch: (bbox) => fetchAlertCa(bbox),
}];
