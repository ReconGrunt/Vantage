// gen-assets.mjs — generate every PNG the Roku channel needs, with pure-JS
// pureimage (no native build, no fonts — all on-screen text is SceneGraph Labels).
// Run:  cd roku/tools && npm install && node gen-assets.mjs
import * as PImage from 'pureimage';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const IMG = join(here, '..', 'images');
mkdirSync(IMG, { recursive: true });

const save = (img, name) =>
  PImage.encodePNGToStream(img, createWriteStream(join(IMG, name))).then(() => console.log('wrote', name));

const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a})`;

// soft filled dot: glow ring + mid + bright core
function softDisc(ctx, cx, cy, R, r, g, b, maxA = 1) {
  const rings = [[R, 0.22], [R * 0.7, 0.55], [R * 0.45, maxA]];
  for (const [rr, a] of rings) {
    ctx.fillStyle = rgba(r, g, b, a * maxA);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
  }
}

function ring(ctx, cx, cy, r, w, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.stroke();
}

// draws the radar furniture (disc tint, rings, spokes, centre) into ctx
function drawRadar(ctx, cx, cy, R, { tint = true } = {}) {
  if (tint) {
    ctx.fillStyle = rgba(10, 24, 38, 0.55);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.closePath(); ctx.fill();
  }
  // altitude rings: rim = horizon (alt 0), then alt 30 / 60
  ring(ctx, cx, cy, R, 3, rgba(80, 150, 210, 0.55));
  ring(ctx, cx, cy, R * (1 - 30 / 90), 2, rgba(60, 110, 160, 0.40));
  ring(ctx, cx, cy, R * (1 - 60 / 90), 2, rgba(60, 110, 160, 0.30));
  // spokes every 30 deg
  ctx.strokeStyle = rgba(50, 100, 150, 0.28);
  ctx.lineWidth = 1.5;
  for (let a = 0; a < 360; a += 30) {
    const rad = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(rad), cy - R * Math.cos(rad));
    ctx.stroke();
  }
  softDisc(ctx, cx, cy, 6, 130, 200, 240, 0.9);
}

async function radarBg() {
  const S = 1080, img = PImage.make(S, S), ctx = img.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  drawRadar(ctx, S / 2, S / 2, 470);
  await save(img, 'radar_bg.png');
}

async function sweep() {
  const S = 1080, img = PImage.make(S, S), ctx = img.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const cx = S / 2, cy = S / 2, R = 470;
  // trailing wedge: fan of lines, brightest at the leading edge (angle 0 = up)
  for (let a = -72; a <= 0; a += 1) {
    const rad = a * Math.PI / 180;
    const alpha = 0.42 * ((a + 72) / 72);
    ctx.strokeStyle = rgba(127, 216, 255, alpha);
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(rad), cy - R * Math.cos(rad));
    ctx.stroke();
  }
  // bright leading edge
  ctx.strokeStyle = rgba(180, 235, 255, 0.85);
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - R); ctx.stroke();
  await save(img, 'sweep.png');
}

async function dot() {
  const S = 32, img = PImage.make(S, S), ctx = img.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  softDisc(ctx, S / 2, S / 2, 15, 255, 255, 255, 1);
  await save(img, 'dot.png');
}

async function star() {
  const S = 16, img = PImage.make(S, S), ctx = img.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  softDisc(ctx, S / 2, S / 2, 7, 235, 242, 255, 0.95);
  await save(img, 'star.png');
}

async function selRing() {
  const S = 56, img = PImage.make(S, S), ctx = img.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ring(ctx, S / 2, S / 2, 24, 4, rgba(255, 224, 102, 1));
  await save(img, 'sel_ring.png');
}

async function icon(name, w, h) {
  const img = PImage.make(w, h), ctx = img.getContext('2d');
  ctx.fillStyle = rgba(0, 4, 10, 1);
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42;
  drawRadar(ctx, cx, cy, R);
  // a few sample blips
  const blips = [[40, 0.45, [111, 220, 140]], [-100, 0.7, [127, 216, 255]], [150, 0.3, [255, 194, 51]]];
  for (const [adeg, rr, [r, g, b]] of blips) {
    const rad = adeg * Math.PI / 180, rad2 = R * rr;
    softDisc(ctx, cx + rad2 * Math.sin(rad), cy - rad2 * Math.cos(rad), Math.max(4, R * 0.05), r, g, b, 1);
  }
  await save(img, name);
}

async function splash(name, w, h) {
  const img = PImage.make(w, h), ctx = img.getContext('2d');
  ctx.fillStyle = rgba(0, 4, 10, 1);
  ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.40;
  drawRadar(ctx, cx, cy, R);
  // a soft sweep accent
  for (let a = -72; a <= 0; a += 2) {
    const rad = a * Math.PI / 180, alpha = 0.30 * ((a + 72) / 72);
    ctx.strokeStyle = rgba(127, 216, 255, alpha);
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.sin(rad), cy - R * Math.cos(rad)); ctx.stroke();
  }
  await save(img, name);
}

await radarBg();
await sweep();
await dot();
await star();
await selRing();
await icon('icon_focus_hd.png', 336, 210);
await icon('icon_focus_sd.png', 248, 140);
await icon('channel_poster_540x405.png', 540, 405); // store listing poster (upload in dashboard)
await splash('splash_fhd.png', 1920, 1080);
await splash('splash_hd.png', 1280, 720);
console.log('all assets generated.');
