// eonet.js — NASA EONET open natural events (keyless): wildfires, severe storms, volcanoes,
// floods, landslides, etc., worldwide. Global context layer; bbox-filtered to the observer.

import { getJson } from './_http.js';
import { makeEvent, inBbox } from './types.js';

const CAT = {
  wildfires: 'fire-wildland', severeStorms: 'weather', volcanoes: 'hazard', floods: 'hazard',
  landslides: 'hazard', earthquakes: 'quake', drought: 'hazard', dustHaze: 'hazard',
  snow: 'weather', seaLakeIce: 'hazard', manmade: 'hazard', waterColor: 'hazard', tempExtremes: 'weather',
};

async function fetchEonet(bbox) {
  const d = await getJson('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10&limit=200');
  const out = [];
  for (const e of d?.events || []) {
    if (e.closed) continue;
    const g = (e.geometry || []).slice(-1)[0]; // most recent geometry point
    if (!g) continue;
    let la, lo;
    if (g.type === 'Point') { lo = +g.coordinates[0]; la = +g.coordinates[1]; }
    else if (Array.isArray(g.coordinates)) { const flat = g.coordinates.flat(Infinity); lo = +flat[0]; la = +flat[1]; }
    if (!isFinite(la) || !isFinite(lo) || !inBbox(bbox, la, lo)) continue;
    const catId = e.categories?.[0]?.id || '';
    const kind = CAT[catId] || 'hazard';
    const ev = makeEvent({
      source: 'eonet', nativeId: e.id, kind, severity: kind === 'fire-wildland' ? 2 : 1, lat: la, lon: lo,
      title: e.title, description: e.categories?.[0]?.title || '',
      sourceUrl: e.link || e.sources?.[0]?.url, ts: Date.parse(g.date) || Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'eonet', category: 'incidents', kinds: ['fire-wildland', 'hazard', 'weather'], keyless: true,
  label: 'NASA EONET natural events', attribution: 'NASA EONET',
  enabled: () => true,
  fetch: (b) => fetchEonet(b).catch(() => []),
}];
