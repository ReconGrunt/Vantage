import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');
const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.liveatc.net/' };
try {
  const r = await fetch('https://s1-bos.liveatc.net/klax_twr', { headers: UA });
  console.log('status', r.status, r.headers.get('content-type'), r.headers.get('icy-name'));
  const reader = r.body.getReader();
  const { value } = await reader.read();
  console.log('first chunk bytes', value?.length);
  reader.cancel();
} catch (e) { console.log('ERR', e.cause?.code || e.message); }
