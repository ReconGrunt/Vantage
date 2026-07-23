// airquality.js — EPA AirNow current air-quality observations. Free API key
// (airnowapi.org), so it's OFF until AIRNOW_KEY is set. One "hazard" event at the
// reporting area for the worst pollutant, only when air is actually unhealthy (AQI > 50).

import { getJson } from './_http.js';
import { makeEvent, numOrNull } from './types.js';

const aqiSev = (a) => (a > 200 ? 3 : a > 150 ? 3 : a > 100 ? 2 : a > 50 ? 1 : 0);

async function fetchAirNow(bbox, cfg) {
  const url = `https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json`
    + `&latitude=${bbox.lat}&longitude=${bbox.lon}&distance=75&API_KEY=${encodeURIComponent(cfg.airnowKey)}`;
  const rows = await getJson(url);
  if (!Array.isArray(rows) || !rows.length) return [];
  let worst = null;
  for (const r of rows) if (!worst || (r.AQI ?? -1) > (worst.AQI ?? -1)) worst = r;
  if (!worst || (worst.AQI ?? 0) <= 50) return []; // only surface when air is unhealthy
  const la = numOrNull(worst.Latitude) ?? bbox.lat, lo = numOrNull(worst.Longitude) ?? bbox.lon;
  const cat = worst.Category?.Name || '';
  const ev = makeEvent({
    source: 'airnow', nativeId: `${worst.ReportingArea}:${worst.ParameterName}`,
    kind: 'hazard', severity: aqiSev(worst.AQI), lat: la, lon: lo,
    title: `Air quality: AQI ${worst.AQI} ${cat} (${worst.ParameterName})`,
    description: worst.ReportingArea || '', sourceUrl: 'https://www.airnow.gov',
    ts: Date.parse(`${worst.DateObserved} ${worst.HourObserved || 0}:00`) || Date.now(),
  });
  return ev ? [ev] : [];
}

export default [{
  id: 'airnow', category: 'incidents', kinds: ['hazard'], keyless: false,
  label: 'AirNow air quality', attribution: 'US EPA AirNow',
  enabled: (cfg) => !!cfg.airnowKey,
  fetch: (bbox, cfg) => fetchAirNow(bbox, cfg),
}];
