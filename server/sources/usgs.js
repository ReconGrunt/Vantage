// usgs.js — USGS hazard feeds, both free / no key / already-GeoJSON.
//   · Earthquakes: the canonical all_day summary feed (global last 24 h), bbox-filtered.
//   · Elevated volcanoes: the HANS public API (only volcanoes above normal alert level).

import { getJson } from './_http.js';
import { makeEvent, inBbox, numOrNull } from './types.js';

async function fetchQuakes(bbox) {
  const d = await getJson('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson');
  const out = [];
  for (const f of d?.features || []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const lo = numOrNull(c[0]), la = numOrNull(c[1]);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const m = f.properties?.mag ?? 0;
    const sev = m >= 5 ? 3 : m >= 4 ? 2 : m >= 2.5 ? 1 : 0;
    const ev = makeEvent({
      source: 'usgs-quake', nativeId: f.id, kind: 'quake', severity: sev, lat: la, lon: lo,
      title: `M${Number(m).toFixed(1)} earthquake`, description: f.properties?.place || '',
      sourceUrl: f.properties?.url, ts: f.properties?.time, raw: f.properties,
    });
    if (ev) out.push(ev);
  }
  return out;
}

const VOLC_SEV = { WARNING: 3, WATCH: 2, ADVISORY: 1, NORMAL: 0 };
async function fetchVolcano(bbox) {
  const d = await getJson('https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes');
  const list = Array.isArray(d) ? d : (d?.features || d?.data || []);
  const out = [];
  for (const v of list) {
    const la = numOrNull(v.latitude ?? v.lat), lo = numOrNull(v.longitude ?? v.lon);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const lvl = String(v.alertLevel || v.alert_level || '').toUpperCase();
    const ev = makeEvent({
      source: 'usgs-volcano', nativeId: v.volcanoName || v.vnum || `${la},${lo}`, kind: 'hazard',
      severity: VOLC_SEV[lvl] ?? 1, lat: la, lon: lo,
      title: `Volcano ${lvl || 'elevated'}: ${v.volcanoName || ''}`.trim(),
      description: `Color code ${v.colorCode || v.color_code || '—'}`,
      sourceUrl: v.url || 'https://volcanoes.usgs.gov', ts: Date.parse(v.sentUtc || v.sent) || Date.now(), raw: v,
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [
  { id: 'usgs-quake', category: 'incidents', kinds: ['quake'], keyless: true,
    attribution: 'USGS Earthquake Hazards Program', label: 'USGS earthquakes',
    enabled: () => true, fetch: (bbox) => fetchQuakes(bbox).catch(() => []) },
  { id: 'usgs-volcano', category: 'incidents', kinds: ['hazard'], keyless: true,
    attribution: 'USGS Volcano Hazards Program', label: 'USGS volcano alerts',
    enabled: () => true, fetch: (bbox) => fetchVolcano(bbox).catch(() => []) },
];
