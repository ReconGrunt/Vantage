// arcgis.js — one adapter FAMILY for Esri ArcGIS REST FeatureServer/MapServer layers
// (the other backbone of US municipal open data). Queries the layer as GeoJSON with an
// envelope filter so the server only returns features near the observer. Handles both
// incident layers (DC MPD) and camera layers.

import { getJson } from './_http.js';
import { makeEvent, makeCamera, inBbox, bboxIntersects, kindFromText, sevFromText, numOrNull } from './types.js';

function centroid(geom) {
  if (!geom) return [null, null];
  if (geom.type === 'Point') return [numOrNull(geom.coordinates?.[1]), numOrNull(geom.coordinates?.[0])];
  const ring = geom.type === 'Polygon' ? geom.coordinates?.[0]
    : geom.type === 'MultiPolygon' ? geom.coordinates?.[0]?.[0]
    : geom.type === 'LineString' ? geom.coordinates : null;
  if (Array.isArray(ring) && ring.length) {
    let sx = 0, sy = 0;
    for (const c of ring) { sx += c[0]; sy += c[1]; }
    return [sy / ring.length, sx / ring.length];
  }
  return [null, null];
}

async function fetchArcgis(ds, bbox) {
  if (!bboxIntersects(bbox, ds.region)) return [];
  const params = new URLSearchParams({
    f: 'geojson', where: ds.where || '1=1', outFields: '*',
    geometry: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', resultRecordCount: String(ds.limit || 1000),
  });
  const fc = await getJson(`${ds.url}/query?${params.toString()}`);
  const out = [];
  for (const ft of fc?.features || []) {
    const [la, lo] = centroid(ft.geometry);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const p = ft.properties || {};
    if (ds.category === 'cameras') {
      const cam = makeCamera({
        provider: ds.id, nativeId: (ds.idField && p[ds.idField]) || `${la.toFixed(5)},${lo.toFixed(5)}`,
        name: ds.nameFn ? ds.nameFn(p) : (p.name || p.Name || ds.label), lat: la, lon: lo,
        still: ds.stillFn ? ds.stillFn(p) : null, stream: ds.streamFn ? ds.streamFn(p) : null,
        proxied: true,   // all camera images go through /api/camimg — see caltrans.js
      });
      if (cam) out.push(cam);
    } else {
      const typeText = ds.typeField ? (p[ds.typeField] || '') : '';
      const ts = ds.tsField ? Date.parse(p[ds.tsField]) : Date.now();
      const ev = makeEvent({
        source: ds.id, nativeId: (ds.idField && p[ds.idField]) || `${la.toFixed(5)},${lo.toFixed(5)}`,
        kind: ds.kind || kindFromText(typeText),
        severity: ds.severity != null ? ds.severity : sevFromText(typeText),
        lat: la, lon: lo, title: typeText || ds.label,
        description: ds.descFn ? ds.descFn(p) : (p.BLOCK || p.block || p.address || ''),
        sourceUrl: ds.url, ts: Number.isFinite(ts) ? ts : Date.now(), raw: p,
      });
      if (ev) out.push(ev);
    }
  }
  return out;
}

const LAYERS = [
  { id: 'dc-mpd', category: 'incidents', label: 'DC Police incidents', kinds: ['police'], kind: 'police',
    url: 'https://maps2.dcgis.dc.gov/dcgis/rest/services/FEEDS/MPD/FeatureServer/39',
    typeField: 'OFFENSE', tsField: 'REPORT_DAT', idField: 'CCN', descFn: (p) => p.BLOCK || '',
    attribution: 'DC Metropolitan Police · dcgis.dc.gov',
    region: { minLat: 38.79, maxLat: 39.00, minLon: -77.12, maxLon: -76.90 } },

  { id: 'fl511-cam', category: 'cameras', label: 'Florida DOT cameras', kinds: ['camera'],
    url: 'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0',
    idField: 'ID', nameFn: (p) => p.DESCRIPT || 'FDOT camera', stillFn: (p) => p.IMAGE || null,
    attribution: 'Florida DOT · FL511',
    region: { minLat: 24.4, maxLat: 31.1, minLon: -87.7, maxLon: -79.8 } },
];

export default LAYERS.map((ds) => ({
  id: ds.id, category: ds.category, kinds: ds.kinds || ['civic'], keyless: true,
  attribution: ds.attribution, label: ds.label,
  enabled: () => true,
  fetch: (bbox) => fetchArcgis(ds, bbox),
}));
