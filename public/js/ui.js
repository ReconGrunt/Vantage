// ui.js — overlay panel: layer toggles, observer location, clock, object info.

export function initUI({ state, onObserverChange, onLayerToggle, onLabelToggle, onBloomToggle, onWeatherToggle, onGroundToggle, onPathToggle, onLabelFields, onDisplayChange, onNorthChange, onZoom, onSkySpan, onSkyOnly, onGuidesToggle, onBoardToggle, onAutoNorth, onCalibration, onRange, onSatGroupChange, onCatFilter, onBasemap, onRadarRange, onSweep, onRecenter, onPickToggle,
  onCityLayer, onCityCams, onCityHeat, onCityRange, onCityWindow, onCityBasemap, onCityRecenter, onCityPick }) {
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

  // graphics toggles (nav lights + ATC audio are always on, so no UI control)
  const pathEl = $('toggle-path');
  pathEl.checked = state.showPath;
  pathEl.addEventListener('change', () => onPathToggle(pathEl.checked));

  const weatherEl = $('toggle-weather');
  weatherEl.checked = state.weather;
  weatherEl.addEventListener('change', () => onWeatherToggle(weatherEl.checked));

  const groundEl = $('toggle-ground');
  groundEl.checked = state.ground;
  groundEl.addEventListener('change', () => onGroundToggle(groundEl.checked));

  const bloomEl = $('toggle-bloom');
  bloomEl.checked = state.bloom;
  bloomEl.addEventListener('change', () => onBloomToggle(bloomEl.checked));

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

  // aircraft service filter (mil / law / ems / civ) — applies to every view
  const catEls = [...document.querySelectorAll('[data-cat]')];
  for (const el of catEls) {
    el.checked = state.cats?.[el.dataset.cat] !== false;
    el.addEventListener('change', () => {
      const cats = {};
      for (const e of catEls) cats[e.dataset.cat] = e.checked;
      onCatFilter?.(cats);
    });
  }

  // display / projection — ONE menu across all views. The #view-switch button row (top
  // of the panel) is the single view control; #display-mode stays as the canonical value
  // for compatibility. Each panel <section data-view> is shown only in the views it
  // applies to ("all" | "dome" = ceiling/fisheye/free | "radar").
  const displayEl = $('display-mode');
  displayEl.value = state.display;
  const viewBtns = [...document.querySelectorAll('#view-switch [data-mode]')];
  const isDome = (m) => m === 'ceiling' || m === 'fisheye' || m === 'free';

  function updateModeRows() {
    const m = displayEl.value;
    const dome = isDome(m);
    // Section-level: reveal only the sections that apply to this view. Use a class (not
    // inline display) so it composes with the kiosk-slim rule instead of overriding it.
    for (const sec of document.querySelectorAll('#panel [data-view]')) {
      const v = sec.dataset.view;
      const bucket = dome ? 'dome' : m; // 'dome' | 'radar' | 'city'
      const show = v === 'all' || v === bucket;
      sec.classList.toggle('view-off', !show);
    }
    for (const b of viewBtns) b.classList.toggle('active', b.dataset.mode === m);
    // Dome sub-mode rows within the Display / Projection section:
    //   · "Visible sky" span → ceiling only · Ceiling alignment → fisheye only
    //   · Ceiling-shape paint → any projector mode (ceiling or fisheye)
    const projector = m === 'ceiling' || m === 'fisheye';
    $('skyspan-row').style.display = m === 'ceiling' ? '' : 'none';
    const calib = $('calib'); if (calib) calib.style.display = m === 'fisheye' ? '' : 'none';
    const ceilshape = $('ceilshape'); if (ceilshape) ceilshape.style.display = projector ? '' : 'none';
  }
  function selectView(m) {
    displayEl.value = m;
    onDisplayChange(m);
    updateModeRows();
  }
  for (const b of viewBtns) b.addEventListener('click', () => selectView(b.dataset.mode));
  updateModeRows();
  displayEl.addEventListener('change', () => { onDisplayChange(displayEl.value); updateModeRows(); });

  // --- radar (tactical scope) controls: drive the RadarRenderer via callbacks ---
  const rangeSeg = $('rdr-range-seg');
  if (rangeSeg) {
    const syncRange = (nm) => { for (const b of rangeSeg.querySelectorAll('[data-nm]')) b.classList.toggle('active', parseInt(b.dataset.nm, 10) === nm); };
    syncRange(state.radarRangeNm);
    rangeSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nm]'); if (!btn) return;
      const nm = parseInt(btn.dataset.nm, 10);
      syncRange(nm); onRadarRange?.(nm);
    });
  }
  const bmSeg = $('rdr-basemap-seg');
  if (bmSeg) {
    const syncBm = (bm) => { for (const b of bmSeg.querySelectorAll('[data-bm]')) b.classList.toggle('active', b.dataset.bm === bm); };
    syncBm(state.basemap || 'none');
    bmSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bm]'); if (!btn) return;
      syncBm(btn.dataset.bm); onBasemap?.(btn.dataset.bm);
    });
  }
  const sweepCb = $('rdr-sweep-cb');
  if (sweepCb) { sweepCb.checked = state.sweep !== false; sweepCb.addEventListener('change', () => onSweep?.(sweepCb.checked)); }
  $('rdr-recenter-btn')?.addEventListener('click', () => onRecenter?.());
  const pickBtn = $('rdr-pick-btn');
  const setPick = (on) => { if (!pickBtn) return; pickBtn.classList.toggle('active', !!on); pickBtn.textContent = on ? 'Click the map to set…' : 'Pick location on map'; };
  pickBtn?.addEventListener('click', () => setPick(onPickToggle?.()));

  // --- city (ground common-operating-picture) controls ---
  for (const el of document.querySelectorAll('[data-citylayer]')) {
    el.addEventListener('change', () => onCityLayer?.(el.dataset.citylayer, el.checked));
  }
  $('city-cams')?.addEventListener('change', (e) => onCityCams?.(e.target.checked));
  $('city-heat')?.addEventListener('change', (e) => onCityHeat?.(e.target.checked));
  const ctyRangeSeg = $('cty-range-seg');
  if (ctyRangeSeg) {
    const sync = (km) => { for (const b of ctyRangeSeg.querySelectorAll('[data-km]')) b.classList.toggle('active', parseInt(b.dataset.km, 10) === km); };
    ctyRangeSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-km]'); if (!b) return; const km = parseInt(b.dataset.km, 10); sync(km); onCityRange?.(km); });
  }
  const ctyWinSeg = $('cty-window-seg');
  if (ctyWinSeg) {
    const sync = (min) => { for (const b of ctyWinSeg.querySelectorAll('[data-win]')) b.classList.toggle('active', parseInt(b.dataset.win, 10) === min); };
    ctyWinSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-win]'); if (!b) return; const min = parseInt(b.dataset.win, 10); sync(min); onCityWindow?.(min); });
  }
  const ctyBmSeg = $('cty-basemap-seg');
  if (ctyBmSeg) {
    const sync = (bm) => { for (const b of ctyBmSeg.querySelectorAll('[data-bm]')) b.classList.toggle('active', b.dataset.bm === bm); };
    ctyBmSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-bm]'); if (!b) return; sync(b.dataset.bm); onCityBasemap?.(b.dataset.bm); });
  }
  $('cty-recenter-btn')?.addEventListener('click', () => onCityRecenter?.());
  const ctyPickBtn = $('cty-pick-btn');
  const setCityPick = (on) => { if (!ctyPickBtn) return; ctyPickBtn.classList.toggle('active', !!on); ctyPickBtn.textContent = on ? 'Click the map to set…' : 'Pick location on map'; };
  ctyPickBtn?.addEventListener('click', () => setCityPick(onCityPick?.()));

  // ceiling "visible sky" span (how wide a cone of sky fills the disc)
  const spanEl = $('skyspan');
  const spanVal = $('skyspan-val');
  spanEl.value = state.skySpanDeg;
  spanVal.textContent = `${state.skySpanDeg}°`;
  spanEl.addEventListener('input', () => {
    const v = parseInt(spanEl.value, 10);
    spanVal.textContent = `${v}°`;
    onSkySpan(v);
  });

  // aircraft-only (bare-ceiling) projection toggle
  const skyOnlyEl = $('toggle-skyonly');
  skyOnlyEl.checked = !!state.skyOnly;
  skyOnlyEl.addEventListener('change', () => onSkyOnly(skyOnlyEl.checked));

  // guide lines (graticule) + live-sky info box toggles
  const guidesEl = $('toggle-guides');
  guidesEl.checked = state.guides !== false;
  guidesEl.addEventListener('change', () => onGuidesToggle(guidesEl.checked));

  const boardEl = $('toggle-board');
  boardEl.checked = state.board !== false;
  boardEl.addEventListener('change', () => onBoardToggle(boardEl.checked));

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
  // scroll over the dial to nudge the orientation degree-by-degree
  compassEl.addEventListener('wheel', (e) => {
    if (!compassEditable) return;
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1;
    applyBearing((compassBearing + (e.deltaY < 0 ? step : 360 - step)) % 360);
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (!compassEditable) return;
    // Don't hijack the arrow keys while the user is typing in a field (e.g. editing
    // lat/lon) — only nudge the compass when focus isn't in an input control.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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

  // ---- distress box: aircraft currently squawking an emergency, most-severe first ----
  function renderDistress(list) {
    const box = $('distress');
    if (!box) return;
    if (!list || !list.length) { box.hidden = true; return; }
    box.hidden = false;
    $('distress-count').textContent = `${list.length} in range`;
    $('distress-list').innerHTML = list.map((e) => `
      <div class="distress-row">
        <span class="distress-sev" style="color:${e.hex};background:${e.hex}"></span>
        <span class="distress-main">
          <div class="distress-call">${esc(e.callsign)}</div>
          <div class="distress-reason">${esc(e.reason)}${e.type ? ' · ' + esc(e.type) : ''}</div>
        </span>
        <span class="distress-right">
          <div class="distress-code" style="color:${e.hex}">${e.code} ${esc(e.label)}</div>
          <div class="distress-meta">${e.rangeNm.toFixed(0)} NM · ${String(Math.round(e.brgDeg)).padStart(3, '0')}°</div>
        </span>
      </div>`).join('');
  }

  // ---- air-incident log: emergency squawks observed this UTC day (localStorage) ----
  const INCIDENT_KEY = 'incidentLog';
  const todayUTC = () => new Date().toISOString().slice(0, 10);
  const loadIncidents = () => { try { return JSON.parse(localStorage.getItem(INCIDENT_KEY)) || {}; } catch { return {}; } };
  const saveIncidents = (o) => { try { localStorage.setItem(INCIDENT_KEY, JSON.stringify(o)); } catch { /* quota */ } };
  let incidentWindowMin = 60;
  function logIncident(evt) {
    const log = loadIncidents();
    const day = todayUTC();
    const arr = log[day] || (log[day] = []);
    arr.push({ ts: Date.now(), id: evt.id, callsign: evt.callsign, code: evt.code, label: evt.label, sev: evt.sev, hex: evt.hex });
    if (arr.length > 300) arr.splice(0, arr.length - 300);
    const keep = new Set([day, new Date(Date.now() - 864e5).toISOString().slice(0, 10)]);
    for (const k of Object.keys(log)) if (!keep.has(k)) delete log[k];
    saveIncidents(log);
    renderIncidents();
  }
  function renderIncidents() {
    const list = $('incident-list');
    if (!list) return;
    const today = (loadIncidents()[todayUTC()] || []).slice().reverse();
    const cutoff = Date.now() - incidentWindowMin * 60000;
    const shown = today.filter((e) => e.ts >= cutoff);
    $('incident-count').textContent = shown.length ? `${shown.length} today` : 'today';
    if (!shown.length) { list.innerHTML = '<span class="hint">— none logged —</span>'; return; }
    const z = (n) => String(n).padStart(2, '0');
    list.innerHTML = shown.map((e) => {
      const d = new Date(e.ts);
      return `<div class="incident-row">
        <span class="incident-time">${z(d.getUTCHours())}:${z(d.getUTCMinutes())}Z</span>
        <span class="incident-call">${esc(e.callsign)}</span>
        <span class="incident-code" style="color:${e.hex || '#ff5324'}">${e.code} ${esc(e.label)}</span>
      </div>`;
    }).join('');
  }
  const winRow = $('incident-window');
  if (winRow) winRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-win]');
    if (!btn) return;
    incidentWindowMin = parseInt(btn.dataset.win, 10);
    for (const b of winRow.querySelectorAll('[data-win]')) b.classList.toggle('active', b === btn);
    renderIncidents();
  });
  renderIncidents();

  return {
    status,
    renderDistress, logIncident, renderIncidents,
    setObserver: fillLoc,
    // Reflect a programmatic display-mode change (e.g. kiosk ?display=) into the select,
    // the view-switch buttons, AND the per-view section visibility.
    setDisplayMode(m) { displayEl.value = m; updateModeRows(); },
    // Called when the radar map-pick completes so the panel button resets its label.
    resetPick() { setPick(false); },
    resetCityPick() { setCityPick(false); },
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
      if (i.vspeed) add('V/S', i.vspeed);
      if (i.emitter) add('Category', i.emitter);
      if (i.icao24) add('ICAO24', String(i.icao24).toUpperCase());
      if (i.squawkAlert) rows.push(`<div><span>Squawk</span> <b style="color:var(--bad)">${esc(i.squawkAlert)}</b></div>`);
      else if (i.squawk) add('Squawk', i.squawk);
      if (i.phase) add('Phase', i.phase);
      if (i.rangeKm) add('Range', `${Math.round(i.rangeKm)} km`);
      if (i.azimuth != null) add('Azimuth', `${i.azimuth.toFixed(1)}°`);
      // angular height above the horizon — where to point your eyes (NOT altitude)
      if (typeof i.altitude_deg === 'number') add('Above horizon', `${i.altitude_deg.toFixed(1)}°`);
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
  add('circle', { cx: 0, cy: 0, r: 92, fill: 'none', stroke: 'rgba(120,145,165,0.28)', 'stroke-width': 1 });
  for (let d = 0; d < 360; d += 15) {
    const major = d % 90 === 0;
    const a = d * Math.PI / 180;
    const r1 = 92, r2 = major ? 76 : 84;
    add('line', {
      x1: Math.sin(a) * r1, y1: -Math.cos(a) * r1,
      x2: Math.sin(a) * r2, y2: -Math.cos(a) * r2,
      stroke: major ? 'rgba(205,218,228,0.7)' : 'rgba(120,145,165,0.32)', 'stroke-width': major ? 1.6 : 1,
    });
  }
  // North in the amber "attention" accent; the other cardinals stay dim.
  const labels = [['N', 0, '#e8552a'], ['E', 90, '#8a97a3'], ['S', 180, '#8a97a3'], ['W', 270, '#8a97a3']];
  for (const [t, d, c] of labels) {
    const a = d * Math.PI / 180;
    add('text', {
      x: Math.sin(a) * 60, y: -Math.cos(a) * 60 + 6,
      fill: c, 'font-size': 17, 'font-weight': 700, 'text-anchor': 'middle',
      'font-family': 'Inter, system-ui, Arial, sans-serif', 'letter-spacing': '0.5',
    }, t);
  }
}
