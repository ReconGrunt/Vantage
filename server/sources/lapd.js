// lapd.js — LAPD Calls for Service (data.lacity.org, Socrata `xjgu-z4ju`).
//
// This is the closest thing LA publishes to police dispatch. Two honest caveats baked in:
//
//  1. LAG. Rows land roughly 5-7 days behind (verified: newest dispatch_date was 5 days
//     old). It is NOT real-time, so it is reported with lag:'batch' and the standing-
//     condition severity rules keep it out of the "happening now" ranking.
//  2. NO COORDINATES. The dataset has no lat/lon at all — only `area_occ`, the LAPD
//     geographic division ("Devonshire", "Van Nuys", "77th Street"...). We therefore place
//     each call at its DIVISION centroid, which is genuinely all the precision the data
//     carries. Placing it anywhere more specific would be inventing accuracy.
//
// Division-level placement is exactly why the per-division accounts people follow
// (Devonshire, Valley, etc.) map cleanly onto this feed.

import { getJson } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, kindFromText, sevFromText } from './types.js';

const LA_REGION = { minLat: 33.68, maxLat: 34.35, minLon: -118.68, maxLon: -118.15 };

// The 21 LAPD geographic divisions, at their station houses. "Outside" (calls beyond LAPD
// jurisdiction) is deliberately dropped — it has no meaningful location.
export const DIVISIONS = {
  'central': [34.0444, -118.2456],
  'rampart': [34.0629, -118.2755],
  'southwest': [34.0181, -118.3081],
  'hollenbeck': [34.0441, -118.2078],
  'harbor': [33.7712, -118.2865],
  'hollywood': [34.0956, -118.3300],
  'wilshire': [34.0464, -118.3440],
  'west la': [34.0451, -118.4453],
  'van nuys': [34.1866, -118.4487],
  'west valley': [34.2011, -118.5407],
  'northeast': [34.1122, -118.2093],
  '77th street': [33.9700, -118.2784],
  'newton': [34.0107, -118.2586],
  'pacific': [33.9910, -118.4193],
  'n hollywood': [34.1716, -118.3800],
  'foothill': [34.2551, -118.4136],
  'devonshire': [34.2570, -118.5340],
  'southeast': [33.9382, -118.2748],
  'mission': [34.2726, -118.4690],
  'olympic': [34.0552, -118.2919],
  'topanga': [34.2013, -118.6015],
};

// Radio/call codes that read as noise on a city map — traffic stops and routine checks
// dominate the feed and would bury anything meaningful.
const NOISE = /traffic stop|code 6|code six|follow[- ]?up|premise check|report only/i;

async function fetchLapdCalls(bbox, cfg) {
  if (!bboxIntersects(bbox, LA_REGION)) return [];
  const headers = cfg?.socrataToken ? { 'X-App-Token': cfg.socrataToken } : {};
  const url = 'https://data.lacity.org/resource/xjgu-z4ju.json'
    + '?$limit=400&$order=dispatch_date%20DESC,dispatch_time%20DESC';
  const rows = await getJson(url, { headers });
  const out = [];
  for (const r of rows) {
    const area = String(r.area_occ || '').trim().toLowerCase();
    const at = DIVISIONS[area];
    if (!at) continue;                       // "Outside" / unknown division -> no location
    const [la, lo] = at;
    if (!inBbox(bbox, la, lo)) continue;
    const call = String(r.call_type_text || '').trim();
    if (!call || NOISE.test(call)) continue;
    // dispatch_date is a date; dispatch_time is HH:MM:SS on that date
    const ts = Date.parse(`${String(r.dispatch_date || '').slice(0, 10)}T${r.dispatch_time || '00:00:00'}Z`);
    const ev = makeEvent({
      source: 'lapd-calls', nativeId: r.incident_number || `${area}:${r.dispatch_date}:${r.dispatch_time}`,
      kind: kindFromText(call) === 'civic' ? 'police' : kindFromText(call),
      severity: sevFromText(call),
      lat: la, lon: lo,
      title: call,
      description: `LAPD ${r.area_occ} Division (division-level location)`,
      sourceUrl: 'https://data.lacity.org/resource/xjgu-z4ju',
      ts: Number.isFinite(ts) ? ts : Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'lapd-calls', category: 'incidents', kinds: ['police', 'fire', 'medical', 'traffic'],
  keyless: true, lag: 'batch',
  label: 'LAPD calls for service (~5d lag)', attribution: 'LAPD · data.lacity.org',
  enabled: () => true,
  fetch: (bbox, cfg) => fetchLapdCalls(bbox, cfg),
}];
