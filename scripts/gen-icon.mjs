// Generates src-tauri/assets/vantage.png (1024x1024) — the Vantage reticle mark:
// a dark disc with teal concentric rings, a fine crosshair, and a small aircraft triangle.
// Dependency-free (manual RGBA PNG encoder) so it runs anywhere Node does. Feed the output
// to `tauri icon` to produce the full src-tauri/icons/ set (.ico + PNGs).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const S = 1024;
const cx = S / 2, cy = S / 2;

// palette (C2 theme: teal = live)
const BG = [10, 15, 20];          // near-black
const TEAL = [45, 212, 191];      // live teal
const TEAL_DIM = [30, 120, 110];

const buf = Buffer.alloc(S * S * 4);

// smoothstep coverage in [edge0, edge1]
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const blend = (base, over, a) => [
  Math.round(base[0] + (over[0] - base[0]) * a),
  Math.round(base[1] + (over[1] - base[1]) * a),
  Math.round(base[2] + (over[2] - base[2]) * a),
];

// aircraft triangle (pointing up), returns coverage 0/1 for point (x,y)
function inTriangle(x, y) {
  const h = 120, w = 92;
  const ax = cx, ay = cy - h * 0.55;               // nose
  const bx = cx - w / 2, by = cy + h * 0.45;       // left tail
  const dx = cx + w / 2, dy = cy + h * 0.45;       // right tail
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, dx, dy);
  const d3 = sign(x, y, dx, dy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const dx = x - cx, dy = y - cy;
    const r = Math.hypot(dx, dy);

    // disc background with a soft edge + faint rim
    const discA = smooth(S * 0.5, S * 0.485, r);          // 1 inside, 0 outside
    if (discA <= 0) { buf[i + 3] = 0; continue; }
    let col = BG.slice();

    // faint outer rim
    const rimA = (1 - Math.abs(r - S * 0.47) / 8);
    if (rimA > 0) col = blend(col, TEAL_DIM, Math.min(1, rimA) * 0.5);

    // concentric rings
    for (const [rad, wdt, alpha] of [
      [S * 0.40, 7, 0.95],
      [S * 0.28, 6, 0.8],
      [S * 0.16, 5, 0.65],
    ]) {
      const a = (1 - Math.abs(r - rad) / wdt);
      if (a > 0) col = blend(col, TEAL, Math.min(1, a) * alpha);
    }

    // crosshair (with a center gap and stopping at the outer ring), plus edge ticks
    const arm = Math.abs(dx) < 3 || Math.abs(dy) < 3;
    if (arm && r > S * 0.06 && r < S * 0.44) {
      col = blend(col, TEAL, 0.85);
    }

    // aircraft triangle at center
    if (inTriangle(x, y)) col = blend(col, TEAL, 0.95);

    const a255 = Math.round(discA * 255);
    buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = a255;
  }
}

// ---- minimal PNG (RGBA, 8-bit) encoder ----
function crc32(bytes) {
  let c = ~0;
  for (let n = 0; n < bytes.length; n++) {
    c ^= bytes[n];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// raw scanlines: 1 filter byte (0) per row + RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'assets');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'vantage.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${(png.length / 1024).toFixed(0)} KB)`);
