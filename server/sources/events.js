// events.js — Ticketmaster Discovery public events near the observer (concerts, sports,
// arts). Free API key (developer.ticketmaster.com), so OFF until TICKETMASTER_KEY is set.
// These are scheduled civic gatherings (severity 0) — useful crowd/context, not alerts.

import { getJson } from './_http.js';
import { makeEvent, numOrNull } from './types.js';

async function fetchTm(bbox, cfg) {
  const url = `https://app.ticketmaster.com/discovery/v2/events.json`
    + `?apikey=${encodeURIComponent(cfg.ticketmasterKey)}&latlong=${bbox.lat},${bbox.lon}`
    + `&radius=${Math.min(Math.round(bbox.radiusKm), 100)}&unit=km&size=50&sort=date,asc`;
  const d = await getJson(url);
  const list = d?._embedded?.events || [];
  const out = [];
  for (const e of list) {
    const v = e._embedded?.venues?.[0];
    const la = numOrNull(v?.location?.latitude), lo = numOrNull(v?.location?.longitude);
    if (la == null || lo == null) continue;
    const ts = Date.parse(e.dates?.start?.dateTime || e.dates?.start?.localDate) || Date.now();
    const ev = makeEvent({
      source: 'ticketmaster', nativeId: e.id, kind: 'civic', severity: 0, lat: la, lon: lo,
      title: e.name, description: v?.name || '', sourceUrl: e.url || 'https://ticketmaster.com', ts,
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'ticketmaster', category: 'incidents', kinds: ['civic'], keyless: false,
  label: 'Ticketmaster events', attribution: 'Ticketmaster Discovery',
  enabled: (cfg) => !!cfg.ticketmasterKey,
  fetch: (b, c) => fetchTm(b, c).catch(() => []),
}];
