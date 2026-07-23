// registry.js — the pluggability core. Every adapter registers here; the route just
// asks collect('incidents'|'cameras', bbox, cfg) and gets a fused, de-duplicated list
// plus an HONEST per-source health array (mirrors the Air domain's link-health ethos —
// a dead feed shows as {ok:false}, it never fails the whole route).
//
// Keyless official feeds are always on. Opt-in "gray" adapters (Citizen / Snap Map /
// PulsePoint / scanner) are OFF unless their env flag is set — they are never a default.

import { bboxFromRadius } from './types.js';
import socrata from './socrata.js';
import arcgis from './arcgis.js';
import nws from './nws.js';
import usgs from './usgs.js';
import caltrans from './caltrans.js';
import nyctmc from './nyctmc.js';
import citizen from './gray/citizen.js';
import pulsepoint from './gray/pulsepoint.js';
import snapmap from './gray/snapmap.js';
import scanner from './gray/scanner.js';
// Phase 2 — keyed-but-free (off until an env key is set) + keyless TfL/FL511.
import tfl from './tfl.js';
import airquality from './airquality.js';
import firms from './firms.js';
import windy from './windy.js';
import wsdot from './wsdot.js';
import open511sf from './open511sf.js';
import events from './events.js';
// Phase 3 — more keyless natural-hazard feeds + opt-in Bluesky social.
import iem from './iem.js';
import eonet from './eonet.js';
import gdacs from './gdacs.js';
import nwps from './nwps.js';
// Real-time California road activity (the live backbone for LA, which publishes no
// real-time police/fire dispatch feed).
import caltransLcs from './caltrans-lcs.js';
import caltransCms from './caltrans-cms.js';
import bluesky from './gray/bluesky.js';

const ADAPTERS = [
  // --- keyless, official / legal-aggregator, DEFAULT ON ---
  ...socrata, ...arcgis, ...nws, ...usgs,           // incidents (+ FL511 cameras via arcgis)
  ...iem, ...eonet, ...gdacs, ...nwps,              // more keyless hazard / natural-event feeds
  ...caltransLcs, ...caltransCms,                    // real-time CA road closures + message signs
  ...caltrans, ...nyctmc, ...tfl,                    // cameras
  // --- Phase 2: keyed-but-free, activate by setting the env key (off otherwise) ---
  ...airquality, ...firms, ...windy, ...wsdot, ...open511sf, ...events,
  // --- opt-in "gray", DEFAULT OFF (never enabled without an explicit flag) ---
  ...citizen, ...pulsepoint, ...snapmap, ...scanner, ...bluesky,
];

// id -> image URL for every camera we've SERVED, so /api/camimg/:id resolves against the
// server's own catalog (never a caller-supplied URL: no open image proxy / SSRF).
export const cameraIndex = new Map();
const CAM_INDEX_MAX = 8000;
function indexCamera(cam) {
  const url = cam.still || cam.stream;
  if (!url) return;
  cameraIndex.delete(cam.id);
  cameraIndex.set(cam.id, url);
  if (cameraIndex.size > CAM_INDEX_MAX) cameraIndex.delete(cameraIndex.keys().next().value);
}

function parseScanner(s) {
  return String(s || '').split(',').map((t) => t.trim()).filter(Boolean).map((tok) => {
    const [shortName, lat, lon, ...label] = tok.split(':');
    return { shortName, lat: Number(lat), lon: Number(lon), label: label.join(':') || shortName };
  }).filter((x) => x.shortName && Number.isFinite(x.lat) && Number.isFinite(x.lon));
}

export function resolveConfig(env = process.env) {
  return {
    socrataToken: env.SOCRATA_APP_TOKEN || null,
    // Phase 2 keyed feeds — free to obtain; each stays OFF until its key is present.
    airnowKey: env.AIRNOW_KEY || null,
    firmsKey: env.FIRMS_MAP_KEY || null,
    windyKey: env.WINDY_KEY || null,
    wsdotKey: env.WSDOT_KEY || null,
    tflKey: env.TFL_APP_KEY || null,               // optional: TfL works keyless at low rate
    five11SfToken: env.FIVE11_SF_TOKEN || null,
    ticketmasterKey: env.TICKETMASTER_KEY || null,
    enableCitizen: env.VANTAGE_ENABLE_CITIZEN === '1',
    enableSnap: env.VANTAGE_ENABLE_SNAPMAP === '1',
    enablePulsepoint: env.VANTAGE_ENABLE_PULSEPOINT === '1',
    pulsepointAgencies: String(env.VANTAGE_PULSEPOINT_AGENCIES || '').split(',').map((x) => x.trim()).filter(Boolean),
    enableScanner: env.VANTAGE_ENABLE_SCANNER === '1',
    scannerSystems: parseScanner(env.VANTAGE_SCANNER_SYSTEMS),
    blueskyQuery: env.VANTAGE_BLUESKY_QUERY || null, // opt-in aggregate social by place term
  };
}

function safeEnabled(a, cfg) {
  try { return a.enabled ? !!a.enabled(cfg) : true; } catch { return false; }
}

// list adapters + their resolved on/off state (for a status endpoint / the UI legend).
export function listAdapters(cfg) {
  return ADAPTERS.map((a) => ({
    id: a.id, category: a.category, kinds: a.kinds || [], optin: !!a.optin,
    keyed: a.keyless === false,
    enabled: safeEnabled(a, cfg), attribution: a.attribution || '', label: a.label || a.id,
  }));
}

// Hard per-adapter wall so one slow feed can't hold the whole fused response (each
// adapter also self-times-out at 8 s in _http.js; this is the belt-and-braces backstop).
const ADAPTER_WALL_MS = 9000;
function withWall(p) {
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error('adapter timeout')), ADAPTER_WALL_MS)),
  ]);
}

export async function collect(category, bbox, cfg) {
  const chosen = ADAPTERS.filter((a) => a.category === category && safeEnabled(a, cfg));
  const settled = await Promise.allSettled(chosen.map((a) => withWall(a.fetch(bbox, cfg))));
  const items = [];
  const sources = [];
  chosen.forEach((a, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      const clean = r.value.filter(Boolean);
      items.push(...clean);
      if (category === 'cameras') for (const cam of clean) indexCamera(cam);
      sources.push({ id: a.id, ok: true, count: clean.length, optin: !!a.optin });
    } else {
      sources.push({ id: a.id, ok: false, count: 0, optin: !!a.optin, error: String(r.reason || 'failed').slice(0, 140) });
    }
  });
  // de-dup by stable id (same incident reported by two feeds collapses to one)
  const seen = new Set();
  const deduped = [];
  for (const it of items) { if (!it || seen.has(it.id)) continue; seen.add(it.id); deduped.push(it); }
  return { items: deduped, sources };
}

export { bboxFromRadius };
