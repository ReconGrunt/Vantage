// nwps.js — NOAA/NWS National Water Prediction Service river & tide gauges (keyless).
// We request gauges in the observer's bbox and surface only those at or above "action"
// stage — i.e. actual flooding — as hazard events. Quiet when nothing is flooding.

import { getJson } from './_http.js';
import { makeEvent, numOrNull } from './types.js';

const FLOOD_SEV = { major: 3, moderate: 3, minor: 2, action: 1 };

async function fetchNwps(bbox) {
  const url = `https://api.water.noaa.gov/nwps/v1/gauges`
    + `?bbox.xmin=${bbox.minLon}&bbox.ymin=${bbox.minLat}&bbox.xmax=${bbox.maxLon}&bbox.ymax=${bbox.maxLat}&srid=EPSG_4326`;
  const d = await getJson(url);
  const out = [];
  for (const g of d?.gauges || []) {
    const la = numOrNull(g.latitude), lo = numOrNull(g.longitude);
    if (la == null || lo == null) continue;
    const cat = String(g.status?.observed?.floodCategory || '').toLowerCase();
    const sev = FLOOD_SEV[cat];
    if (!sev) continue; // no flooding / no data → skip
    const ev = makeEvent({
      source: 'nwps', nativeId: g.lid, kind: 'hazard', severity: sev, lat: la, lon: lo,
      title: `Flooding (${cat}) — ${g.name || g.lid}`, description: `Gauge ${g.lid}`,
      sourceUrl: `https://water.noaa.gov/gauges/${g.lid}`, ts: Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'nwps', category: 'incidents', kinds: ['hazard'], keyless: true,
  label: 'NWPS flood gauges', attribution: 'NOAA/NWS NWPS',
  enabled: () => true,
  fetch: (b) => fetchNwps(b),
}];
