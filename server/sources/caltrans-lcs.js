// caltrans-lcs.js — Caltrans Lane Closure System: REAL-TIME road closures/incidents.
// Free, no key, official ("no charge for use of this data"). This is the backbone of live
// ground activity for California metros — including Los Angeles, which publishes no
// real-time police/fire dispatch feed at all.
//
// Two things make this usable:
//
// 1. ACTIVE-NOW FILTERING. The feed is mostly *scheduled* work: D07 (LA) alone carries
//    ~4,800 records, most of them future. There is no status field — a closure is live
//    only when closureStartEpoch <= now <= closureEndEpoch (or the end is indefinite).
//    Without this the map would drown in closures that haven't happened yet.
//
// 2. NON-BLOCKING WARM CACHE. The D07 payload is ~14 MB. Fetching that on the request
//    path would blow the registry's 9 s adapter wall and stall every city poll. Instead a
//    stale district triggers a BACKGROUND refresh and we immediately serve the last known
//    set — so the request path is always fast and the raw payload never reaches a client.

import { getJson } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, numOrNull } from './types.js';

const DISTRICTS = [
  { d: 3, region: { minLat: 38.2, maxLat: 39.6, minLon: -122.1, maxLon: -119.9 } },
  { d: 4, region: { minLat: 36.9, maxLat: 38.6, minLon: -123.2, maxLon: -121.2 } },
  { d: 7, region: { minLat: 33.6, maxLat: 34.9, minLon: -119.7, maxLon: -117.6 } }, // LA / Ventura
  { d: 8, region: { minLat: 33.4, maxLat: 35.5, minLon: -117.8, maxLon: -114.4 } },
  { d: 11, region: { minLat: 32.5, maxLat: 33.5, minLon: -117.7, maxLon: -114.5 } },
  { d: 12, region: { minLat: 33.4, maxLat: 33.98, minLon: -118.2, maxLon: -117.4 } },
];

const CACHE_MS = 60_000;          // closures change on the order of minutes
const _cache = new Map();         // district -> { at, events }
const _inflight = new Map();      // district -> Promise (dedupes concurrent refreshes)

const STANDING_MS = 7 * 24 * 60 * 60_000; // active > 7 days = a standing condition, not news

function severityOf(c, startEpoch, nowSec) {
  // A closure that has been in effect for weeks (permanent hwy closures, long bridge
  // works) is a STANDING CONDITION, not an incident. Left at full severity it dominates
  // the severity-sorted list — real LA data had 4-year-old "Landscape Work" full closures
  // outranking message-sign alerts from seconds ago. Keep them on the map, rank them low.
  if (Number.isFinite(startEpoch) && (nowSec - startEpoch) * 1000 > STANDING_MS) return 1;
  const t = c.typeOfClosure || '';
  if (t === 'Full') return 3;
  if (t === 'One-Way Traffic' || t === 'Traffic Break') return 2;
  const closed = parseInt(c.lanesClosed, 10);
  const total = parseInt(c.totalExistingLanes, 10);
  if (Number.isFinite(closed) && Number.isFinite(total) && total > 0 && closed / total >= 0.5) return 2;
  return 1;
}

function activeNow(c, nowSec) {
  const ts = c.closureTimestamp || {};
  const start = parseInt(ts.closureStartEpoch, 10);
  if (!Number.isFinite(start) || nowSec < start) return false;
  if (ts.isClosureEndIndefinite === 'true') return true;
  const end = parseInt(ts.closureEndEpoch, 10);
  return !Number.isFinite(end) || nowSec <= end;
}

async function loadDistrict(d) {
  const url = `https://cwwp2.dot.ca.gov/data/d${d}/lcs/lcsStatusD${String(d).padStart(2, '0')}.json`;
  const raw = await getJson(url, { timeout: 25_000 });
  const nowSec = Math.floor(Date.now() / 1000);
  const events = [];
  for (const rec of raw?.data || []) {
    const l = rec?.lcs;
    if (!l) continue;
    const c = l.closure || {};
    if (!activeNow(c, nowSec)) continue;
    const b = l.location?.begin || {};
    const la = numOrNull(b.beginLatitude), lo = numOrNull(b.beginLongitude);
    if (la == null || lo == null) continue;
    const work = c.typeOfWork && c.typeOfWork !== 'Not Reported' ? c.typeOfWork : 'closure';
    const where = [b.beginRoute, b.beginLocationName, b.beginNearbyPlace].filter((x) => x && x !== 'Not Reported').join(' · ');
    const delay = c.estimatedDelay && c.estimatedDelay !== 'Not Reported' ? ` · delay ${c.estimatedDelay}` : '';
    const startEpoch = parseInt(c.closureTimestamp?.closureStartEpoch, 10);
    const endEpoch = parseInt(c.closureTimestamp?.closureEndEpoch, 10);
    const ev = makeEvent({
      source: 'caltrans-lcs',
      nativeId: `${c.closureID || l.index}-${c.logNumber || ''}`,
      kind: 'traffic', severity: severityOf(c, startEpoch, nowSec), lat: la, lon: lo,
      title: `${c.typeOfClosure || 'Lane'} closure — ${work}`,
      description: where + delay,
      sourceUrl: 'https://quickmap.dot.ca.gov',
      ts: (Number.isFinite(startEpoch) ? startEpoch : nowSec) * 1000,
      expiresTs: Number.isFinite(endEpoch) ? endEpoch * 1000 : null,
    });
    if (ev) events.push(ev);
  }
  return events;
}

// Never blocks: returns last-known immediately and refreshes in the background.
function districtEvents(d) {
  const hit = _cache.get(d);
  const stale = !hit || Date.now() - hit.at > CACHE_MS;
  if (stale && !_inflight.has(d)) {
    const p = loadDistrict(d)
      .then((events) => { _cache.set(d, { at: Date.now(), events }); })
      .catch(() => { /* keep last-known; the next poll retries */ })
      .finally(() => { _inflight.delete(d); });
    _inflight.set(d, p);
  }
  return hit ? hit.events : [];
}

export default [{
  id: 'caltrans-lcs', category: 'incidents', kinds: ['traffic'], keyless: true,
  label: 'Caltrans lane closures (live)', attribution: 'Caltrans CWWP2 (no charge)',
  enabled: () => true,
  fetch: async (bbox) => {
    const near = DISTRICTS.filter((x) => bboxIntersects(bbox, x.region));
    if (!near.length) return [];
    return near.flatMap((x) => districtEvents(x.d)).filter((e) => inBbox(bbox, e.lat, e.lon));
  },
}];
