// wsdot.js — Washington State DOT traveler info: highway cameras + traffic alerts.
// Free AccessCode (wsdot.wa.gov, issued by email), so OFF until WSDOT_KEY is set.
// Region-gated to Washington so it never runs for other states. Pairs with Seattle
// Fire CAD to give the Puget Sound a fuller ground picture.

import { getJson } from './_http.js';
import { makeCamera, makeEvent, inBbox, bboxIntersects, numOrNull } from './types.js';

const WA = { minLat: 45.5, maxLat: 49.1, minLon: -124.9, maxLon: -116.9 };

async function cameras(bbox, cfg) {
  if (!bboxIntersects(bbox, WA)) return [];
  const d = await getJson(`https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode=${encodeURIComponent(cfg.wsdotKey)}`);
  const out = [];
  for (const c of (Array.isArray(d) ? d : [])) {
    const la = numOrNull(c.CameraLocation?.Latitude), lo = numOrNull(c.CameraLocation?.Longitude);
    if (la == null || lo == null || !inBbox(bbox, la, lo) || !c.ImageURL) continue;
    const cam = makeCamera({
      provider: 'wsdot', nativeId: c.CameraID, name: c.Title || c.CameraLocation?.Description || 'WSDOT camera',
      lat: la, lon: lo, still: c.ImageURL, proxied: true,
    });
    if (cam) out.push(cam);
  }
  return out;
}

async function alerts(bbox, cfg) {
  if (!bboxIntersects(bbox, WA)) return [];
  const d = await getJson(`https://www.wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode=${encodeURIComponent(cfg.wsdotKey)}`);
  const sev = (p = '') => (/highest/i.test(p) ? 3 : /high/i.test(p) ? 2 : /medium/i.test(p) ? 1 : 1);
  const out = [];
  for (const a of (Array.isArray(d) ? d : [])) {
    const la = numOrNull(a.StartRoadwayLocation?.Latitude), lo = numOrNull(a.StartRoadwayLocation?.Longitude);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const ev = makeEvent({
      source: 'wsdot-alerts', nativeId: a.AlertID, kind: 'traffic', severity: sev(a.Priority),
      lat: la, lon: lo, title: a.HeadlineDescription || a.EventCategory || 'Traffic alert',
      description: a.EventCategory || '', sourceUrl: 'https://wsdot.com/travel/real-time', ts: Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [
  { id: 'wsdot-cam', category: 'cameras', kinds: ['camera'], keyless: false, label: 'WSDOT cameras (WA)', attribution: 'WSDOT', enabled: (cfg) => !!cfg.wsdotKey, fetch: (b, c) => cameras(b, c).catch(() => []) },
  { id: 'wsdot-alerts', category: 'incidents', kinds: ['traffic'], keyless: false, label: 'WSDOT traffic alerts (WA)', attribution: 'WSDOT', enabled: (cfg) => !!cfg.wsdotKey, fetch: (b, c) => alerts(b, c).catch(() => []) },
];
