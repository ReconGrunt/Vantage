// citizen.js — OPT-IN, DEFAULT OFF. Citizen has no official free API; this hits its
// unofficial incident-search endpoint. Enabled only when VANTAGE_ENABLE_CITIZEN=1.
//
// Guardrails baked in: PLACE/EVENT-CENTRIC ONLY. We surface incident locations +
// titles as aggregate city activity. We never store, surface, or follow any person,
// uploader, or device — only "something is happening here". Degrades to empty on any
// failure (the endpoint is undocumented and can change/vanish without notice).

import { getJson } from '../_http.js';
import { makeEvent, inBbox, numOrNull, kindFromText, sevFromText } from '../types.js';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://citizen.com/',
};

async function fetchCitizen(bbox) {
  const qs = new URLSearchParams();
  // documented unofficial bounding-box form: insideBoundingBox[0..3] = S, W, N, E
  qs.append('insideBoundingBox[0]', String(bbox.minLat));
  qs.append('insideBoundingBox[1]', String(bbox.minLon));
  qs.append('insideBoundingBox[2]', String(bbox.maxLat));
  qs.append('insideBoundingBox[3]', String(bbox.maxLon));
  qs.set('limit', '200');
  const d = await getJson(`https://citizen.com/api/incident/search?${qs.toString()}`, { headers: HDRS });
  const list = d?.results || d?.hits || d?.incidents || [];
  const out = [];
  for (const r of list) {
    const la = numOrNull(r.latitude ?? r.lat ?? r.ll?.[0]);
    const lo = numOrNull(r.longitude ?? r.lng ?? r.lon ?? r.ll?.[1]);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const title = r.title || r.raw || 'Reported incident';
    const ts = Number(r.cs || r.created_at || r.ts) || Date.parse(r.created_at) || Date.now();
    const ev = makeEvent({
      source: 'citizen', nativeId: r.key || r.id || `${la.toFixed(5)},${lo.toFixed(5)}`,
      kind: kindFromText(title), severity: r.severity != null ? r.severity : sevFromText(title),
      lat: la, lon: lo, title, description: r.address || r.neighborhood || '',
      sourceUrl: r.key ? `https://citizen.com/incident/${r.key}` : 'https://citizen.com',
      ts: Number.isFinite(ts) ? ts : Date.now(), raw: null, // raw dropped: never persist app internals
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'citizen', category: 'incidents', kinds: ['police', 'fire', 'medical', 'hazard'], keyless: true,
  optin: true, attribution: 'Citizen (unofficial · place-only)', label: 'Citizen incidents',
  enabled: (cfg) => !!cfg?.enableCitizen,
  fetch: (bbox) => fetchCitizen(bbox).catch(() => []),
}];
