// socrata.js — one adapter FAMILY covering every Socrata (SODA) open-data feed. Adding
// a city = adding a row to DATASETS, not writing code. These are official municipal
// open-data portals (public-official, keyless; an optional app token just lifts the
// anonymous rate limit). Each row says where the point is, what the call-type field is,
// and how to classify it.
//
// We order by the system field :updated_at DESC (present on every dataset, so a wrong
// per-dataset column name can't 400 us), pull the most-recent N, then bbox-filter in JS.

import { getJson } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, kindFromText, sevFromText, numOrNull } from './types.js';

// Pull a [lat, lon] out of a Socrata row, tolerating the three shapes these feeds use:
// numeric lat/lon columns, a GeoJSON point column, or a {latitude,longitude} location.
function extractLatLon(r, ds) {
  let la = numOrNull(r[ds.latField]), lo = numOrNull(r[ds.lonField]);
  if (la != null && lo != null) return [la, lo];
  for (const f of [ds.pointField, 'point', 'location', 'report_location', 'intersection_point', 'geocoded_column', 'the_geom']) {
    const p = f && r[f];
    if (!p) continue;
    if (Array.isArray(p.coordinates) && p.coordinates.length >= 2) return [numOrNull(p.coordinates[1]), numOrNull(p.coordinates[0])];
    if (p.latitude != null && p.longitude != null) return [numOrNull(p.latitude), numOrNull(p.longitude)];
  }
  return [null, null];
}

async function fetchSocrata(ds, bbox, cfg) {
  if (!bboxIntersects(bbox, ds.region)) return [];
  const params = new URLSearchParams();
  params.set('$limit', String(ds.limit || 400));
  params.set('$order', ':updated_at DESC');
  const headers = cfg?.socrataToken ? { 'X-App-Token': cfg.socrataToken } : {};
  const url = `https://${ds.host}/resource/${ds.dataset}.json?${params.toString()}`;
  const rows = await getJson(url, { headers });
  const out = [];
  for (const r of rows) {
    const [la, lo] = extractLatLon(r, ds);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const typeText = ds.typeField ? (r[ds.typeField] || '') : '';
    const kind = ds.kind || kindFromText(typeText);
    const severity = ds.severity != null ? ds.severity : sevFromText(typeText);
    const ts = ds.tsField ? Date.parse(r[ds.tsField]) : Date.now();
    const nativeId = (ds.idField && r[ds.idField]) || `${la.toFixed(5)},${lo.toFixed(5)}`;
    const ev = makeEvent({
      source: ds.id, nativeId, kind, severity, lat: la, lon: lo,
      title: typeText || ds.label,
      description: r[ds.addrField] || r.address || r.incident_address || r.street_address || '',
      sourceUrl: `https://${ds.host}/resource/${ds.dataset}`,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      raw: r,
    });
    if (ev) out.push(ev);
  }
  return out;
}

// region = a rough city bbox so we never call a city's portal when the observer is
// nowhere near it. kind/severity: omit to classify from the call-type text.
const DATASETS = [
  { id: 'sea-fire-cad', label: 'Seattle Fire/EMS dispatch', host: 'data.seattle.gov', dataset: 'kzjm-xkqj',
    latField: 'latitude', lonField: 'longitude', typeField: 'type', tsField: 'datetime', idField: 'incident_number', addrField: 'address',
    kinds: ['fire', 'medical'], attribution: 'Seattle Fire · data.seattle.gov',
    region: { minLat: 47.4, maxLat: 47.78, minLon: -122.46, maxLon: -122.22 } },

  { id: 'sf-pd-cad', label: 'SF Police dispatch (real-time)', host: 'data.sfgov.org', dataset: 'gnap-fj3t',
    pointField: 'intersection_point', typeField: 'call_type_final_desc', tsField: 'received_datetime', idField: 'cad_number', addrField: 'intersection_name',
    kinds: ['police'], kind: 'police', attribution: 'SFPD · data.sfgov.org',
    region: { minLat: 37.70, maxLat: 37.84, minLon: -122.54, maxLon: -122.34 } },

  { id: 'sf-fire-cad', label: 'SF Fire calls', host: 'data.sfgov.org', dataset: 'nuek-vuh3',
    pointField: 'case_location', typeField: 'call_type', tsField: 'received_dttm', idField: 'call_number', addrField: 'address',
    kinds: ['fire', 'medical'], attribution: 'SF Fire · data.sfgov.org',
    region: { minLat: 37.70, maxLat: 37.84, minLon: -122.54, maxLon: -122.34 } },

  { id: 'chi-311', label: 'Chicago 311 service requests', host: 'data.cityofchicago.org', dataset: 'v6vf-nfxy',
    latField: 'latitude', lonField: 'longitude', typeField: 'sr_type', tsField: 'created_date', idField: 'sr_number', addrField: 'street_address',
    kind: 'civic', severity: 0, kinds: ['civic'], attribution: 'City of Chicago · data.cityofchicago.org',
    region: { minLat: 41.62, maxLat: 42.05, minLon: -87.95, maxLon: -87.52 } },

  { id: 'chi-crime', label: 'Chicago crimes (7-day lag)', host: 'data.cityofchicago.org', dataset: 'ijzp-q8t2',
    latField: 'latitude', lonField: 'longitude', typeField: 'primary_type', tsField: 'date', idField: 'case_number', addrField: 'block',
    kind: 'police', kinds: ['police'], attribution: 'Chicago PD · data.cityofchicago.org',
    region: { minLat: 41.62, maxLat: 42.05, minLon: -87.95, maxLon: -87.52 } },

  { id: 'nyc-311', label: 'NYC 311 service requests', host: 'data.cityofnewyork.us', dataset: 'erm2-nwe9',
    latField: 'latitude', lonField: 'longitude', typeField: 'complaint_type', tsField: 'created_date', idField: 'unique_key', addrField: 'incident_address',
    kind: 'civic', severity: 0, kinds: ['civic'], attribution: 'NYC OpenData · data.cityofnewyork.us',
    region: { minLat: 40.48, maxLat: 40.93, minLon: -74.27, maxLon: -73.68 } },

  { id: 'cin-cad', label: 'Cincinnati PD dispatch', host: 'data.cincinnati-oh.gov', dataset: 'gexm-h6bt',
    latField: 'latitude_x', lonField: 'longitude_x', typeField: 'incident_type_desc', tsField: 'create_time_incident', idField: 'event_number', addrField: 'address_x',
    kinds: ['police'], attribution: 'Cincinnati PD · data.cincinnati-oh.gov',
    region: { minLat: 39.05, maxLat: 39.32, minLon: -84.72, maxLon: -84.25 } },
];

export default DATASETS.map((ds) => ({
  id: ds.id,
  category: 'incidents',
  kinds: ds.kinds || ['civic'],
  keyless: true,
  attribution: ds.attribution,
  label: ds.label,
  enabled: () => true,
  fetch: (bbox, cfg) => fetchSocrata(ds, bbox, cfg).catch(() => []),
}));
