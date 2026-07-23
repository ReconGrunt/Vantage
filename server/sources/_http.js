// _http.js — the one fetch helper every Ground/City adapter uses. Mirrors the Air
// proxy's discipline (server/index.js): a hard 8 s total timeout so a stalled upstream
// fails fast into the route's serve-stale path instead of hanging, plus a descriptive
// User-Agent (several of these gov APIs — notably api.weather.gov — reject blank UAs).

const UA = 'Vantage/0.1 (all-domain situational awareness; +github.com/ReconGrunt/vantage)';

export async function getJson(url, { headers = {}, timeout = 8000, method = 'GET', body = null } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function getText(url, { headers = {}, timeout = 8000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

// Fetch raw bytes (for the camera-image proxy). Returns { buf, type }.
export async function getBytes(url, { headers = {}, timeout = 8000 } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, type };
}

export { UA };
