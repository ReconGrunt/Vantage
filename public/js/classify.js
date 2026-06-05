// classify.js — work out an aircraft's service category and whether it's a
// helicopter, from its operator/owner text, callsign, ICAO24 address, and type.
//
// Categories:  'law' (blue) · 'mil' (green) · 'ems' (red, EMS/fire) · 'civ'

export const CATEGORY = {
  civ: { label: null, color: 0xffffff, emissive: 0x223040, ei: 0.32, trail: 0x9fd8ff },
  law: { label: 'Law enforcement', color: 0x4a90ff, emissive: 0x1e40af, ei: 0.6, trail: 0x6aa8ff },
  mil: { label: 'Military', color: 0x37d67a, emissive: 0x14532d, ei: 0.6, trail: 0x5ef0a0 },
  ems: { label: 'EMS / Fire', color: 0xff5a5a, emissive: 0x7f1d1d, ei: 0.62, trail: 0xff8a8a },
};

const RE_EMS = /\b(fire|lafd|cal[\s-]?fire|ems|med[\s-]?evac|air ambulance|ambulance|life[\s-]?flight|life[\s-]?guard|rescue|mercy air|medical|air methods|phi air|reach|guardian|careflight|care flight|angel|medivac|med[\s-]?trans|airlift)\b/i;
const RE_LAW = /\b(police|sheriff|lapd|nypd|highway patrol|\bchp\b|customs|border patrol|\bcbp\b|homeland|\bfbi\b|\bdea\b|\batf\b|marshal|law enforcement|state patrol|constabulary|gendarmerie|\bpd\b)\b/i;
const RE_MIL = /\b(navy|army|air force|marine|marines|usmc|usaf|\busn\b|national guard|air national guard|department of defen[cs]e|\bdod\b|military|royal air force|\braf\b|coast guard|\buscg\b|air mobility|aviation battalion)\b/i;

// US military ICAO24 (Mode-S) addresses live in 0xADF7C8–0xAFFFFF.
function isUSMilHex(icao24) {
  const n = parseInt(icao24, 16);
  return Number.isFinite(n) && n >= 0xADF7C8 && n <= 0xAFFFFF;
}

export function classify(state, info) {
  const owner = info?.aircraft?.owner || '';
  const airline = info?.route?.airline || '';
  const callsign = state?.callsign || '';
  const text = `${owner} ${airline} ${callsign}`;

  // EMS/fire first (a "fire department police-style" name should read as EMS),
  // then law, then military.
  if (RE_EMS.test(text)) return 'ems';
  if (RE_LAW.test(text)) return 'law';
  if (isUSMilHex(state?.id || '') || RE_MIL.test(text)) return 'mil';
  return 'civ';
}

const RE_HELI_MFR = /helicopter|sikorsky|robinson|eurocopter|airbus helicopters|agusta|leonardo|md helicopters|enstrom|kaman|schweizer|\bbell\b/i;
const RE_HELI_TYPE = /^(EC1?\d|AS3|AS5|R22|R44|R66|B06|B407|B412|B212|B206|B505|B429|S76|S92|S70|UH|AH|MH|CH4|H12|H125|H130|H135|H145|H155|H160|H175|H225|A109|A119|A139|A159|A169|A189|MD5|MD6|MD9|H500|H269|EXEC|GAZL|LYNX|PUMA|R44|R66)/i;

export function isHelicopter(info) {
  const mfr = info?.aircraft?.manufacturer || '';
  const type = (info?.aircraft?.type || '').toUpperCase();
  if (RE_HELI_MFR.test(mfr)) return true;
  if (type && RE_HELI_TYPE.test(type)) return true;
  return false;
}
