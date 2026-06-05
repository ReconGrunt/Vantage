// airlines.js — map an aircraft's callsign to its operator's signature livery
// colour (by ICAO airline designator = the first 3 letters of the callsign).
// Used to give each aircraft a small brand-coloured "logo light" accent.

const COLORS = {
  UAL: 0x3b7dd8, AAL: 0xd1002a, DAL: 0xc01933, SWA: 0xf9b612, JBU: 0x1267b6,
  ASA: 0x2a6ebb, SKW: 0x7d93a6, FFT: 0x0a7d4b, NKS: 0xffe600, HAL: 0x6a2d91,
  ACA: 0xd0202e, WJA: 0x0f6cbd, AMX: 0x103a8c, VOI: 0xb01c8c, JZA: 0xd0202e,
  BAW: 0x2356a8, VIR: 0xe10a0a, DLH: 0xf2c200, AFR: 0x12407f, KLM: 0x00a1de,
  IBE: 0xd00f31, EIN: 0x0a7d4b, RYR: 0xf1c933, EZY: 0xff6600, NOZ: 0xd0202e,
  SAS: 0x0f3e7a, FIN: 0x0b1f8f, TAP: 0x0aa84f, SWR: 0xd0202e, AUA: 0xd0202e,
  UAE: 0xd71921, QTR: 0x6a0a32, ETD: 0xbd8b13, SIA: 0xf0a500, THY: 0xc8102e,
  ANA: 0x1d3faf, JAL: 0xc8102e, KAL: 0x1a6fb0, CPA: 0x006564, EVA: 0x0a7d4b,
  QFA: 0xe0001b, ANZ: 0x202a36, CES: 0x1356a0, CCA: 0xc8102e, CSN: 0x12519b,
  FDX: 0xff6600, UPS: 0xffb500, GTI: 0x274b78, CLX: 0xf0a500, ABX: 0x4060a0,
};

const _cache = new Map();

// Returns {r,g,b} (0..1) for the airline, or null if unknown.
export function liveryColor(callsign) {
  const code = (callsign || '').trim().slice(0, 3).toUpperCase();
  if (!code || !/^[A-Z]{3}$/.test(code)) return null;
  if (_cache.has(code)) return _cache.get(code);
  const hex = COLORS[code];
  let out = null;
  if (hex != null) {
    out = { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
  }
  _cache.set(code, out);
  return out;
}
