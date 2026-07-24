// alertca.js — ALERTCalifornia (UC San Diego) wildfire/PTZ camera network. ~2,100 public
// pan-tilt-zoom cameras across California, hundreds in the SoCal mountains ringing LA
// (San Gabriels, Santa Monicas, Santa Susanas). Free, keyless, CORS-open — the same feed
// Watch Duty integrates.
//
// List: GET /public-camera-data/all_cameras-v3.json  (GeoJSON FeatureCollection, ~2.6 MB).
//   geometry.coordinates = [lon, lat, elev]   properties.id -> image key, properties.name.
//   properties.az_current / fov = current PTZ look direction (drives map view-cones).
//   properties.last_frame_ts   = epoch seconds of the newest frame (honest freshness).
// Snapshot: /public-camera-data/{id}/latest-frame.jpg  (refreshed ~every 10 s).
// No Referer/UA/key needed on any endpoint, but we proxy the image anyway (one code path,
// server-side caching, honest offline handling) — so alertcalifornia.org is host-allowlisted.
//
// The catalog is ~2.6 MB and near-static, so it's cached adapter-side for 30 min (with
// serve-stale on a failed refresh): /api/cameras re-collects on every 10-min route-cache
// miss PER BBOX KEY, and without this cache each pan/zoom of the city map re-downloaded
// the whole state-wide list.

import { getJson } from './_http.js';
import { makeCamera, inBbox, bboxIntersects, numOrNull } from './types.js';

const BASE = 'https://cameras.alertcalifornia.org/public-camera-data';
// The network is CA-wide with a few NV/OR border units — skip the fetch entirely unless the
// observer is somewhere in the western US near that footprint.
const CA_REGION = { minLat: 32.0, maxLat: 43.0, minLon: -124.6, maxLon: -114.0 };
const CATALOG_TTL = 30 * 60_000;

let _catalog = null;   // { at, feats } — adapter-level catalog cache (see header)
async function catalog() {
  if (_catalog && Date.now() - _catalog.at < CATALOG_TTL) return _catalog.feats;
  try {
    const fc = await getJson(`${BASE}/all_cameras-v3.json`);
    const feats = Array.isArray(fc?.features) ? fc.features : [];
    _catalog = { at: Date.now(), feats };
    return feats;
  } catch (err) {
    if (_catalog) return _catalog.feats;   // serve-stale: a blip never empties the map
    throw err;
  }
}

async function fetchAlertCa(bbox) {
  if (!bboxIntersects(bbox, CA_REGION)) return [];
  const feats = await catalog();
  const out = [];
  let dropped = 0;
  for (const ft of feats) {
    const c = ft?.geometry?.coordinates;
    const lo = numOrNull(c?.[0]), la = numOrNull(c?.[1]);   // GeoJSON is [lon, lat]
    const p = ft.properties || {};
    if (la == null || lo == null) { if (p.name) dropped++; continue; }  // null-coord cams dropped (unmappable)
    if (!inBbox(bbox, la, lo)) continue;
    const id = String(p.id || '').trim();
    if (!id) continue;
    const cam = makeCamera({
      provider: 'alertca', nativeId: id,
      name: p.name || id,
      lat: la, lon: lo,
      still: `${BASE}/${encodeURIComponent(id)}/latest-frame.jpg`,
      stream: null,
      proxied: true,
      az: p.az_current,
      fovDeg: p.fov,
      frameTs: Number.isFinite(p.last_frame_ts) ? p.last_frame_ts * 1000 : null,
    });
    if (cam) out.push(cam);
  }
  // Honest reporting: named cameras with no coordinates exist (fixed units the network
  // hasn't geolocated yet) — they can't be pinned, but they mustn't vanish silently.
  return { items: out, note: dropped ? `${dropped} unlocated dropped` : null };
}

export default [{
  id: 'alertca-cam', category: 'cameras', kinds: ['camera'], keyless: true,
  attribution: 'ALERTCalifornia · UC San Diego', label: 'ALERTCalifornia PTZ cameras',
  enabled: () => true,
  fetch: (bbox) => fetchAlertCa(bbox),
}];
