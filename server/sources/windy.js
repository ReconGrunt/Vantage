// windy.js — Windy Webcams v3 (global public webcams). Free API key (api.windy.com),
// so OFF until WINDY_KEY is set. Preview image URLs are short-lived, so cameras are
// marked proxied:true → the client fetches them through /api/camimg (host-allow-listed).

import { getJson } from './_http.js';
import { makeCamera, numOrNull } from './types.js';

async function fetchWindy(bbox, cfg) {
  const url = `https://api.windy.com/webcams/api/v3/webcams`
    + `?nearby=${bbox.lat},${bbox.lon},${Math.min(Math.round(bbox.radiusKm), 50)}&limit=50&include=images,location`;
  const d = await getJson(url, { headers: { 'x-windy-api-key': cfg.windyKey } });
  const list = d?.webcams || [];
  const out = [];
  for (const w of list) {
    const la = numOrNull(w.location?.latitude), lo = numOrNull(w.location?.longitude);
    const still = w.images?.current?.preview || w.images?.daylight?.preview || null;
    if (la == null || lo == null || !still) continue;
    const cam = makeCamera({
      provider: 'windy', nativeId: w.webcamId ?? w.id, name: w.title || 'Webcam',
      lat: la, lon: lo, still, proxied: true,
    });
    if (cam) out.push(cam);
  }
  return out;
}

export default [{
  id: 'windy-cam', category: 'cameras', kinds: ['camera'], keyless: false,
  label: 'Windy webcams', attribution: 'Windy Webcams',
  enabled: (cfg) => !!cfg.windyKey,
  fetch: (bbox, cfg) => fetchWindy(bbox, cfg),
}];
