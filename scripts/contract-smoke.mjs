// contract-smoke.mjs — guards against drift between the two /api implementations
// (Node server/index.js and the Rust src-tauri proxy). Hits every route on both backends
// and asserts the response SHAPE matches (key sets + content types + stream/binary), not
// live values (which change every second). Run before every release.
//
//   node scripts/contract-smoke.mjs                 # Node :3000 vs Rust :47615
//   NODE_URL=... RUST_URL=... node scripts/contract-smoke.mjs
//
// Exit code 0 = contracts match; 1 = a mismatch or a backend was unreachable.

const NODE_URL = process.env.NODE_URL || 'http://127.0.0.1:3000';
const RUST_URL = process.env.RUST_URL || 'http://127.0.0.1:47615';

// A representative observer (LAX-ish) so the aircraft/weather routes return real data.
const LAT = 33.94, LON = -118.4;

let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); failures++; };

// sorted key set of an object
const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? Object.keys(o).sort() : [];
// keys we allow to appear on one side but not the other (timing-dependent)
const OPTIONAL = new Set(['cached', 'stale', 'error']);
const required = (o) => keys(o).filter((k) => !OPTIONAL.has(k));

function sameKeys(label, a, b) {
  const ka = required(a), kb = required(b);
  const miss = ka.filter((k) => !kb.includes(k));
  const extra = kb.filter((k) => !ka.includes(k));
  if (miss.length || extra.length) {
    fail(`${label}: key mismatch (node-only: [${miss}]  rust-only: [${extra}])`);
    return false;
  }
  pass(`${label}: keys {${ka.join(', ')}}`);
  return true;
}

async function getJson(base, path) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(15000) });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) throw new Error(`${path}: expected JSON, got "${ct}" (${res.status})`);
  return res.json();
}

async function checkJson(label, path, sampleArrayKey) {
  try {
    const [n, r] = await Promise.all([getJson(NODE_URL, path), getJson(RUST_URL, path)]);
    sameKeys(label, n, r);
    if (sampleArrayKey) {
      const na = n[sampleArrayKey], ra = r[sampleArrayKey];
      if (Array.isArray(na) && Array.isArray(ra) && na.length && ra.length) {
        sameKeys(`${label}.${sampleArrayKey}[0]`, na[0], ra[0]);
      } else {
        pass(`${label}.${sampleArrayKey}: (array empty on one side — shape check skipped)`);
      }
    }
  } catch (e) {
    fail(`${label}: ${e.message}`);
  }
}

async function checkContentType(label, path, wanted) {
  const out = {};
  for (const [name, base] of [['node', NODE_URL], ['rust', RUST_URL]]) {
    try {
      const ctrl = new AbortController();
      const res = await fetch(base + path, { signal: ctrl.signal });
      const ct = res.headers.get('content-type') || '';
      out[name] = { ok: res.ok, ct };
      // read a little then cancel (important for the infinite ATC stream)
      if (res.body) {
        const reader = res.body.getReader();
        let got = 0;
        while (got < 4096) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          got += value.length;
        }
        ctrl.abort();
      }
      if (res.ok && ct.includes(wanted)) pass(`${label} [${name}]: ${ct}`);
      else fail(`${label} [${name}]: status ${res.status}, content-type "${ct}" (wanted ${wanted})`);
    } catch (e) {
      // ATC feeds are frequently offline (502) — note but don't hard-fail the run on that alone.
      fail(`${label} [${name}]: ${e.message}`);
    }
  }
  return out;
}

// /api/sources must expose the SAME adapter catalog on both backends (this was a real gap:
// Node had the route, Rust didn't — the desktop City feed-catalog was degraded).
async function checkSourceIds() {
  try {
    const [n, r] = await Promise.all([getJson(NODE_URL, '/api/sources'), getJson(RUST_URL, '/api/sources')]);
    const ni = (n.sources || []).map((s) => s.id).sort();
    const ri = (r.sources || []).map((s) => s.id).sort();
    const miss = ni.filter((x) => !ri.includes(x)), extra = ri.filter((x) => !ni.includes(x));
    if (miss.length || extra.length) fail(`sources id set: node-only [${miss}] rust-only [${extra}]`);
    else pass(`sources id set: ${ni.length} identical`);
    const ne = Object.fromEntries((n.sources || []).map((s) => [s.id, s.enabled]));
    const re = Object.fromEntries((r.sources || []).map((s) => [s.id, s.enabled]));
    const bad = ni.filter((id) => ne[id] !== re[id]);
    if (bad.length) fail(`sources enabled mismatch: [${bad}]`); else pass('sources enabled state: identical');
  } catch (e) { fail(`sources id set: ${e.message}`); }
}

// /api/camimg/:id must resolve a served camera id and return an image on both backends.
async function checkCamImg() {
  for (const [name, base] of [['node', NODE_URL], ['rust', RUST_URL]]) {
    try {
      const cams = await getJson(base, `/api/cameras?lat=${LAT}&lon=${LON}&radius=40`);
      const cam = (cams.cameras || []).find((c) => c.proxied);
      if (!cam) { pass(`camimg [${name}]: (no proxied camera in range — skipped)`); continue; }
      const res = await fetch(base + `/api/camimg/${encodeURIComponent(cam.id)}`, { signal: AbortSignal.timeout(15000) });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.startsWith('image/')) pass(`camimg [${name}]: ${ct}`);
      else fail(`camimg [${name}]: status ${res.status}, content-type "${ct}"`);
    } catch (e) { fail(`camimg [${name}]: ${e.message}`); }
  }
}

async function main() {
  console.log(`Contract smoke test\n  node = ${NODE_URL}\n  rust = ${RUST_URL}\n`);

  console.log('health');
  await checkJson('health', '/api/health');

  console.log('aircraft');
  await checkJson('aircraft', `/api/aircraft?lat=${LAT}&lon=${LON}&radius=250`, 'aircraft');

  console.log('tle');
  await checkJson('tle', '/api/tle?group=stations', 'sats');

  console.log('weather');
  await checkJson('weather', `/api/weather?lat=${LAT}&lon=${LON}`);

  console.log('incidents (ground/city domain)');
  await checkJson('incidents', `/api/incidents?lat=${LAT}&lon=${LON}&radius=25`, 'events');

  console.log('cameras (ground/city domain)');
  await checkJson('cameras', `/api/cameras?lat=${LAT}&lon=${LON}&radius=25`, 'cameras');

  console.log('sources (adapter catalog)');
  await checkJson('sources', '/api/sources', 'sources');
  await checkSourceIds();

  console.log('camimg (proxied camera image)');
  await checkCamImg();

  console.log('geolocate (network location fallback)');
  await checkJson('geolocate', '/api/geolocate');

  console.log('prefs (origin-independent local persistence)');
  await checkJson('prefs', '/api/prefs');

  console.log('flightinfo');
  await checkJson('flightinfo', '/api/flightinfo?callsign=UAL123&icao24=a1b2c3');

  console.log('atc list');
  await checkJson('atc', '/api/atc', 'feeds');

  console.log('tile (expect image/*)');
  await checkContentType('tile', '/api/tile/sat/5/5/12', 'image/');

  console.log('atc stream (expect audio/*, may be offline)');
  await checkContentType('atc/klax_twr', '/api/atc/klax_twr', 'audio/');

  console.log(`\n${failures ? `FAILED (${failures})` : 'OK — contracts match'}`);
  process.exit(failures ? 1 : 0);
}

main();
