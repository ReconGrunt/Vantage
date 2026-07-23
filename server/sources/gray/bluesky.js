// bluesky.js — OPT-IN, DEFAULT OFF. Bluesky has a genuinely free, unauthenticated public
// search (api.bsky.app). Enabled only when VANTAGE_BLUESKY_QUERY is set to a place term,
// e.g. VANTAGE_BLUESKY_QUERY="San Francisco".
//
// STRICTLY AGGREGATE + PLACE-CENTRIC. Posts carry no coordinates, so this NEVER maps an
// individual post, author, or handle — it emits ONE "social chatter" density marker at the
// observer with a recent-post count for the configured place. If it ever surfaced a person
// it would violate project rules, so it is built to be incapable of that.

import { getJson } from '../_http.js';
import { makeEvent } from '../types.js';

async function fetchBsky(bbox, cfg) {
  const q = cfg.blueskyQuery;
  if (!q) return [];
  const d = await getJson(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25&sort=latest`);
  const posts = d?.posts || [];
  const recent = posts.filter((p) => Date.now() - (Date.parse(p.indexedAt) || 0) < 6 * 3600e3).length || posts.length;
  if (!recent) return [];
  const ev = makeEvent({
    source: 'bluesky', nativeId: `chatter:${q}`, kind: 'social',
    severity: recent >= 20 ? 2 : recent >= 8 ? 1 : 0, lat: bbox.lat, lon: bbox.lon,
    title: `Social chatter: ${recent} recent Bluesky posts on "${q}"`,
    description: 'Aggregate place-activity signal (no individuals).',
    sourceUrl: 'https://bsky.app', ts: Date.now(),
  });
  return ev ? [ev] : [];
}

export default [{
  id: 'bluesky', category: 'incidents', kinds: ['social'], keyless: true, optin: true,
  label: 'Bluesky social chatter', attribution: 'Bluesky (aggregate place-heat)',
  enabled: (cfg) => !!cfg.blueskyQuery,
  fetch: (b, c) => fetchBsky(b, c),
}];
