// Vantage · Air — local proxy + static server (web / dev build). The desktop app
// reimplements this same /api contract natively in Rust (see src-tauri/); keep the two in
// sync via scripts/contract-smoke.mjs.
//
// Why a proxy at all? Two reasons:
//   1. CORS — most of these upstreams don't reliably send CORS headers, so the
//      browser can't fetch them directly.
//   2. Rate limits / caching — we cache responses here so many viewers (or a
//      redrawing dome) hit memory, not the network.
//
// All data sources are free and require no key:
//   - Aircraft:   adsb.lol + adsb.fi (community ADS-B aggregators)
//   - Satellites: CelesTrak GP/TLE  https://celestrak.org/NORAD/elements/
//   - Routes/types: adsbdb · Weather: Open-Meteo · ATC audio: LiveATC.net

import express from 'express';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

// Prefer IPv4: some upstreams (e.g. LiveATC edges) advertise AAAA records whose
// IPv6 path black-holes, making undici's fetch hang on connect while IPv4 is fine.
dns.setDefaultResultOrder('ipv4first');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// --- tiny in-memory cache ---------------------------------------------------
// key -> { expires, data }. Capacity-bounded (evict oldest — Map preserves
// insertion order) rather than time-swept: expired entries are intentionally
// kept so the serve-stale fallbacks below can hand back last-known data when an
// upstream is down. Active keys are re-inserted on every refresh (setCached
// deletes-then-sets), so they stay "newest" and only genuinely idle keys (a
// flight seen once and never again) age out. Mirrors the Rust backend's moka
// max_capacity bound so a 24/7 kiosk — or an attacker spraying random
// ?callsign= values at /api/flightinfo — can't grow the Map without limit.
const cache = new Map();
const CACHE_MAX = 10_000;

function getCached(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  return null;
}
function setCached(key, data, ttlMs) {
  cache.delete(key); // re-insert at the end so eviction removes the oldest first
  cache.set(key, { data, expires: Date.now() + ttlMs });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Default every upstream call to an 8 s total timeout (matching the Rust proxy's
// shared client) so a stalled CelesTrak/Open-Meteo/adsbdb connection fails fast
// into the serve-stale path instead of hanging on undici's ~5 min default.
async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
async function fetchText(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// --- Aircraft (community ADS-B aggregators) ---------------------------------
// GET /api/aircraft?lat=..&lon=..&radius=.. (radius in km, default 250)
//
// Source: adsb.lol with adsb.fi as a fallback — both free, no key, and far more
// generous than OpenSky (which now hard-throttles anonymous access). They share
// the tar1090/readsb "aircraft.json" schema, so one mapper covers both. The data
// is richer too: ICAO type, registration and a military flag come for free.
const ADSB_SOURCES = [
  (lat, lon, nm) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
];
const ADSB_UA = { 'User-Agent': 'Vantage/0.1 (all-domain situational awareness; github.com/ReconGrunt/vantage)' };

// One readsb aircraft record -> our named, unit-normalised object (metres, m/s).
function mapAdsbRecord(a) {
  const onGround = a.alt_baro === 'ground';
  const altFt = onGround ? 0 : (a.alt_geom ?? (typeof a.alt_baro === 'number' ? a.alt_baro : null));
  const vrFpm = a.geom_rate ?? a.baro_rate; // ft/min
  return {
    id: a.hex,
    callsign: (a.flight || '').trim(),
    country: null,                                            // not in ADS-B feed
    lon: a.lon, lat: a.lat,
    altitude: altFt == null ? null : altFt * 0.3048,         // ft -> m
    onGround,
    velocity: a.gs != null ? a.gs * 0.514444 : null,         // kt -> m/s
    heading: a.track ?? a.true_heading ?? null,              // true track, deg
    verticalRate: vrFpm != null ? vrFpm * 0.00508 : null,    // ft/min -> m/s
    squawk: a.squawk || null,
    type: a.t || null,                                       // ICAO type (bonus)
    registration: a.r || null,                               // tail (bonus)
    category: a.category || null,                            // ADS-B emitter cat (A1..A7, B..)
    military: !!(a.dbFlags & 1),                             // tar1090 mil flag (bonus)
    // How many seconds old the position already is at the source — the client
    // dead-reckons this far forward so the plane sits where it really is NOW.
    seenPos: typeof a.seen_pos === 'number' ? a.seen_pos : (typeof a.seen === 'number' ? a.seen : 0),
  };
}

// Airborne only: reject on-ground, no-altitude, and slow-AND-low (taxiing/parked).
// High, fast, or hovering-up-high traffic is kept.
function airborne(a) {
  if (a.lat == null || a.lon == null) return false;
  if (a.onGround === true) return false;
  if (a.altitude == null || a.altitude <= 0) return false;
  const slow = a.velocity != null && a.velocity < 15; // < ~54 km/h
  if (slow && a.altitude < 150) return false;
  return true;
}

app.get('/api/aircraft', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radiusKm = Math.min(parseFloat(req.query.radius) || 250, 600);
  if (!isFinite(lat) || !isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' });
  }
  const nm = Math.min(Math.round(radiusKm / 1.852), 250); // these APIs cap at 250 nm

  const cacheKey = `ac:${lat.toFixed(2)},${lon.toFixed(2)},${nm}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  let lastErr = null;
  for (const make of ADSB_SOURCES) {
    const url = make(lat, lon, nm);
    try {
      const raw = await fetchJson(url, { headers: ADSB_UA, signal: AbortSignal.timeout(8000) });
      const list = raw.ac || raw.aircraft || [];
      const aircraft = list.map(mapAdsbRecord).filter(airborne);
      const host = new URL(url).host;
      const payload = { time: Math.floor(Date.now() / 1000), count: aircraft.length, aircraft, source: host };
      setCached(cacheKey, payload, 2_000); // near real-time; these feeds refresh every few seconds
      return res.json(payload);
    } catch (err) {
      lastErr = err; // try the next source
    }
  }

  // Both sources failed — serve last-known data if we have any so the dome holds.
  const stale = cache.get(cacheKey);
  if (stale) return res.json({ ...stale.data, stale: true, error: String(lastErr) });
  res.status(502).json({ error: String(lastErr), aircraft: [] });
});

// --- Satellites (CelesTrak TLE) ---------------------------------------------
// GET /api/tle?group=visual  -> returns array of { name, line1, line2 }
// Valid groups include: stations, visual, starlink, gps-ops, galileo, science,
// weather, geo, active. See https://celestrak.org/NORAD/elements/
const ALLOWED_GROUPS = new Set([
  'stations', 'visual', 'starlink', 'gps-ops', 'galileo', 'glo-ops',
  'science', 'weather', 'noaa', 'goes', 'geo', 'active', 'last-30-days',
]);

app.get('/api/tle', async (req, res) => {
  const group = String(req.query.group || 'visual').toLowerCase();
  if (!ALLOWED_GROUPS.has(group)) {
    return res.status(400).json({ error: `unknown group "${group}"` });
  }

  const cacheKey = `tle:${group}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ group, count: cached.length, sats: cached, cached: true });

  try {
    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
    const text = await fetchText(url);
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
    const sats = [];
    for (let i = 0; i + 2 < lines.length + 1; i += 3) {
      const name = lines[i]?.trim();
      const line1 = lines[i + 1];
      const line2 = lines[i + 2];
      if (name && line1?.startsWith('1 ') && line2?.startsWith('2 ')) {
        sats.push({ name, line1, line2 });
      }
    }
    setCached(cacheKey, sats, 6 * 60 * 60 * 1000); // TLEs refresh ~daily; cache 6h
    res.json({ group, count: sats.length, sats });
  } catch (err) {
    const stale = cache.get(cacheKey);
    if (stale) return res.json({ group, count: stale.data.length, sats: stale.data, stale: true });
    res.status(502).json({ error: String(err), sats: [] });
  }
});

// --- Flight enrichment (adsbdb) ---------------------------------------------
// GET /api/flightinfo?callsign=UAL123&icao24=a1b2c3
// Returns aircraft type + route (origin/destination) from adsbdb — free, no key.
// Cached hard: routes/types barely change, and we want to be a polite client.
app.get('/api/flightinfo', async (req, res) => {
  const callsign = String(req.query.callsign || '').trim().toUpperCase();
  const icao24 = String(req.query.icao24 || '').trim().toLowerCase();
  const cacheKey = `fi:${callsign}:${icao24}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const out = { callsign, route: null, aircraft: null };
  await Promise.all([
    (async () => {
      if (!callsign) return;
      try {
        const d = await fetchJson(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`);
        const fr = d?.response?.flightroute;
        if (fr) {
          out.route = {
            origin: pickAirport(fr.origin),
            destination: pickAirport(fr.destination),
            airline: fr.airline?.name || null,
          };
        }
      } catch { /* no route known */ }
    })(),
    (async () => {
      if (!icao24) return;
      try {
        const d = await fetchJson(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(icao24)}`);
        const ac = d?.response?.aircraft;
        if (ac) {
          out.aircraft = {
            type: ac.type || null,
            manufacturer: ac.manufacturer || null,
            registration: ac.registration || null,
            owner: ac.registered_owner || null,
          };
        }
      } catch { /* unknown airframe */ }
    })(),
  ]);

  // Cache hits for 24h; misses for 1h (the flight may simply not be in adsbdb yet).
  const ttl = (out.route || out.aircraft) ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  setCached(cacheKey, out, ttl);
  res.json(out);
});

// Parse a possibly-string coordinate to a number, treating null/''/non-numeric
// as null (matches the Rust proxy's to_num, avoids Number('') === 0).
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickAirport(a) {
  if (!a) return null;
  return {
    iata: a.iata_code || null,
    icao: a.icao_code || null,
    name: a.name || null,
    municipality: a.municipality || null,
    country: a.country_name || null,
    // Guard empty strings: Number('') is 0 (→ Gulf of Guinea), and the Rust
    // proxy's to_num() yields null for '' — coerce to null here for parity.
    lat: numOrNull(a.latitude),
    lon: numOrNull(a.longitude),
  };
}

// --- Live ATC audio (LiveATC.net) -------------------------------------------
// There is no public per-aircraft *cockpit* audio anywhere — but the facility an
// aircraft is working (tower/approach) is streamed live & free by LiveATC. We
// proxy it (their CDN edge is Cloudflare-challenged for the generic host, but the
// regional Icecast servers stream fine with a browser UA + referer). Off by
// default in the UI; the client tunes the nearest verified facility on hover.
//
// Each feed is host-verified (see scripts/atc-probe.mjs). lat/lon let the client
// pick the closest one to the hovered aircraft.
const ATC_FEEDS = {
  klax_twr: { label: 'KLAX Tower', lat: 33.9425, lon: -118.4081 },
  ksfo_twr: { label: 'KSFO Tower', lat: 37.6189, lon: -122.3750 },
  kdal_twr: { label: 'KDAL Tower', lat: 32.8470, lon: -96.8518 },
  kdtw_twr: { label: 'KDTW Tower', lat: 42.2124, lon: -83.3534 },
  kjfk_twr: { label: 'KJFK Tower', lat: 40.6398, lon: -73.7789 },
  klga_twr: { label: 'LaGuardia Tower', lat: 40.7769, lon: -73.8740 },
  kewr_twr: { label: 'KEWR Tower', lat: 40.6925, lon: -74.1687 },
  katl_twr: { label: 'KATL Tower', lat: 33.6367, lon: -84.4281 },
};
const ATC_HOSTS = ['s1-bos', 's1-fmt2', 's1-sjc'];
const ATC_UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.liveatc.net/' };

// List feeds (with coords) so the client can choose the nearest to an aircraft.
app.get('/api/atc', (_req, res) => {
  res.json({ feeds: Object.entries(ATC_FEEDS).map(([id, f]) => ({ id, ...f })) });
});

// Find which regional Icecast host currently serves a feed; cache the winner.
async function resolveAtcUrl(feed) {
  const ck = `atcurl:${feed}`;
  const hit = getCached(ck);
  if (hit) return hit;
  for (const h of ATC_HOSTS) {
    const url = `https://${h}.liveatc.net/${feed}`;
    try {
      const r = await fetch(url, { headers: ATC_UA, signal: AbortSignal.timeout(3000) });
      const ct = r.headers.get('content-type') || '';
      try { await r.body?.cancel(); } catch { /* ignore */ }
      if (r.ok && ct.includes('audio')) { setCached(ck, url, 30 * 60 * 1000); return url; }
    } catch { /* try next host */ }
  }
  return null;
}

// Stream-proxy one feed: GET /api/atc/klax_twr
app.get('/api/atc/:feed', async (req, res) => {
  const feed = String(req.params.feed).toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!ATC_FEEDS[feed]) return res.status(404).json({ error: 'unknown feed' });
  const url = await resolveAtcUrl(feed);
  if (!url) return res.status(502).json({ error: 'feed offline' });
  try {
    // bound the connect; once headers arrive, let the body stream indefinitely
    const ctrl = new AbortController();
    const connectTimer = setTimeout(() => ctrl.abort(), 8000);
    const upstream = await fetch(url, { headers: ATC_UA, signal: ctrl.signal });
    clearTimeout(connectTimer);
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'stream unavailable' });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Atc-Name', upstream.headers.get('icy-name') || ATC_FEEDS[feed].label);
    const reader = upstream.body.getReader();
    let closed = false;
    const stop = () => { closed = true; reader.cancel().catch(() => {}); };
    req.on('close', stop);
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(Buffer.from(value))) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: String(err) });
    else res.end();
  }
});

// --- Weather (Open-Meteo) ---------------------------------------------------
// GET /api/weather?lat=..&lon=..  -> current conditions. Free, no key.
// Used to render realistic cloud cover and dim the sky/stars when overcast.
app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: 'lat/lon required' });
  const key = `wx:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = getCached(key);
  if (cached) return res.json({ ...cached, cached: true });
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high`
      + `,visibility,weather_code,temperature_2m,wind_speed_10m,wind_direction_10m,is_day`;
    const d = await fetchJson(url);
    const c = d.current || {};
    const out = {
      cloudCover: c.cloud_cover ?? 0,           // % total
      cloudLow: c.cloud_cover_low ?? null,      // % low deck (cumulus/stratus, 0-2km)
      cloudMid: c.cloud_cover_mid ?? null,      // % mid deck (altocumulus, 2-7km)
      cloudHigh: c.cloud_cover_high ?? null,    // % high deck (cirrus, 7-12km)
      visibility: c.visibility ?? null,         // m
      weatherCode: c.weather_code ?? null,      // WMO code
      temperature: c.temperature_2m ?? null,    // °C
      windSpeed: c.wind_speed_10m ?? null,      // km/h
      windDir: c.wind_direction_10m ?? 0,       // deg
      isDay: c.is_day ?? null,
    };
    setCached(key, out, 10 * 60 * 1000); // 10 min
    res.json(out);
  } catch (err) {
    const stale = cache.get(key);
    if (stale) return res.json({ ...stale.data, stale: true });
    res.status(502).json({ error: String(err), cloudCover: 0 });
  }
});

// --- Map basemap tiles (satellite / terrain, for the top-down radar view) ---------
// GET /api/tile/:style/:z/:x/:y  -> proxies + caches one standard XYZ slippy-map tile
// (256x256, EPSG:3857/Web Mercator — the same scheme Google/Bing/OSM/Leaflet use), so
// the radar's basemap works with no API key and no CORS/browser hotlinking issues.
//
// Provider: Esri's public "World_Imagery" (satellite) and "World_Topo_Map" (terrain +
// street reference) ArcGIS REST tile services — free, no key, widely used for exactly
// this kind of embedded map. NOTE for a government-submission context: review Esri's
// terms of use (esri.com/en-us/legal/terms/full-master-agreement) for YOUR specific
// redistribution scenario before final submission — this proxy is technically correct
// and the endpoints are commonly used free-of-charge, but licensing sign-off for a
// formal deliverable is a decision for the submitting team, not this code.
const TILE_PROVIDERS = {
  sat: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  terrain: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`,
};
const TILE_UA = { 'User-Agent': 'Vantage/0.1 (tactical radar basemap; github.com/ReconGrunt/vantage)' };
// Separate from the generic JSON `cache` above: tile values are binary buffers, keyed
// over a practically unbounded (z,x,y) space (a browsable world map), so this cache is
// capacity-bounded (evict oldest — Map preserves insertion order) rather than time-swept.
const tileCache = new Map(); // "style/z/x/y" -> { buf, type, expires }
const TILE_CACHE_MAX = 4000;

app.get('/api/tile/:style/:z/:x/:y', async (req, res) => {
  const { style, z, x, y } = req.params;
  const make = TILE_PROVIDERS[style];
  const zi = parseInt(z, 10), xi = parseInt(x, 10), yi = parseInt(y, 10);
  if (!make || !Number.isInteger(zi) || !Number.isInteger(xi) || !Number.isInteger(yi)
      || zi < 0 || zi > 19 || xi < 0 || yi < 0) {
    return res.status(400).end();
  }
  const key = `${style}/${zi}/${xi}/${yi}`;
  const hit = tileCache.get(key);
  if (hit && hit.expires > Date.now()) {
    res.setHeader('Content-Type', hit.type);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.end(hit.buf);
  }
  try {
    const upstream = await fetch(make(zi, xi, yi), { headers: TILE_UA, signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) return res.status(upstream.status).end();
    const type = upstream.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, { buf, type, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 }); // imagery rarely changes; cache a week
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.end(buf);
  } catch {
    res.status(502).end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- static frontend --------------------------------------------------------
// no-store so the kiosk/browser always loads the latest build
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Vantage · Air (web) running:  http://127.0.0.1:${PORT}`);
  console.log('  Aircraft: adsb.lol (adsb.fi fallback) — free, no key.\n');
});
// Graceful shutdown so Ctrl-C / a supervising process closes the listener cleanly.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
