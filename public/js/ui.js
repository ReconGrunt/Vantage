// ui.js — overlay panel: layer toggles, observer location, clock, object info.

export function initUI({ state, onObserverChange, onLayerToggle, onLabelToggle, onBloomToggle, onAtcToggle, onNavToggle, onWeatherToggle, onGroundToggle, onLabelFields, onDisplayChange, onNorthChange, onZoom, onAutoNorth, onCalibration, onRange, onSatGroupChange }) {
  const $ = (id) => document.getElementById(id);

  // layer toggles
  for (const name of ['aircraft', 'satellites', 'planets', 'stars']) {
    const el = $(`toggle-${name}`);
    el.checked = state.layers[name];
    el.addEventListener('change', () => onLayerToggle(name, el.checked));
  }

  // label toggles
  for (const name of ['aircraft', 'stars']) {
    const el = $(`label-${name}`);
    el.checked = state.labels[name];
    el.addEventListener('change', () => onLabelToggle(name, el.checked));
  }

  // graphics: nav lights + bloom toggles
  const navEl = $('toggle-navlights');
  navEl.checked = state.navlights;
  navEl.addEventListener('change', () => onNavToggle(navEl.checked));

  const weatherEl = $('toggle-weather');
  weatherEl.checked = state.weather;
  weatherEl.addEventListener('change', () => onWeatherToggle(weatherEl.checked));

  const groundEl = $('toggle-ground');
  groundEl.checked = state.ground;
  groundEl.addEventListener('change', () => onGroundToggle(groundEl.checked));

  const bloomEl = $('toggle-bloom');
  bloomEl.checked = state.bloom;
  bloomEl.addEventListener('change', () => onBloomToggle(bloomEl.checked));

  const atcEl = $('toggle-atc');
  atcEl.checked = !!state.atc;
  atcEl.addEventListener('change', () => onAtcToggle(atcEl.checked));

  // label field chips
  const fieldEls = [...document.querySelectorAll('[data-field]')];
  for (const el of fieldEls) {
    el.checked = !!state.labelFields[el.dataset.field];
    el.addEventListener('change', () => {
      const fields = {};
      for (const e of fieldEls) fields[e.dataset.field] = e.checked;
      onLabelFields(fields);
    });
  }

  // display / projection
  const displayEl = $('display-mode');
  displayEl.value = state.display;
  displayEl.addEventListener('change', () => onDisplayChange(displayEl.value));

  const northEl = $('north');
  const northVal = $('north-val');
  function showNorth(v) { northEl.value = v; northVal.textContent = `${v}°`; }
  showNorth(state.northDeg);
  northEl.addEventListener('input', () => {
    const v = parseInt(northEl.value, 10) || 0;
    northVal.textContent = `${v}°`;
    onNorthChange(v);
  });

  const autoNorthEl = $('toggle-autonorth');
  autoNorthEl.checked = state.autoNorth;
  autoNorthEl.addEventListener('change', () => onAutoNorth(autoNorthEl.checked));

  // zoom (all modes)
  const zoomEl = $('zoom');
  const zoomVal = $('zoom-val');
  zoomEl.value = state.zoom;
  zoomVal.textContent = `${(+state.zoom).toFixed(1)}×`;
  zoomEl.addEventListener('input', () => {
    const z = parseFloat(zoomEl.value);
    zoomVal.textContent = `${z.toFixed(1)}×`;
    onZoom(z);
  });

  // ceiling calibration sliders (fisheye)
  const calib = () => onCalibration({
    offsetX: parseFloat($('cal-offx').value),
    offsetY: parseFloat($('cal-offy').value),
    fov: parseInt($('cal-fov').value, 10),
    mirror: $('cal-mirror').checked,
  });
  const bind = (id, valId, fmt) => {
    const el = $(id), v = $(valId);
    el.addEventListener('input', () => { v.textContent = fmt(el.value); calib(); });
  };
  bind('cal-offx', 'cal-offx-val', (x) => parseFloat(x).toFixed(2));
  bind('cal-offy', 'cal-offy-val', (x) => parseFloat(x).toFixed(2));
  bind('cal-fov', 'cal-fov-val', (x) => `${x}°`);
  $('cal-mirror').addEventListener('change', calib);

  // --- compass rose ---
  buildCompassRose($('compass-ring'));
  const compassEl = $('compass');
  const ringEl = $('compass-ring');
  const readEl = $('compass-read');
  let compassEditable = false;
  let compassBearing = 0;

  function applyBearing(deg) { onNorthChange(deg); }
  function pointerBearing(ev) {
    const r = compassEl.getBoundingClientRect();
    const dx = ev.clientX - (r.left + r.width / 2);
    const dy = ev.clientY - (r.top + r.height / 2);
    return ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360; // 0 at top, clockwise
  }
  let dragging = false;
  compassEl.addEventListener('pointerdown', (e) => {
    if (!compassEditable || e.target.tagName === 'BUTTON') return;
    dragging = true; compassEl.setPointerCapture(e.pointerId);
    applyBearing(Math.round(pointerBearing(e)));
  });
  compassEl.addEventListener('pointermove', (e) => { if (dragging) applyBearing(Math.round(pointerBearing(e))); });
  compassEl.addEventListener('pointerup', (e) => { dragging = false; compassEl.releasePointerCapture?.(e.pointerId); });
  $('compass-minus').addEventListener('click', () => { if (compassEditable) applyBearing((compassBearing + 359) % 360); });
  $('compass-plus').addEventListener('click', () => { if (compassEditable) applyBearing((compassBearing + 1) % 360); });
  window.addEventListener('keydown', (e) => {
    if (!compassEditable) return;
    if (e.key === 'ArrowLeft') applyBearing((compassBearing + 359) % 360);
    if (e.key === 'ArrowRight') applyBearing((compassBearing + 1) % 360);
  });

  $('fullscreen-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
    document.body.classList.toggle('kiosk');
  });

  // satellite group selector
  $('sat-group').value = state.satGroup;
  $('sat-group').addEventListener('change', (e) => onSatGroupChange(e.target.value));

  // aircraft range + unit (miles / km)
  const rangeEl = $('range');
  const rangeVal = $('range-val');
  const miBtn = $('unit-mi'), kmBtn = $('unit-km');
  function showRange() {
    const km = parseInt(rangeEl.value, 10);
    rangeVal.textContent = state.rangeUnit === 'km'
      ? `${km} km` : `${Math.round(km * 0.621371)} mi`;
    miBtn.classList.toggle('active', state.rangeUnit === 'mi');
    kmBtn.classList.toggle('active', state.rangeUnit === 'km');
  }
  rangeEl.value = state.rangeKm;
  showRange();
  rangeEl.addEventListener('input', () => { showRange(); onRange(parseInt(rangeEl.value, 10), state.rangeUnit); });
  miBtn.addEventListener('click', () => { state.rangeUnit = 'mi'; showRange(); onRange(parseInt(rangeEl.value, 10), 'mi'); });
  kmBtn.addEventListener('click', () => { state.rangeUnit = 'km'; showRange(); onRange(parseInt(rangeEl.value, 10), 'km'); });

  // location form
  function fillLoc(o) {
    $('lat').value = o.lat.toFixed(4);
    $('lon').value = o.lon.toFixed(4);
    $('alt').value = Math.round(o.alt || 0);
  }
  fillLoc(state.observer);

  $('loc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lat = parseFloat($('lat').value);
    const lon = parseFloat($('lon').value);
    const alt = parseFloat($('alt').value) || 0;
    if (isFinite(lat) && isFinite(lon)) onObserverChange({ lat, lon, alt });
  });

  $('geo-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return status('Geolocation unavailable');
    status('Locating…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const o = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 10 };
      fillLoc(o); onObserverChange(o); status('Live');
    }, () => status('Location denied'));
  });

  // collapse panel
  $('collapse').addEventListener('click', () => {
    document.body.classList.toggle('panel-collapsed');
  });

  const info = $('info');
  const counts = {
    aircraft: $('count-aircraft'),
    satellites: $('count-satellites'),
    stars: $('count-stars'),
  };

  function status(text) { $('status').textContent = text; }

  return {
    status,
    setObserver: fillLoc,
    setNorth(v) { showNorth(v); },
    setZoom(z) { zoomEl.value = z; zoomVal.textContent = `${(+z).toFixed(1)}×`; },
    setBearing(deg, editable) {
      compassBearing = deg; compassEditable = editable;
      ringEl.style.transform = `rotate(${-deg}deg)`;
      readEl.textContent = `${Math.round(deg)}° ${cardinal(deg)}`;
      compassEl.classList.toggle('editable', editable);
    },
    setCount(layer, n) { if (counts[layer]) counts[layer].textContent = n; },
    tick(date) {
      $('clock').textContent = date.toUTCString().replace('GMT', 'UTC');
    },
    showInfo(data) {
      if (!data || !data.info) { info.classList.remove('show'); return; }
      const i = data.info;
      const rows = [];
      rows.push(`<div class="info-name">${esc(data.name || '')}</div>`);
      rows.push(`<div class="info-type">${esc(i.type || data.kind || '')}</div>`);
      const add = (k, v) => { if (v != null && v !== '') rows.push(`<div><span>${k}</span> ${esc(String(v))}</div>`); };
      if (i.service) add('Service', i.service);
      if (i.airframe) add('Airframe', i.airframe);
      if (i.callsign) add('Callsign', i.callsign);
      if (i.airline) add('Airline', i.airline);
      if (i.from || i.to) add('Route', `${i.from || '?'}  →  ${i.to || '?'}`);
      if (i.aircraftType) add('Type', i.aircraftType);
      if (i.registration) add('Reg', i.registration);
      if (i.owner) add('Operator', i.owner);
      if (i.country) add('Country', i.country);
      if (i.altitude) add('Altitude', i.altitude);
      if (i.speed) add('Speed', i.speed);
      if (i.heading) add('Heading', i.heading);
      if (i.phase) add('Phase', i.phase);
      if (i.rangeKm) add('Range', `${Math.round(i.rangeKm)} km`);
      if (i.azimuth != null) add('Azimuth', `${i.azimuth.toFixed(1)}°`);
      const altv = i.altitude_deg ?? i.altitude;
      if (typeof altv === 'number') add('Elevation', `${altv.toFixed(1)}°`);
      if (data.kind === 'aircraft') {
        rows.push('<div class="info-path"><span style="color:#ffa033">▬ came from</span>'
          + '<span style="color:#49d6ff">going to ▬</span></div>');
      }
      info.innerHTML = rows.join('');
      info.classList.add('show');
    },
  };
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function cardinal(deg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Draw the rotating compass dial: degree ticks + cardinal labels, North in red.
function buildCompassRose(svg) {
  const NS = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, text) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (text != null) el.textContent = text;
    svg.appendChild(el);
    return el;
  };
  add('circle', { cx: 0, cy: 0, r: 92, fill: 'none', stroke: 'rgba(120,150,190,0.35)', 'stroke-width': 2 });
  for (let d = 0; d < 360; d += 15) {
    const major = d % 90 === 0;
    const a = d * Math.PI / 180;
    const r1 = 92, r2 = major ? 76 : 84;
    add('line', {
      x1: Math.sin(a) * r1, y1: -Math.cos(a) * r1,
      x2: Math.sin(a) * r2, y2: -Math.cos(a) * r2,
      stroke: major ? 'rgba(160,190,230,0.8)' : 'rgba(120,150,190,0.4)', 'stroke-width': major ? 2 : 1,
    });
  }
  const labels = [['N', 0, '#ff7b7b'], ['E', 90, '#cfe0f0'], ['S', 180, '#cfe0f0'], ['W', 270, '#cfe0f0']];
  for (const [t, d, c] of labels) {
    const a = d * Math.PI / 180;
    add('text', {
      x: Math.sin(a) * 60, y: -Math.cos(a) * 60 + 6,
      fill: c, 'font-size': 18, 'font-weight': 700, 'text-anchor': 'middle',
      'font-family': 'Inter, Arial, sans-serif',
    }, t);
  }
}
