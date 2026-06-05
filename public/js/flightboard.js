// flightboard.js — airport-terminal "split-flap" board at the bottom of screen.
// Passively shows what's overhead now and coming over soon (so you don't have to
// click tiny aircraft), plus a separate SATELLITES section. Amber-on-black fixed
// monospace columns, with live ticking countdowns. Distances honour the chosen
// unit (miles / km).

const CAT_CLASS = { law: 'fb-law', mil: 'fb-mil', ems: 'fb-ems', civ: '' };

export class FlightBoard {
  constructor() {
    this.el = document.getElementById('flightboard');
    this.maxRows = 5;
  }

  setVisible(v) { if (this.el) this.el.style.display = v ? 'block' : 'none'; }

  // data: { overhead:[], inbound:[], sats:[] }   unit: 'mi' | 'km'
  render(data, dateUTC, unit = 'mi') {
    if (!this.el) return;
    const time = dateUTC.toUTCString().slice(17, 25);
    const u = unit;

    const head = `
      <div class="fb-titlebar">
        <span class="fb-brand">✈ LIVELYSKY · LIVE SKY</span>
        <span class="fb-clock">${time} UTC</span>
      </div>
      <div class="fb-colhead">
        <span>FLIGHT</span><span>TYPE</span><span>ROUTE</span><span>ALT</span><span>SPD</span><span>DIST</span><span>STATUS</span>
      </div>`;

    // DIRECTLY OVERHEAD (+ pin the closest/lowest one at the bottom)
    let overheadRows;
    if (!data.overhead.length) {
      overheadRows = `<div class="fb-empty">— none —</div>`;
    } else {
      const rows = data.overhead.slice(0, this.maxRows)
        .map((f) => acRow(f, `OVERHEAD`, 'fb-now', u)).join('');
      let closest = '';
      if (data.overhead.length > 1) {
        const c = data.overhead.reduce((a, b) => (b.distM < a.distM ? b : a));
        closest = acRow(c, `★ CLOSEST · ${distLabel(c.distM, u)}`, 'fb-closest', u);
      }
      overheadRows = rows + closest;
    }

    const inboundRows = data.inbound.length
      ? data.inbound.slice(0, this.maxRows).map((f) => acRow(f, cd(f.etaMin * 60), 'fb-soon', u)).join('')
      : `<div class="fb-empty">— none —</div>`;

    const satRows = (data.sats && data.sats.length)
      ? data.sats.slice(0, this.maxRows).map(satRow).join('')
      : `<div class="fb-empty">— none above —</div>`;

    this.el.innerHTML = head
      + `<div class="fb-sectlabel">DIRECTLY OVERHEAD</div>${overheadRows}`
      + `<div class="fb-sectlabel">PASSING OVER SOON</div>${inboundRows}`
      + `<div class="fb-sectlabel fb-sat">🛰 SATELLITES OVERHEAD</div>${satRows}`;
  }

  // update just the countdown spans every second (cheap, no recompute)
  tick() {
    if (!this.el) return;
    const now = Date.now();
    this.el.querySelectorAll('.fb-cd').forEach((el) => {
      const rem = Math.round((+el.dataset.cd - now) / 1000);
      el.textContent = rem <= 0 ? 'NOW' : fmtClock(rem);
    });
  }
}

function acRow(f, status, statusCls, unit) {
  const fl = altLabel(f.altM);
  const arrow = f.vRate > 1.5 ? '▲' : f.vRate < -1.5 ? '▼' : '';
  const route = (f.from || f.to) ? `${pad(f.from || '???', 3)}→${pad(f.to || '???', 3)}` : '·····';
  const type = f.isHeli ? (f.type || 'HELI') : (f.type || '----');
  return `<div class="fb-row ${CAT_CLASS[f.category] || ''}">
    <span class="fb-flight">${esc(f.callsign)}</span>
    <span class="fb-type">${esc(type)}</span>
    <span class="fb-route">${esc(route)}</span>
    <span class="fb-alt">${fl}${arrow}</span>
    <span class="fb-spd">${f.spdKt}</span>
    <span class="fb-dist">${distLabel(f.distM, unit)}</span>
    <span class="fb-status ${statusCls}">${status}</span>
  </div>`;
}

function satRow(s) {
  const status = s.rising
    ? `PEAK ${cd(s.peakSec)}`
    : `<span class="fb-now">OVERHEAD</span>`;
  return `<div class="fb-row fb-satrow">
    <span class="fb-flight">${esc(s.name)}</span>
    <span class="fb-type">${Math.round(s.elevation)}°</span>
    <span class="fb-route">ORBIT</span>
    <span class="fb-alt">${Math.round(s.heightKm)}km</span>
    <span class="fb-spd">${(s.speedKmS || 0).toFixed(1)}</span>
    <span class="fb-dist"></span>
    <span class="fb-status">${status}</span>
  </div>`;
}

// a live countdown span (target stamped now; FlightBoard.tick keeps it ticking)
function cd(sec) {
  const target = Date.now() + sec * 1000;
  return `<span class="fb-cd fb-soon" data-cd="${target}">${fmtClock(sec)}</span>`;
}

function altLabel(m) {
  if (m == null) return '-----';
  const ft = m * 3.281;
  if (ft >= 17500) return `FL${Math.round(ft / 100)}`;
  return `${(Math.round(ft / 100) * 100).toLocaleString()}`;
}
function distLabel(m, unit) {
  if (m == null) return '';
  return unit === 'km' ? `${(m / 1000).toFixed(1)}km` : `${(m / 1609.34).toFixed(1)}mi`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function pad(s, n) { return (s + '   ').slice(0, n); }
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
