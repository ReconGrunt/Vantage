// city-probe.mjs — dev tool: exercise the Ground/City source adapters directly (no
// server needed) against a few observer locations and print live counts + a sample.
//   node scripts/city-probe.mjs
import { collect, resolveConfig, bboxFromRadius } from '../server/sources/registry.js';

const cfg = resolveConfig();
const SPOTS = [
  { name: 'Seattle', lat: 47.6062, lon: -122.3321 },
  { name: 'San Francisco', lat: 37.7793, lon: -122.4193 },
  { name: 'Washington DC', lat: 38.9072, lon: -77.0369 },
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'New York', lat: 40.7128, lon: -74.0060 },
];

for (const s of SPOTS) {
  const bbox = bboxFromRadius(s.lat, s.lon, 25);
  const [inc, cam] = await Promise.all([collect('incidents', bbox, cfg), collect('cameras', bbox, cfg)]);
  console.log(`\n=== ${s.name} (${s.lat},${s.lon}) ===`);
  console.log(`  incidents: ${inc.items.length}   cameras: ${cam.items.length}`);
  console.log('  incident sources:', inc.sources.map((x) => `${x.id}${x.ok ? '=' + x.count : '✗'}`).join(' '));
  console.log('  camera sources:', cam.sources.map((x) => `${x.id}${x.ok ? '=' + x.count : '✗'}`).join(' '));
  const ex = inc.items[0];
  if (ex) console.log('  sample:', { kind: ex.kind, sev: ex.severity, title: ex.title, at: [ex.lat, ex.lon] });
  const c0 = cam.items[0];
  if (c0) console.log('  cam:', { name: c0.name, still: (c0.still || c0.stream || '').slice(0, 60) });
}
process.exit(0);
