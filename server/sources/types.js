// types.js — the ONE normalized shape for the Ground/City domain, shared by every
// source adapter (and mirrored by the Rust proxy + the frontend's city.js). Keeping
// the model here means adding a feed never changes a renderer: an adapter's only job
// is to turn some upstream record into a normalized Event or Camera.
//
// Design rules (mirror the Air domain's proxy ethos in server/index.js):
//   - Units/coordinates normalized; numbers coerced like JS Number(x); missing -> null.
//   - PLACE/EVENT-CENTRIC only. An Event with no coordinates is dropped, not guessed —
//     this is a common-operating-picture of places, never a tracker of people.
//   - `severity` is ALWAYS adapter-assigned (0 info .. 3 major); never inferred later.

// Canonical event kinds (drives glyphs, colours, and the legend/layer toggles).
export const EVENT_KINDS = [
  'fire', 'medical', 'police', 'traffic', 'hazard', 'quake',
  'weather', 'fire-wildland', 'social', 'civic', 'camera', 'outage',
];

// JS Number(x) with '', null, non-numeric -> null (matches server/index.js numOrNull
// and the Rust proxy's to_num, so both backends agree on empty-string coordinates).
export function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function clampSev(s) {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 3 ? 3 : n;
}

// Build a normalized Event, or null if it can't be placed on the map (no geo). The
// upstream `raw` record is intentionally NOT carried on the wire (it can be huge — a
// 1000-row crime layer would balloon the payload); the detail panel renders the
// normalized fields. Keys here are the exact contract the Rust proxy mirrors.
export function makeEvent({ source, nativeId, kind, severity, lat, lon, title, description, sourceUrl, ts, expiresTs }) {
  const la = numOrNull(lat), lo = numOrNull(lon);
  if (la == null || lo == null) return null;                 // no location -> not a map event
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return {
    id: `${source}:${nativeId}`,                             // stable dedup key
    kind: EVENT_KINDS.includes(kind) ? kind : 'civic',
    severity: clampSev(severity),
    lat: la, lon: lo,
    title: title ? String(title).slice(0, 160) : '',
    description: description ? String(description).slice(0, 400) : '',
    source,
    sourceUrl: sourceUrl || null,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    expiresTs: Number.isFinite(expiresTs) ? expiresTs : null,
  };
}

// Build a normalized Camera, or null if unplaceable / has no image. Exactly one of
// still (snapshot JPEG) or stream (HLS/MP4) is required.
export function makeCamera({ provider, nativeId, name, lat, lon, still, stream, proxied }) {
  const la = numOrNull(lat), lo = numOrNull(lon);
  if (la == null || lo == null) return null;
  if (!still && !stream) return null;
  return {
    id: `${provider}:${nativeId}`,
    name: name ? String(name).slice(0, 120) : '(camera)',
    lat: la, lon: lo,
    still: still || null,
    stream: stream || null,
    provider,
    proxied: !!proxied,                                      // true -> fetch image via /api/camimg/:id
  };
}

// --- geography helpers ------------------------------------------------------
// A query is a centre + radius; adapters get a bounding box (most upstreams want a
// bbox or a between-clause). Rough degrees-per-km is fine for gating + coarse filters.
export function bboxFromRadius(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.0;
  const dLon = radiusKm / (111.0 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
  return {
    lat, lon, radiusKm,
    minLat: lat - dLat, maxLat: lat + dLat,
    minLon: lon - dLon, maxLon: lon + dLon,
  };
}

export function inBbox(bbox, la, lo) {
  return la != null && lo != null
    && la >= bbox.minLat && la <= bbox.maxLat
    && lo >= bbox.minLon && lo <= bbox.maxLon;
}

// Do two boxes overlap? Used to skip a city adapter entirely when the observer is
// nowhere near it (no wasted upstream call).
export function bboxIntersects(bbox, region) {
  if (!region) return true;
  return !(bbox.minLat > region.maxLat || bbox.maxLat < region.minLat
        || bbox.minLon > region.maxLon || bbox.maxLon < region.minLon);
}

export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, D = Math.PI / 180;
  const dLat = (bLat - aLat) * D, dLon = (bLon - aLon) * D;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * D) * Math.cos(bLat * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// --- shared text classifiers (many CAD/311 feeds only give a free-text call type) ---
// Coarse but honest: map a dispatch/description string to a kind + severity. Adapters
// with a cleaner native field should override rather than rely on these.
export function kindFromText(t = '') {
  const s = String(t).toLowerCase();
  if (/\b(fire|smoke|arson|burn|alarm|flames?)\b/.test(s)) return 'fire';
  if (/\b(medic|aid|ems|injur|cardiac|overdose|\bod\b|sick|breathing|unconsc|seizure|stroke|casualt|fall)\b/.test(s)) return 'medical';
  if (/\b(theft|robb|assault|burglar|shoot|shots|weapon|homicid|stab|battery|narcotic|domestic|\bdui\b|arrest|shoplift|trespass|vandal|prowler|gun)\b/.test(s)) return 'police';
  if (/\b(crash|collision|accident|traffic|vehicle|\bmva\b|\bmvc\b|disabled|hazard on|road)\b/.test(s)) return 'traffic';
  if (/\b(hazmat|gas leak|spill|wires? down|flood|rescue|water)\b/.test(s)) return 'hazard';
  return 'civic';
}

export function sevFromText(t = '') {
  const s = String(t).toLowerCase();
  if (/\b(working fire|structure fire|shooting|shots fired|homicid|stab|explosion|hazmat|not breathing|cardiac arrest|major|fatal|entrapment|active)\b/.test(s)) return 3;
  if (/\b(fire|assault|robb|crash|collision|injur|overdose|weapon|rescue|gas leak)\b/.test(s)) return 2;
  return 1;
}
