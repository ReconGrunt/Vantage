// gen-bright-stars.mjs — derive a compact bright-star list for the Roku radar from
// the web app's HYG catalogue (public/data/stars.json). Outputs roku/data/stars_bright.json
// as an array of { ra, dec, mag } (degrees). Run: node tools/gen-bright-stars.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'public', 'data', 'stars.json');
const dataDir = join(here, '..', 'data');
mkdirSync(dataDir, { recursive: true });
const out = join(dataDir, 'stars_bright.json');

const cat = JSON.parse(readFileSync(src, 'utf8'));
const { ra, dec, mag } = cat;

const MAG_LIMIT = 2.8;          // ~120 stars — bright enough to read on a TV radar
const stars = [];
for (let i = 0; i < ra.length; i++) {
  const m = mag[i];
  if (m <= -2 || m > MAG_LIMIT) continue;   // skip the Sun placeholder + faint stars
  stars.push({
    ra: Math.round(ra[i] * 1000) / 1000,
    dec: Math.round(dec[i] * 1000) / 1000,
    mag: Math.round(m * 100) / 100,
  });
}
stars.sort((a, b) => a.mag - b.mag);
writeFileSync(out, JSON.stringify(stars));
console.log(`wrote ${stars.length} bright stars -> ${out}`);
