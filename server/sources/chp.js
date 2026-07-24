// chp.js — California Highway Patrol live traffic incidents (CHP CAD).
//
// This is the ONLY genuinely real-time public dispatch feed for the LA area (the LAPD
// calls dataset lags ~5-7 days). It is not a JSON/SOAP API — cad.chp.ca.gov is an old
// ASP.NET WebForms page — so we drive it the way a browser does:
//   1. GET  Traffic.aspx      -> harvest __VIEWSTATE / __VIEWSTATEGENERATOR + session cookies
//   2. POST ddlComCenter=LACC -> the Los Angeles Communications Center incident table
//   3. parse the gvIncidents HTML table.
//
// COORDINATES: the incident list carries none (exact lat/lon exists only behind a separate
// per-incident postback — ~30 serial requests per refresh, which would blow the fan-out
// timeout and hammer CHP's F5 firewall). Each incident does carry its dispatching CHP
// "Area" office, so — exactly as with LAPD divisions — we place it at that office's
// centroid. That is the precision the fast path honestly has; anything finer is invented.

import { makeEvent, inBbox, bboxIntersects, kindFromText, sevFromText } from './types.js';

const CAD_URL = 'https://cad.chp.ca.gov/Traffic.aspx';
const CENTER = 'LACC'; // Los Angeles Communications Center
const LA_REGION = { minLat: 33.68, maxLat: 34.82, minLon: -118.95, maxLon: -117.6 };

// F5/ASP.NET reject blank/odd UAs; a normal browser UA is what the site expects.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// The 10 CHP Area offices dispatched by LACC (+ the Castaic inspection facility), keyed by
// the exact "Area" string the CAD table prints. Coordinates are the geocoded office
// addresses (street-level), which beats an area-polygon centroid for placement.
const AREAS = {
  'central la': [34.0345, -118.2722],
  'east la': [34.0243, -118.1327],
  'south la': [33.8430, -118.2792],
  'west la': [33.9868, -118.3872],
  'altadena': [34.1878, -118.1465],
  'baldwin park': [34.0645, -117.9730],
  'santa fe springs': [33.9445, -118.0648],
  'west valley': [34.1815, -118.5885],
  'newhall': [34.4128, -118.5670],
  'antelope valley': [34.6890, -118.1640],
  'castaic': [34.4361, -118.5936],
};

function cookiesFrom(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return all.map((c) => c.split(';')[0]).join('; ');
}

function hidden(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`, 'i'));
  return m ? m[1] : '';
}

function parseRows(html) {
  const start = html.indexOf('id="gvIncidents"');
  if (start < 0) return [];
  const tbl = html.slice(start, html.indexOf('</table>', start));
  const rows = [];
  for (const rowM of tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowM[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length >= 6) rows.push(cells); // [Details, No., Time, Type, Location, LocDesc, Area]
  }
  return rows;
}

async function fetchChp(bbox) {
  if (!bboxIntersects(bbox, LA_REGION)) return [];
  const g = await fetch(CAD_URL, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(8000),
  });
  if (!g.ok) throw new Error(`${g.status} for CHP CAD page`);
  const gHtml = await g.text();
  const vs = hidden(gHtml, '__VIEWSTATE');
  const vsg = hidden(gHtml, '__VIEWSTATEGENERATOR');
  if (!vs) throw new Error('CHP CAD: no __VIEWSTATE (page shape changed)');
  const cookie = cookiesFrom(g);

  const body = new URLSearchParams({
    __EVENTTARGET: 'ddlComCenter', __EVENTARGUMENT: '',
    __VIEWSTATE: vs, __VIEWSTATEGENERATOR: vsg, ddlComCenter: CENTER,
  });
  const p = await fetch(CAD_URL, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA, Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie, Referer: CAD_URL,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(8000),
  });
  if (!p.ok) throw new Error(`${p.status} for CHP CAD ${CENTER}`);
  const rows = parseRows(await p.text());

  const out = [];
  for (const [, no, time, type, loc, locDesc, area] of rows) {
    const at = AREAS[String(area || '').trim().toLowerCase()];
    if (!at) continue;               // area we don't have a centroid for -> no location
    const [la, lo] = at;
    if (!inBbox(bbox, la, lo)) continue;
    const title = type || 'CHP incident';
    const where = [loc, locDesc].map((s) => (s || '').trim()).filter(Boolean).join(' · ');
    const ev = makeEvent({
      source: 'chp-cad', nativeId: no || `${area}:${time}:${title}`,
      kind: kindFromText(title) === 'civic' ? 'traffic' : kindFromText(title),
      severity: sevFromText(title),
      lat: la, lon: lo,
      title,
      description: `${where ? where + ' — ' : ''}CHP ${area} area${time ? `, reported ${time}` : ''} (area-level location)`,
      sourceUrl: 'https://cad.chp.ca.gov/Traffic.aspx',
      ts: Date.now(),   // CAD lists only ACTIVE incidents; treat as happening-now
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'chp-cad', category: 'incidents', kinds: ['traffic', 'hazard', 'police', 'medical'],
  keyless: true,
  label: 'CHP traffic incidents (live)', attribution: 'California Highway Patrol · cad.chp.ca.gov',
  enabled: () => true,
  fetch: (bbox) => fetchChp(bbox),
}];
