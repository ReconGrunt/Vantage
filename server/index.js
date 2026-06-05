// Plane Projector — local proxy + static server.
//
// Why a proxy at all? Two reasons:
//   1. CORS — OpenSky and CelesTrak don't reliably send CORS headers, so the
//      browser can't fetch them directly.
//   2. Rate limits — anonymous OpenSky is heavily throttled. We cache responses
//      here so many viewers (or a redrawing dome) hit memory, not the network.
//
// All data sources are free and require no key:
//   - Aircraft:   OpenSky Network  https://opensky-network.org/api
//   - Satellites: CelesTrak GP/TLE https://celestrak.org/NORAD/elements/
//
// Optional: set OPENSKY_USER / OPENSKY_PASS (a free OpenSky account) to lift the
// anonymous rate limit. Everything works without them, just throttled harder.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// --- tiny in-memory cache ---------------------------------------------------
const cache = new Map(); // key -> { expires, data }

function getCached(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  return null;
}
function setCached(key, data, ttlMs) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}
async function fetchText(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// --- Aircraft (OpenSky) -----------------------------------------------------
// GET /api/aircraft?lat=..&lon=..&radius=.. (radius in km, default 250)
// Returns the raw-ish OpenSky "states" mapped into named objects.
app.get('/api/aircraft', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radiusKm = Math.min(parseFloat(req.query.radius) || 250, 600);
  if (!isFinite(lat) || !isFinite(lon)) {
    return res.status(400).json({ error: 'lat and lon required' });
  }

  // Convert radius to a rough bounding box (deg). 1 deg lat ~= 111 km.
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  const bbox = {
    lamin: (lat - dLat).toFixed(4), lamax: (lat + dLat).toFixed(4),
    lomin: (lon - dLon).toFixed(4), lomax: (lon + dLon).toFixed(4),
  };

  const cacheKey = `ac:${bbox.lamin},${bbox.lomin},${bbox.lamax},${bbox.lomax}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const url = `https://opensky-network.org/api/states/all?lamin=${bbox.lamin}&lomin=${bbox.lomin}&lamax=${bbox.lamax}&lomax=${bbox.lomax}`;
    const headers = {};
    if (process.env.OPENSKY_USER && process.env.OPENSKY_PASS) {
      const token = Buffer.from(`${process.env.OPENSKY_USER}:${process.env.OPENSKY_PASS}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    const raw = await fetchJson(url, { headers });

    // OpenSky state vector indices:
    // 0 icao24, 1 callsign, 2 origin_country, 5 lon, 6 lat, 7 baro_alt,
    // 8 on_ground, 9 velocity (m/s), 10 true_track (deg), 11 vert_rate,
    // 13 geo_alt, 14 squawk, 16 category
    const aircraft = (raw.states || [])
      .map((s) => ({
        id: s[0],
        callsign: (s[1] || '').trim(),
        country: s[2],
        lon: s[5], lat: s[6],
        altitude: s[13] ?? s[7], // geometric altitude (m), fall back to baro
        onGround: s[8],
        velocity: s[9],          // m/s
        heading: s[10],          // true track, deg
        verticalRate: s[11],     // m/s
        squawk: s[14] || null,   // transponder code
      }))
      // Airborne only. OpenSky's on_ground flag is primary, but it's sometimes
      // missing/stale for taxiing or parked aircraft, so we also reject anything
      // with no usable altitude, and anything that is both slow AND low (i.e.
      // taxiing/parked). Genuinely flying aircraft move fast or are well above
      // the field, so they're kept; hovering helicopters up high stay too.
      .filter((a) => {
        if (a.lat == null || a.lon == null) return false;
        if (a.onGround === true) return false;
        if (a.altitude == null || a.altitude <= 0) return false;
        const slow = a.velocity != null && a.velocity < 15;   // < ~54 km/h
        if (slow && a.altitude < 150) return false;           // taxiing / parked
        return true;
      });

    const payload = { time: raw.time, count: aircraft.length, aircraft };
    setCached(cacheKey, payload, 12_000); // OpenSky updates ~every 5-10s
    res.json(payload);
  } catch (err) {
    // Serve last-known data if we have any, even if stale, so the dome doesn't blink out.
    const stale = cache.get(cacheKey);
    if (stale) return res.json({ ...stale.data, stale: true, error: String(err) });
    res.status(502).json({ error: String(err), aircraft: [] });
  }
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

function pickAirport(a) {
  if (!a) return null;
  return {
    iata: a.iata_code || null,
    icao: a.icao_code || null,
    name: a.name || null,
    municipality: a.municipality || null,
    country: a.country_name || null,
  };
}

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
      + `&current=cloud_cover,visibility,weather_code,temperature_2m,wind_speed_10m,wind_direction_10m,is_day`;
    const d = await fetchJson(url);
    const c = d.current || {};
    const out = {
      cloudCover: c.cloud_cover ?? 0,           // %
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

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- static frontend --------------------------------------------------------
// no-store so the kiosk/browser always loads the latest build
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false, lastModified: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

app.listen(PORT, () => {
  console.log(`\n  Plane Projector running:  http://localhost:${PORT}\n`);
  if (!process.env.OPENSKY_USER) {
    console.log('  (anonymous OpenSky — set OPENSKY_USER/OPENSKY_PASS for higher aircraft rate limits)\n');
  }
});
