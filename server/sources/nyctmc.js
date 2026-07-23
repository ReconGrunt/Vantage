// nyctmc.js — NYC DOT (Traffic Management Center) public traffic cameras. No key.
// The endpoint returns every camera citywide; we bbox-filter. Field shapes vary across
// revisions of the API, so extraction is defensive — a shape change degrades to empty,
// never a crash (matches the whole-project serve-stale ethos).

import { getJson } from './_http.js';
import { makeCamera, inBbox, bboxIntersects, numOrNull } from './types.js';

const NYC = { minLat: 40.48, maxLat: 40.93, minLon: -74.27, maxLon: -73.68 };

async function fetchNyc(bbox) {
  if (!bboxIntersects(bbox, NYC)) return [];
  const d = await getJson('https://webcams.nyctmc.org/api/cameras/');
  const list = Array.isArray(d) ? d : (d?.cameras || d?.features || []);
  const out = [];
  for (const raw of list) {
    const c = raw?.properties || raw;
    if (c.isOnline === false || c.online === false) continue;
    const la = numOrNull(c.latitude ?? c.lat), lo = numOrNull(c.longitude ?? c.lng ?? c.lon);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const id = c.id || c.cameraId || c.ID || `${la.toFixed(5)},${lo.toFixed(5)}`;
    const still = c.imageUrl || c.image || `https://webcams.nyctmc.org/api/cameras/${id}/image`;
    const cam = makeCamera({
      provider: 'nyc-dot', nativeId: id, name: c.name || c.area || 'NYC DOT camera',
      lat: la, lon: lo, still, proxied: true, // nyctmc image host may block hotlinking → route via /api/camimg
    });
    if (cam) out.push(cam);
  }
  return out;
}

export default [{
  id: 'nyc-dot-cam', category: 'cameras', kinds: ['camera'], keyless: true,
  attribution: 'NYC DOT · nyctmc.org', label: 'NYC DOT cameras',
  enabled: () => true,
  fetch: (bbox) => fetchNyc(bbox),
}];
