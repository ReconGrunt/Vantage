// Build a compact star catalog for the frontend from the HYG database CSV.
// Keeps naked-eye stars (mag <= 6.5) with RA/Dec, magnitude, and B-V colour.
// Named bright stars are kept separately for labels.
//
// Usage:  node scripts/build-stars.mjs stars_raw.csv public/data/stars.json

import fs from 'node:fs';

const [, , inPath = 'stars_raw.csv', outPath = 'public/data/stars.json'] = process.argv;
const MAG_LIMIT = 6.5;

const text = fs.readFileSync(inPath, 'utf8');
const lines = text.split(/\r?\n/);
const header = parseCsvLine(lines[0]);
const col = Object.fromEntries(header.map((h, i) => [h.replace(/"/g, ''), i]));

const ra = [], dec = [], mag = [], ci = [];
const named = [];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;
  const f = parseCsvLine(line);
  const m = parseFloat(f[col.mag]);
  if (!isFinite(m) || m > MAG_LIMIT) continue;
  const raDeg = parseFloat(f[col.ra]) * 15; // hours -> degrees
  const decDeg = parseFloat(f[col.dec]);
  if (!isFinite(raDeg) || !isFinite(decDeg)) continue;
  const bv = parseFloat(f[col.ci]);

  ra.push(round(raDeg, 3));
  dec.push(round(decDeg, 3));
  mag.push(round(m, 2));
  ci.push(isFinite(bv) ? round(bv, 2) : 0.6);

  const proper = (f[col.proper] || '').replace(/"/g, '').trim();
  if (proper && m <= 3.6) {
    named.push({ ra: round(raDeg, 3), dec: round(decDeg, 3), mag: round(m, 2), name: proper });
  }
}

const out = { count: ra.length, magLimit: MAG_LIMIT, ra, dec, mag, ci, named };
fs.mkdirSync(outPath.replace(/[^/\\]+$/, ''), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${ra.length} stars (${named.length} named) -> ${outPath}`);
console.log(`File size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);

function round(n, d) { const p = 10 ** d; return Math.round(n * p) / p; }

// Minimal CSV line parser (handles quoted fields; HYG has quoted strings).
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}
