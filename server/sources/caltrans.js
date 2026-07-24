// caltrans.js — Caltrans CWWP2 public CCTV snapshots. Explicitly free ("no charge for
// use of this data"), no key, per-district static JSON. We only fetch the district(s)
// whose rough area overlaps the observer, then bbox-filter the cameras inside.
// Schema: { data: [ { cctv: { index, location:{locationName,nearbyPlace,latitude,longitude},
//                            imageData:{ static:{ currentImageURL }, streamingVideoURL } } } ] }

import { getJson } from './_http.js';
import { makeCamera, inBbox, bboxIntersects, numOrNull } from './types.js';

// district dir in the path is un-padded (d4), the filename is zero-padded (cctvStatusD04).
const DISTRICTS = [
  { d: 3, region: { minLat: 38.2, maxLat: 39.6, minLon: -122.1, maxLon: -119.9 } }, // Sacramento
  { d: 4, region: { minLat: 36.9, maxLat: 38.6, minLon: -123.2, maxLon: -121.2 } }, // Bay Area
  { d: 7, region: { minLat: 33.6, maxLat: 34.9, minLon: -119.7, maxLon: -117.6 } }, // LA / Ventura
  { d: 8, region: { minLat: 33.4, maxLat: 35.5, minLon: -117.8, maxLon: -114.4 } }, // San Bernardino / Riverside
  { d: 11, region: { minLat: 32.5, maxLat: 33.5, minLon: -117.7, maxLon: -114.5 } }, // San Diego / Imperial
  { d: 12, region: { minLat: 33.4, maxLat: 33.98, minLon: -118.2, maxLon: -117.4 } }, // Orange
];

async function fetchDistrict(dist, bbox) {
  if (!bboxIntersects(bbox, dist.region)) return [];
  const url = `https://cwwp2.dot.ca.gov/data/d${dist.d}/cctv/cctvStatusD${String(dist.d).padStart(2, '0')}.json`;
  const d = await getJson(url);
  const out = [];
  for (const rec of d?.data || []) {
    const c = rec?.cctv;
    if (!c) continue;
    const loc = c.location || {};
    const la = numOrNull(loc.latitude), lo = numOrNull(loc.longitude);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    // Drop units the agency itself reports as out of service — ~89 of D07's 540 cameras.
    // Pinning them anyway is what made the map look like "most cameras are down".
    if (String(c.inService).toLowerCase() === 'false') continue;
    const still = c.imageData?.static?.currentImageURL || null;
    const stream = c.imageData?.streamingVideoURL || null;
    if (!still && !stream) continue;
    const cam = makeCamera({
      provider: 'caltrans', nativeId: c.index || `${la.toFixed(5)},${lo.toFixed(5)}`,
      name: loc.locationName || loc.nearbyPlace || 'Caltrans CCTV', lat: la, lon: lo, still, stream,
      // Serve every camera through /api/camimg rather than hotlinking from the client:
      // one code path, server-side caching, and a real error we can show instead of a
      // broken <img>.
      proxied: true,
    });
    if (cam) out.push(cam);
  }
  return out;
}

export default [{
  id: 'caltrans-cam', category: 'cameras', kinds: ['camera'], keyless: true,
  attribution: 'Caltrans CWWP2 (no charge)', label: 'Caltrans CCTV',
  enabled: () => true,
  fetch: (bbox) => Promise.all(DISTRICTS.map((x) => fetchDistrict(x, bbox).catch(() => []))).then((a) => a.flat()),
}];
