// pulsepoint.js — OPT-IN, DEFAULT OFF. PulsePoint publishes live fire/EMS incidents in
// the clear via its own web viewer; the payload is AES-CBC (CryptoJS passphrase form).
// This decrypts it exactly as the public web app does — no auth bypass, same data any
// visitor sees. Enabled only when VANTAGE_ENABLE_PULSEPOINT=1 AND agency IDs are given
// (VANTAGE_PULSEPOINT_AGENCIES="1234,5678"); find an agency_id in the web app's URL.
//
// Place/event-centric: incident type + location only; no units/personnel are mapped.

import crypto from 'node:crypto';
import { getJson } from '../_http.js';
import { makeEvent, inBbox, numOrNull } from '../types.js';

// OpenSSL EVP_BytesToKey (MD5) — how CryptoJS derives a key from a passphrase + salt.
function evpKey(pass, salt, keyLen) {
  let key = Buffer.alloc(0), block = Buffer.alloc(0);
  while (key.length < keyLen) {
    const h = crypto.createHash('md5');
    h.update(Buffer.concat([block, Buffer.from(pass, 'utf8'), salt]));
    block = h.digest();
    key = Buffer.concat([key, block]);
  }
  return key.subarray(0, keyLen);
}

// The passphrase is assembled from "CommonIncidents" exactly as PulsePoint's obfuscated
// client does — encoded as logic (not a copied literal) so it tracks their scheme.
function passphrase() {
  const t = 'CommonIncidents';
  return t[13] + t[1] + t[2] + 'brady' + '5' + 'r' + t[11] + t[1] + t[12] + t[5] + 'gattai';
}

function decrypt(payload) {
  const salt = Buffer.from(payload.s, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const ct = Buffer.from(payload.ct, 'base64');
  const key = evpKey(passphrase(), salt, 32);
  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const out = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
  return JSON.parse(JSON.parse(out)); // double-encoded JSON string in their payload
}

function callSeverity(type = '') {
  const t = type.toLowerCase();
  if (/structure fire|working fire|explosion|rescue|hazmat|cardiac|traffic collision.*inj/.test(t)) return 3;
  if (/fire|medical|traffic|alarm/.test(t)) return 2;
  return 1;
}

async function fetchAgency(agencyId, bbox) {
  const d = await getJson(`https://web.pulsepoint.org/DB/giba.php?agency_id=${encodeURIComponent(agencyId)}`);
  if (!d?.ct) return [];
  const decoded = decrypt(d);
  const active = decoded?.incidents?.active || [];
  const out = [];
  for (const inc of active) {
    const la = numOrNull(inc.Latitude), lo = numOrNull(inc.Longitude);
    if (la == null || lo == null || !inBbox(bbox, la, lo)) continue;
    const type = inc.PulsePointIncidentCallType || inc.CallType || 'Incident';
    const kind = /med|ems|cardiac|sick/i.test(type) ? 'medical' : 'fire';
    const ts = Date.parse(inc.CallReceivedDateTime) || Date.now();
    const ev = makeEvent({
      source: `pulsepoint:${agencyId}`, nativeId: inc.ID || `${la},${lo},${ts}`,
      kind, severity: callSeverity(type), lat: la, lon: lo,
      title: type, description: inc.FullDisplayAddress || inc.AddressCity || '',
      sourceUrl: 'https://web.pulsepoint.org', ts, raw: null,
    });
    if (ev) out.push(ev);
  }
  return out;
}

export default [{
  id: 'pulsepoint', category: 'incidents', kinds: ['fire', 'medical'], keyless: true,
  optin: true, attribution: 'PulsePoint (in-the-clear · place-only)', label: 'PulsePoint fire/EMS',
  enabled: (cfg) => !!cfg?.enablePulsepoint && (cfg?.pulsepointAgencies?.length > 0),
  fetch: (bbox, cfg) =>
    Promise.all((cfg?.pulsepointAgencies || []).map((a) => fetchAgency(a, bbox).catch(() => [])))
      .then((x) => x.flat()),
}];
