// scanner.js — OPT-IN, DEFAULT OFF. Public-safety RADIO (police/fire/EMS scanner) that
// is broadcast in the clear and legally aggregated by OpenMHz. Enabled only when
// VANTAGE_ENABLE_SCANNER=1 AND systems are configured.
//
// Honest scope note: scanner traffic is AUDIO, and OpenMHz call metadata is not precisely
// geolocated — turning spoken chatter into map pins needs a transcription+geocode pipeline
// (faster-whisper etc.), which is a later component. What this adapter does today is emit
// an AGGREGATE "radio activity" marker at a KNOWN system location you configure, so you can
// see when a system is busy. No audio, no transcript, no persons are stored or mapped.
//
// Config: VANTAGE_SCANNER_SYSTEMS="shortName:lat:lon:Label,shortName2:lat:lon:Label2"
// (find a system's shortName in its openmhz.com URL, e.g. openmhz.com/system/chi -> "chi").

import { getJson } from '../_http.js';
import { makeEvent, inBbox } from '../types.js';

const HDRS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' };

async function fetchSystem(sys, bbox) {
  if (!inBbox(bbox, sys.lat, sys.lon)) return [];
  const d = await getJson(`https://api.openmhz.com/${encodeURIComponent(sys.shortName)}/calls`, { headers: HDRS });
  const calls = d?.calls || [];
  if (!calls.length) return [];
  const recent = calls.filter((c) => (Date.now() - (Date.parse(c.time) || 0)) < 15 * 60_000).length || calls.length;
  const ev = makeEvent({
    source: `scanner:${sys.shortName}`, nativeId: `activity:${sys.shortName}`,
    kind: 'police', severity: recent >= 20 ? 2 : recent >= 5 ? 1 : 0, lat: sys.lat, lon: sys.lon,
    title: `${sys.label}: ${recent} radio calls (15 min)`,
    description: 'Aggregate scanner activity (no audio / no persons).',
    sourceUrl: `https://openmhz.com/system/${sys.shortName}`, ts: Date.now(), raw: null,
  });
  return ev ? [ev] : [];
}

export default [{
  id: 'scanner', category: 'incidents', kinds: ['police'], keyless: true,
  optin: true, attribution: 'OpenMHz scanner (aggregate activity)', label: 'Scanner activity',
  enabled: (cfg) => !!cfg?.enableScanner && (cfg?.scannerSystems?.length > 0),
  fetch: (bbox, cfg) =>
    Promise.all((cfg?.scannerSystems || []).map((s) => fetchSystem(s, bbox).catch(() => []))).then((x) => x.flat()),
}];
