const UA = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.liveatc.net/' };
const url = 'https://s1-bos.liveatc.net/klax_twr';
console.time('headers');
const r = await fetch(url, { headers: UA });
console.timeEnd('headers');
console.log('status', r.status, 'ct', r.headers.get('content-type'), 'icy', r.headers.get('icy-name'));
const reader = r.body.getReader();
let total = 0, chunks = 0;
const t0 = Date.now();
while (Date.now() - t0 < 4000) {
  const { done, value } = await reader.read();
  if (done) { console.log('stream ended'); break; }
  total += value.length; chunks++;
}
reader.cancel();
console.log('got', total, 'bytes in', chunks, 'chunks over ~4s');
