// tfl.js — Transport for London JamCams (London traffic cameras). Works KEYLESS at a
// low rate (an optional free app_key via TFL_APP_KEY lifts it). Region-gated to Greater
// London — a genuinely free non-US camera layer. Images are hotlinkable S3 stills.

import { getJson } from './_http.js';
import { makeCamera, inBbox, bboxIntersects, numOrNull } from './types.js';

const LONDON = { minLat: 51.25, maxLat: 51.72, minLon: -0.55, maxLon: 0.32 };

async function fetchTfl(bbox, cfg) {
  if (!bboxIntersects(bbox, LONDON)) return [];
  const key = cfg.tflKey ? `?app_key=${encodeURIComponent(cfg.tflKey)}` : '';
  const d = await getJson(`https://api.tfl.gov.uk/Place/Type/JamCam${key}`);
  const out = [];
  for (const p of (Array.isArray(d) ? d : [])) {
    const la = numOrNull(p.lat), lo = numOrNull(p.lon);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const img = (p.additionalProperties || []).find((a) => a.key === 'imageUrl')?.value;
    if (!img) continue;
    const cam = makeCamera({ provider: 'tfl', nativeId: p.id, name: p.commonName || 'JamCam', lat: la, lon: lo, still: img, proxied: true });
    if (cam) out.push(cam);
  }
  return out;
}

export default [{
  id: 'tfl-jamcam', category: 'cameras', kinds: ['camera'], keyless: true,
  label: 'TfL JamCams (London)', attribution: 'Powered by TfL Open Data',
  enabled: () => true,
  fetch: (b, c) => fetchTfl(b, c),
}];
