// SoCal-focused LiveATC discovery so the "local towers on the horizon" feature
// has real, nearby feeds for an LA user. Prints verified host+mount+name.
const MOUNTS = [
  'klax_twr','klax_gnd','klax_app','ksocal_app','ksocal1_app','ksocal2_app',
  'ksocal3_app','ksocal4_app','ksocal5_app','kbur_twr','kbur_gnd','kvny_twr',
  'ksmo_twr','klgb_twr','ksna_twr','ksna_gnd','kont_twr','kpoc','kemt','khhr',
  'kful','kcno','ksbd_twr','kpsp_twr','ksba_twr','kvbg','klgb_gnd',
];
const HOSTS = [
  's1-bos','s1-fmt2','s1-sjc','s1-chi','s1-dfw','s1-mia','s1-phx','s1-iah',
  's1-atl','s1-sea','s1-lax','s1-sfo','s1-las','s1-den','s1-san','s1-bur',
];
const UA = { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.liveatc.net/' } };

async function probe(mount) {
  for (const h of HOSTS) {
    const url = `https://${h}.liveatc.net/${mount}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { ...UA, signal: ctrl.signal });
      clearTimeout(t);
      const ct = r.headers.get('content-type') || '';
      const name = r.headers.get('icy-name') || '';
      try { await r.body?.cancel(); } catch {}
      if (r.ok && ct.includes('audio')) return { mount, host: h, name };
    } catch {}
  }
  return { mount, host: null };
}

const results = await Promise.all(MOUNTS.map(probe));
for (const r of results) if (r.host) console.log(`OK  ${r.mount.padEnd(14)} ${r.host.padEnd(8)} ${r.name}`);
console.log('MISS:', results.filter(r => !r.host).map(r => r.mount).join(' '));
