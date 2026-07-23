// firms.js — NASA FIRMS active wildfire thermal detections (VIIRS S-NPP, near-real-time).
// Free MAP_KEY (firms.modaps.eosdis.nasa.gov), so OFF until FIRMS_MAP_KEY is set. The area
// CSV endpoint takes a bbox and a day count; we take the last 1 day within the observer box.

import { getText } from './_http.js';
import { makeEvent, inBbox } from './types.js';

async function fetchFirms(bbox, cfg) {
  const area = `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(cfg.firmsKey)}/VIIRS_SNPP_NRT/${area}/1`;
  const txt = await getText(url);
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const hdr = lines[0].split(',');
  const iLat = hdr.indexOf('latitude'), iLon = hdr.indexOf('longitude'), iFrp = hdr.indexOf('frp');
  const iDate = hdr.indexOf('acq_date'), iTime = hdr.indexOf('acq_time'), iConf = hdr.indexOf('confidence');
  if (iLat < 0 || iLon < 0) return [];
  const out = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const la = +c[iLat], lo = +c[iLon];
    if (!isFinite(la) || !isFinite(lo) || !inBbox(bbox, la, lo)) continue;
    const frp = +c[iFrp] || 0;
    const sev = frp > 50 ? 3 : frp > 20 ? 2 : 1;
    const t = (c[iTime] || '0000').padStart(4, '0');
    const ts = Date.parse(`${c[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z`) || Date.now();
    const ev = makeEvent({
      source: 'firms', nativeId: `${la.toFixed(4)},${lo.toFixed(4)},${c[iDate]}${t}`,
      kind: 'fire-wildland', severity: sev, lat: la, lon: lo,
      title: `Wildfire hotspot (FRP ${frp})`,
      description: `VIIRS thermal detection · confidence ${c[iConf] || '?'}`,
      sourceUrl: 'https://firms.modaps.eosdis.nasa.gov', ts,
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'firms', category: 'incidents', kinds: ['fire-wildland'], keyless: false,
  label: 'NASA FIRMS wildfire', attribution: 'NASA FIRMS (VIIRS S-NPP)',
  enabled: (cfg) => !!cfg.firmsKey,
  fetch: (bbox, cfg) => fetchFirms(bbox, cfg),
}];
