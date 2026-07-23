// emergency.js — transponder emergency squawks as ONE shared taxonomy (severity,
// colour, plain-language reason). Imported by the dome aircraft layer, the radar
// scope, the info panels, and the distress box so "in distress" reads identically
// everywhere. Ordered most-severe first. (This shared-taxonomy pattern is also how
// future LiveWorld ground categories — crime types, incident classes — will plug in.)

export const EMERGENCY = {
  7500: { code: '7500', sev: 1.0,  color: 0xff2a2a, hex: '#ff2a2a', label: 'HIJACK',     reason: 'Unlawful interference' },
  7700: { code: '7700', sev: 0.85, color: 0xff5324, hex: '#ff5324', label: 'EMERGENCY',  reason: 'General emergency' },
  7600: { code: '7600', sev: 0.5,  color: 0xffd11e, hex: '#ffd11e', label: 'RADIO FAIL', reason: 'Lost communications' },
};

// Look up the emergency descriptor for a squawk (string or number), or null.
export function emergencyFor(squawk) {
  if (squawk == null || squawk === '') return null;
  return EMERGENCY[String(squawk).trim()] || null;
}

// --- Ground / City domain taxonomy ------------------------------------------------
// The promised ground categories: one kind -> { label, hex, glyph } table so the city
// map, its event list, the detail panel and the city-incident log all render "what kind
// of thing is happening" identically — exactly how EMERGENCY unifies air distress.
// Colours obey the shared C2 palette (teal = live, amber = attention held for selection).
export const GROUND_KIND = {
  fire:            { label: 'Fire',     hex: '#FF6A2C', glyph: 'F' },
  medical:         { label: 'Medical',  hex: '#FF3D71', glyph: '+' },
  police:          { label: 'Police',   hex: '#36C6E0', glyph: 'P' },
  traffic:         { label: 'Traffic',  hex: '#FFB020', glyph: 'T' },
  hazard:          { label: 'Hazard',   hex: '#E8552A', glyph: '!' },
  quake:           { label: 'Quake',    hex: '#B07CFF', glyph: '~' },
  weather:         { label: 'Weather',  hex: '#5AA9FF', glyph: '*' },
  'fire-wildland': { label: 'Wildfire', hex: '#FF8A00', glyph: 'W' },
  social:          { label: 'Social',   hex: '#7C5CFF', glyph: 'S' },
  civic:           { label: 'Civic',    hex: '#8A97A3', glyph: 'i' },
  outage:          { label: 'Outage',   hex: '#FFD166', glyph: 'O' },
  camera:          { label: 'Camera',   hex: '#21D3C9', glyph: '#' },
};

export function groundKind(kind) {
  return GROUND_KIND[kind] || GROUND_KIND.civic;
}

// Severity 0..3 -> label, for the detail panel / list. Mirrors the air severity ramp idea.
export const GROUND_SEVERITY = ['INFO', 'MINOR', 'MODERATE', 'MAJOR'];
