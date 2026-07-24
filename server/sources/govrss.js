// govrss.js — official department news/alert RSS. One adapter FAMILY: adding a department
// is one row in FEEDS, not new code.
//
// Why this matters: LA departments (LAPD, LAFD, Caltrans, and their per-division accounts)
// break news on X, but X's read API is paid and its syndication endpoint rate-limits
// (verified: 429) — and scraping it is off-limits. The SAME departments publish the same
// updates through official RSS, which is free, legal, structured, and needs no key. That
// is strictly the better source.
//
// Two practical details learned the hard way:
//   · lapdonline.org returns 403 to a plain UA and 200 to a browser UA, so we send one.
//   · These posts carry no coordinates, so we place them at the named LAPD division when
//     the text mentions one (Devonshire, Van Nuys, Topanga...), else the feed's own
//     centroid. Division-level is the real precision — nothing finer is invented.

import { getText } from './_http.js';
import { makeEvent, inBbox, bboxIntersects, sevFromText, kindFromText } from './types.js';
import { DIVISIONS } from './lapd.js';

const BROWSER_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
};

const LA_REGION = { minLat: 33.68, maxLat: 34.35, minLon: -118.68, maxLon: -118.15 };

const FEEDS = [
  { id: 'lapd-news', label: 'LAPD news & alerts', url: 'https://www.lapdonline.org/feed/',
    kind: 'police', at: [34.0522, -118.2437], region: LA_REGION,
    attribution: 'LAPD Online · lapdonline.org' },
];

function stripTag(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function parseRss(xml) {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  return blocks.map((b) => {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? stripTag(m[1]) : '';
    };
    return { title: pick('title'), link: pick('link'), pubDate: pick('pubDate'), desc: pick('description'), guid: pick('guid') };
  });
}

// If the post names an LAPD division, pin it there — that's the real resolution of the
// information. Otherwise fall back to the feed's city centroid.
function locate(text, fallback) {
  const t = text.toLowerCase();
  for (const [name, at] of Object.entries(DIVISIONS)) {
    if (t.includes(name)) return { at, where: name };
  }
  return { at: fallback, where: null };
}

async function fetchFeed(feed, bbox) {
  if (!bboxIntersects(bbox, feed.region)) return [];
  const xml = await getText(feed.url, { headers: BROWSER_UA, timeout: 12_000 });
  const out = [];
  for (const it of parseRss(xml)) {
    if (!it.title) continue;
    const blob = `${it.title} ${it.desc}`;
    const { at, where } = locate(blob, feed.at);
    const [la, lo] = at;
    if (!inBbox(bbox, la, lo)) continue;
    const ts = Date.parse(it.pubDate);
    const k = kindFromText(blob);
    const ev = makeEvent({
      source: feed.id, nativeId: it.guid || it.link || it.title,
      kind: k === 'civic' ? feed.kind : k,
      severity: sevFromText(blob),
      lat: la, lon: lo,
      title: it.title,
      description: (where ? `${where} division · ` : '') + it.desc.slice(0, 200),
      sourceUrl: it.link || feed.url,
      ts: Number.isFinite(ts) ? ts : Date.now(),
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default FEEDS.map((f) => ({
  id: f.id, category: 'incidents', kinds: [f.kind], keyless: true, lag: 'news',
  label: f.label, attribution: f.attribution,
  enabled: () => true,
  fetch: (bbox) => fetchFeed(f, bbox),
}));
