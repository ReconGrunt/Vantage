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
