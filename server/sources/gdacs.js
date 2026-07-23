// gdacs.js — GDACS (Global Disaster Alert and Coordination System, UN/EC), keyless GeoJSON.
// Earthquakes, tropical cyclones, floods, volcanoes, droughts, wildfires with a Green/
// Orange/Red alert level. Global; bbox-filtered so only nearby disasters surface.

import { getJson } from './_http.js';
import { makeEvent, inBbox } from './types.js';

const LEVEL = { Red: 3, Orange: 2, Green: 1 };
const ETYPE = { EQ: 'quake', TC: 'weather', FL: 'hazard', VO: 'hazard', DR: 'hazard', WF: 'fire-wildland', TS: 'hazard' };

async function fetchGdacs(bbox) {
  const d = await getJson('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP');
  const out = [];
  for (const f of d?.features || []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const lo = +c[0], la = +c[1];
    if (!isFinite(la) || !isFinite(lo) || !inBbox(bbox, la, lo)) continue;
    const p = f.properties || {};
    const url = p.url && typeof p.url === 'object' ? (p.url.report || p.url.details || null) : (p.url || null);
    const ev = makeEvent({
      source: 'gdacs', nativeId: `${p.eventtype}${p.eventid}`, kind: ETYPE[p.eventtype] || 'hazard',
      severity: LEVEL[p.alertlevel] || 1, lat: la, lon: lo,
      title: p.eventname || p.name || `${p.eventtype} disaster`,
      description: (p.description || '').slice(0, 200), sourceUrl: url || 'https://www.gdacs.org',
      ts: Date.parse(p.fromdate || p.datemodified) || Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'gdacs', category: 'incidents', kinds: ['hazard', 'quake', 'weather'], keyless: true,
  label: 'GDACS global disasters', attribution: 'GDACS · UN/EC',
  enabled: () => true,
  fetch: (b) => fetchGdacs(b).catch(() => []),
}];
