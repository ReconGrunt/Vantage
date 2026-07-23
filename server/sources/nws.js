// nws.js — US National Weather Service active alerts (watches / warnings / advisories).
// Free, no key; api.weather.gov only requires a descriptive User-Agent (we send one).
// /alerts/active?point=lat,lon returns everything currently in effect over the observer.

import { getJson } from './_http.js';
import { makeEvent, numOrNull } from './types.js';

const CAP_SEV = { Extreme: 3, Severe: 2, Moderate: 1, Minor: 0, Unknown: 0 };

function polyCentroid(geom) {
  if (!geom) return [null, null];
  if (geom.type === 'Point') return [numOrNull(geom.coordinates?.[1]), numOrNull(geom.coordinates?.[0])];
  const ring = geom.type === 'Polygon' ? geom.coordinates?.[0]
    : geom.type === 'MultiPolygon' ? geom.coordinates?.[0]?.[0] : null;
  if (Array.isArray(ring) && ring.length) {
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    return [sy / ring.length, sx / ring.length];
  }
  return [null, null];
}

async function fetchNws(bbox) {
  const url = `https://api.weather.gov/alerts/active?point=${bbox.lat.toFixed(4)},${bbox.lon.toFixed(4)}`;
  const d = await getJson(url, { headers: { Accept: 'application/geo+json' } });
  const out = [];
  for (const f of d?.features || []) {
    const p = f.properties || {};
    let [la, lo] = polyCentroid(f.geometry);
    // Many alerts are zone-based with null geometry — pin the area-wide alert at the
    // observer (honest: it covers the whole zone, not a precise point).
    if (la == null) { la = bbox.lat; lo = bbox.lon; }
    const evName = p.event || 'Weather alert';
    const kind = /flood|marine|rip current|tsunami|coastal|surge/i.test(evName) ? 'hazard' : 'weather';
    const ev = makeEvent({
      source: 'nws-alerts', nativeId: p.id || f.id, kind,
      severity: CAP_SEV[p.severity] ?? 1,
      lat: la, lon: lo, title: evName, description: p.headline || p.areaDesc || '',
      sourceUrl: p.uri || p['@id'] || 'https://www.weather.gov',
      ts: Date.parse(p.sent || p.effective), expiresTs: Date.parse(p.expires) || null, raw: p,
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'nws-alerts', category: 'incidents', kinds: ['weather', 'hazard'], keyless: true,
  attribution: 'US National Weather Service · api.weather.gov', label: 'NWS active alerts',
  enabled: () => true,
  fetch: (bbox) => fetchNws(bbox).catch(() => []),
}];
