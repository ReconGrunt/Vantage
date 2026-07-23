// iem.js — NWS Local Storm Reports via the Iowa Environmental Mesonet (keyless GeoJSON).
// Ground-truth reports of tornadoes, hail, wind damage, flooding, snow, etc. from the last
// 12 h — a national real-time hazard/weather layer with no key.

import { getJson } from './_http.js';
import { makeEvent, inBbox } from './types.js';

const HAZARDY = /tornado|flood|funnel|water ?spout|surge/i;
function sev(t = '') {
  if (/tornado|flash flood|funnel/i.test(t)) return 3;
  if (/flood|hail|wind|tstm|marine|surge|snow|ice|fire/i.test(t)) return 2;
  return 1;
}

async function fetchIem(bbox) {
  const d = await getJson('https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=12');
  const out = [];
  for (const f of d?.features || []) {
    const c = f.geometry?.coordinates;
    if (!c) continue;
    const lo = +c[0], la = +c[1];
    if (!isFinite(la) || !isFinite(lo) || !inBbox(bbox, la, lo)) continue;
    const p = f.properties || {};
    const type = p.typetext || p.type || 'Storm report';
    const magStr = (p.magf && p.magf !== '0') ? ` ${p.magf}${p.unit ? ' ' + p.unit : ''}` : '';
    const ev = makeEvent({
      source: 'iem-lsr', nativeId: f.id || `${la.toFixed(4)},${lo.toFixed(4)},${p.valid}`,
      kind: HAZARDY.test(type) ? 'hazard' : 'weather', severity: sev(type), lat: la, lon: lo,
      title: `${type}${magStr}`.slice(0, 80),
      description: `${p.city || ''}${p.remark ? ' · ' + p.remark : ''}`.slice(0, 200),
      sourceUrl: 'https://mesonet.agron.iastate.edu/lsr/', ts: Date.parse(p.valid) || Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'iem-lsr', category: 'incidents', kinds: ['weather', 'hazard'], keyless: true,
  label: 'NWS storm reports (IEM)', attribution: 'Iowa Environmental Mesonet · NWS',
  enabled: () => true,
  fetch: (b) => fetchIem(b).catch(() => []),
}];
