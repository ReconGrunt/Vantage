// main.js — scene, cinematic rendering, layers, and the live loop.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { buildSky, setPassthrough, updateSky } from './sky.js';
import { StarLayer } from './stars.js';
import { PlanetLayer } from './planets.js';
import { SatelliteLayer } from './satellites.js';
import { AircraftLayer } from './aircraft.js';
import { CloudLayer } from './clouds.js';
import { NavLights } from './navlights.js';
import { FlightBoard } from './flightboard.js';
import { FisheyeDome } from './fisheye.js';
import { loadModels } from './assets.js';
import { DEG } from './coords.js';
import { initUI } from './ui.js';

const state = {
  observer: loadObserver(),
  layers: { aircraft: true, satellites: true, planets: true, stars: true },
  satGroup: 'visual',
  rangeKm: 250,        // aircraft detection radius
  rangeUnit: 'mi',     // display unit for distances
  labels: { aircraft: false, stars: false },
  labelFields: { route: true, type: true, altitude: true, speed: true, heading: false, squawk: false, registration: false, vrate: false },
  bloom: false,        // off by default — the post-process pass flickers on some GPUs
  navlights: true,     // realistic aircraft lighting
  ground: false,       // hard ground disc off — backdrop fades dark below horizon
  weather: true,       // real cloud cover
  autoNorth: false,    // align North from device compass
  display: 'free',     // 'free' | 'ceiling' | 'fisheye'
  northDeg: 0,         // orientation of North for ceiling/fisheye projection
  zoom: 1,             // works in every mode (FOV / fisheye disc scale)
  dome: { offsetX: 0, offsetY: 0, mirror: false, fov: 180 },
};
const now = () => new Date();

// --- renderer ---
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
// XR stays OFF on desktop — enabling it makes the renderer intermittently use a
// stereo eye viewport (clipping the view to part of the screen / flicker) and it
// also conflicts with the post-processing composer. We turn it on only when an
// actual VR session begins.
renderer.xr.enabled = false;
renderer.xr.addEventListener('sessionstart', () => {
  renderer.xr.enabled = true;
  // Passthrough AR (Quest): the session blends with the real world — hide the
  // opaque sky dome + ground so the room shows through, keep the overlays.
  const session = renderer.xr.getSession();
  const ar = session && session.environmentBlendMode && session.environmentBlendMode !== 'opaque';
  if (ar) setPassthrough(skyGroup, true);
});
renderer.xr.addEventListener('sessionend', () => {
  renderer.xr.enabled = false;
  setPassthrough(skyGroup, false);
});

// If the GPU drops our context (heavy load / other apps), recover gracefully
// instead of leaving a black canvas.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const el = document.getElementById('errlog');
  if (el) { el.style.display = 'block'; el.textContent = 'WebGL context lost — restoring…'; }
}, false);
canvas.addEventListener('webglcontextrestored', () => location.reload(), false);

const scene = new THREE.Scene();

// environment map for realistic metal reflections on the planes
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

// --- camera at the centre of the dome ---
// near/far kept to a sane ratio (everything lives within ~1040 units) so the
// depth buffer has enough precision and distant objects don't z-fight/flicker.
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 2, 2600);
camera.position.set(0, 1, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = false;
controls.enableZoom = false;        // we drive FOV with the wheel instead
controls.rotateSpeed = -0.32;
controls.target.set(0, 6, -10);   // start looking ~25° up so the sky fills the view
controls.maxPolarAngle = Math.PI * 0.985;
controls.update();

renderer.domElement.addEventListener('wheel', (e) => {
  state.zoom = THREE.MathUtils.clamp(state.zoom * (e.deltaY < 0 ? 1.08 : 0.926), 0.4, 6);
  applyZoom();
  ui.setZoom(state.zoom);
}, { passive: true });

// --- lighting (driven by the real Sun) ---
const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.5);
scene.add(sunLight);
const ambient = new THREE.AmbientLight(0x4a5a72, 0.6);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0x88a0c0, 0x223044, 0.5);
scene.add(hemi);

const skyGroup = buildSky(scene);

const layers = {
  stars: new StarLayer(scene),
  planets: new PlanetLayer(scene),
  satellites: new SatelliteLayer(scene),
  aircraft: new AircraftLayer(scene),
};

const clouds = new CloudLayer(scene);
const navLights = new NavLights(scene, layers.aircraft.geo);
const flightBoard = new FlightBoard();

// Load the real glTF models once, then hand them to the layers that use them.
loadModels().then((m) => {
  layers.aircraft.setModels(m);
  layers.satellites.setModels?.(m);
});

const fisheye = new FisheyeDome(768);
scene.add(fisheye.cubeCam);

// --- postprocessing (bloom) ---
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Bloom is computed at half resolution — much cheaper, visually identical glow.
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth / 2, window.innerHeight / 2), 0.85, 0.6, 0.10);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// --- picking ---
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 10; // satellites are small Points
const pointer = new THREE.Vector2();
const _viewDir = new THREE.Vector3();
let pinned = null; // selected object's userData

renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
renderer.domElement.addEventListener('click', () => {
  pinned = hoveredData;
  if (pinned?.entry) layers.aircraft.requestEnrich(pinned.entry);
});

let hovered = null;
let hoveredData = null;
function pick() {
  raycaster.setFromCamera(pointer, camera);
  const targets = [];
  if (state.layers.planets) targets.push(...layers.planets.pickables.filter((o) => o.visible));
  if (state.layers.aircraft) targets.push(...layers.aircraft.pickables());
  if (state.layers.satellites && layers.satellites.points) targets.push(layers.satellites.points);
  const hits = raycaster.intersectObjects(targets, true); // recursive: models are groups
  const hit = hits.length ? hits[0] : null;
  hovered = hit ? hit.object : null;

  let data = null;
  if (hit) {
    if (hit.object === layers.satellites.points) {
      data = layers.satellites.pickInfo(hit.index);
    } else {
      let o = hit.object;                          // climb to the object carrying userData
      while (o && !o.userData?.kind) o = o.parent;
      data = o?.userData || null;
      if (data?.entry) layers.aircraft.requestEnrich(data.entry);
    }
  }
  hoveredData = data;
  ui.showInfo(data || pinned);
}

// --- UI ---
const ui = initUI({
  state,
  onObserverChange: (obs) => { state.observer = obs; saveObserver(obs); refreshAircraft(); refreshWeather(); },
  onLayerToggle: (name, on) => { state.layers[name] = on; layers[name].setVisible(on); },
  onLabelToggle: (name, on) => {
    state.labels[name] = on;
    if (name === 'aircraft') layers.aircraft.setLabels(on);
    if (name === 'stars') layers.stars.setLabels(on);
  },
  onBloomToggle: (on) => { state.bloom = on; },
  onNavToggle: (on) => { state.navlights = on; navLights.setVisible(on); },
  onWeatherToggle: (on) => { state.weather = on; clouds.setVisible(on); },
  onGroundToggle: (on) => setGround(on),
  onLabelFields: (fields) => { state.labelFields = fields; layers.aircraft.setLabelFields(fields); },
  onDisplayChange: (mode) => setDisplay(mode),
  onNorthChange: (deg) => { state.northDeg = ((deg % 360) + 360) % 360; },
  onZoom: (z) => { state.zoom = z; applyZoom(); },
  onAutoNorth: (on) => setAutoNorth(on),
  onCalibration: (cal) => {
    Object.assign(state.dome, cal);
    fisheye.setCalibration(state.dome);
    fisheye.setFovDeg(state.dome.fov);
  },
  onRange: (km, unit) => { state.rangeKm = km; state.rangeUnit = unit; refreshAircraft(); },
  onSatGroupChange: async (g) => {
    state.satGroup = g; ui.status(`Loading satellites: ${g}…`);
    const n = await layers.satellites.load(g);
    ui.setCount('satellites', n); ui.status('Live');
  },
});
clouds.setVisible(state.weather);
setGround(state.ground);
layers.aircraft.setLabelFields(state.labelFields);

function setGround(on) {
  state.ground = on;
  const g = skyGroup.getObjectByName('ground');
  if (g) g.visible = on;
}
fisheye.setCalibration(state.dome);
fisheye.setFovDeg(state.dome.fov);

// --- auto-North from the device compass (phones / Quest) ---
let _orientHandler = null;
function setAutoNorth(on) {
  state.autoNorth = on;
  if (on) {
    const start = () => {
      _orientHandler = (e) => {
        // webkitCompassHeading (iOS) is true heading; alpha needs inverting
        const heading = (e.webkitCompassHeading != null)
          ? e.webkitCompassHeading
          : (e.alpha != null ? 360 - e.alpha : null);
        if (heading != null) { state.northDeg = Math.round(heading); ui.setNorth(state.northDeg); }
      };
      window.addEventListener('deviceorientationabsolute', _orientHandler, true);
      window.addEventListener('deviceorientation', _orientHandler, true);
    };
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission().then((p) => { if (p === 'granted') start(); }).catch(() => {});
    } else { start(); }
  } else if (_orientHandler) {
    window.removeEventListener('deviceorientationabsolute', _orientHandler, true);
    window.removeEventListener('deviceorientation', _orientHandler, true);
    _orientHandler = null;
  }
}

// --- display modes (desktop / projector) ---
function setDisplay(mode) {
  state.display = mode;
  controls.enabled = (mode === 'free');
  if (mode === 'free') {
    camera.up.set(0, 1, 0);
    controls.target.set(0, 6, -10); controls.update();
  }
  applyZoom();
}

// Zoom that adapts to the active display: narrows the field of view in the
// perspective modes, magnifies the dome disc in fisheye.
function applyZoom() {
  const z = state.zoom;
  if (state.display === 'fisheye') {
    fisheye.setCalibration({ scale: z });
  } else {
    // Free look at 1x ≈ a natural ~58° human field of view (standing outside,
    // looking up). Aircraft are drawn at true angular size, so this matches what
    // you'd actually see; zoom narrows the FOV to magnify.
    const base = state.display === 'ceiling' ? 125 : 58;
    camera.fov = THREE.MathUtils.clamp(base / z, 8, 135);
    camera.updateProjectionMatrix();
  }
}

for (const k of Object.keys(state.layers)) layers[k].setVisible(state.layers[k]);

// --- data ---
async function refreshAircraft() {
  const r = await layers.aircraft.poll(state.observer, state.rangeKm);
  if (r) ui.setCount('aircraft', r.count);
}
async function refreshWeather() {
  try {
    const w = await (await fetch(`/api/weather?lat=${state.observer.lat}&lon=${state.observer.lon}`)).json();
    clouds.setWeather(w);
  } catch { /* keep last */ }
}
async function initData() {
  ui.status('Loading stars…');
  ui.setCount('stars', await layers.stars.load());
  ui.status('Loading satellites…');
  ui.setCount('satellites', await layers.satellites.load(state.satGroup));
  ui.status('Loading aircraft…');
  await refreshAircraft();
  refreshWeather();
  ui.status('Live');
}
initData();
setInterval(refreshAircraft, 12_000);
setInterval(refreshWeather, 10 * 60_000);

// --- render loop ---
let lastPick = 0, lastPump = 0, lastBoard = 0, lastTick = 0;
renderer.setAnimationLoop((t) => {
  const d = now();
  const elapsed = t * 0.001;

  if (state.layers.stars) layers.stars.update(state.observer, d, elapsed);
  layers.planets.update(state.observer, d); // always (drives sun light)
  if (state.layers.satellites) layers.satellites.update(state.observer, d);
  layers.aircraft.ceilingMode = state.display !== 'free'; // low-flyover drama overhead
  if (state.layers.aircraft) layers.aircraft.update(state.observer, t);
  navLights.setVisible(state.navlights && state.layers.aircraft);
  if (state.navlights && state.layers.aircraft) {
    const night = THREE.MathUtils.clamp(-layers.planets.sunAltitude / 8, 0, 1);
    const cloud = state.weather ? clouds.currentCoverage : 0;
    navLights.update(layers.aircraft.planes, elapsed, night, cloud);
  }

  // sun-driven lighting
  const sunDir = layers.planets.sunDir;
  const a = layers.planets.sunAltitude;
  sunLight.position.copy(sunDir).multiplyScalar(2000);
  const day = THREE.MathUtils.clamp((a + 6) / 12, 0, 1); // fade across twilight
  sunLight.intensity = 0.15 + day * 1.7;
  ambient.intensity = 0.35 + day * 0.5;
  hemi.intensity = 0.25 + day * 0.5;
  renderer.toneMappingExposure = 0.85 + day * 0.35;

  // realistic sky colour, weather clouds, and matching star visibility
  const cover = state.weather ? clouds.currentCoverage : 0;
  updateSky(skyGroup, sunDir, a, cover * 0.7);
  if (state.layers.stars) layers.stars.setSky(a, cover);
  if (state.weather) clouds.update(elapsed, sunDir, a);

  if (state.display !== 'fisheye' && t - lastPick > 90) { pick(); lastPick = t; }
  if (t - lastPump > 500) { layers.aircraft.pump(3); lastPump = t; }
  if (t - lastBoard > 3000) {
    const ac = layers.aircraft.overheadReport(state.observer);
    const sats = state.layers.satellites ? layers.satellites.overheadReport(state.observer, d) : [];
    flightBoard.render({ overhead: ac.overhead, inbound: ac.inbound, sats }, d, state.rangeUnit);
    lastBoard = t;
  }
  if (t - lastTick > 1000) { flightBoard.tick(); lastTick = t; }

  // compass: in free look it shows where you're facing; in ceiling/fisheye it
  // shows (and lets you fine-tune) the bearing placed at the top of the image.
  if (state.display === 'free') {
    camera.getWorldDirection(_viewDir);
    const az = (Math.atan2(_viewDir.x, -_viewDir.z) * 180 / Math.PI + 360) % 360;
    ui.setBearing(az, false);
  } else {
    ui.setBearing(state.northDeg, true);
  }

  // camera orientation per display mode
  if (state.display === 'ceiling') {
    const nr = state.northDeg * DEG;
    camera.up.set(Math.sin(nr), 0, -Math.cos(nr)); // chosen compass dir at screen top
    camera.position.set(0, 1, 0);
    camera.lookAt(0, 2, 0);                          // straight up at the ceiling
  } else if (state.display === 'free') {
    controls.update();
  }

  // render
  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera);
  } else if (state.display === 'fisheye') {
    fisheye.setNorth(state.northDeg * DEG);
    fisheye.render(renderer, scene);
  } else if (state.bloom) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
  ui.tick(d);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloom.setSize(window.innerWidth / 2, window.innerHeight / 2);
  fisheye.setSize(window.innerWidth, window.innerHeight);
});
fisheye.setSize(window.innerWidth, window.innerHeight);

// XR entry buttons: VR (full dome) + AR (Quest passthrough overlay)
document.body.appendChild(VRButton.createButton(renderer));
document.body.appendChild(ARButton.createButton(renderer, {
  optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
}));

// Kiosk / projector auto-launch via URL, e.g. ?display=fisheye&north=90&kiosk
{
  const params = new URLSearchParams(location.search);
  const m = params.get('display');
  if (['free', 'ceiling', 'fisheye'].includes(m)) {
    state.display = m; setDisplay(m);
    const sel = document.getElementById('display-mode'); if (sel) sel.value = m;
  }
  if (params.has('north')) {
    const v = parseInt(params.get('north'), 10) || 0;
    state.northDeg = v;
    const r = document.getElementById('north'); if (r) r.value = v;
    const lbl = document.getElementById('north-val'); if (lbl) lbl.textContent = `${v}°`;
  }
  if (params.has('kiosk')) document.body.classList.add('kiosk');
  const plat = parseFloat(params.get('lat'));
  const plon = parseFloat(params.get('lon'));
  if (isFinite(plat) && isFinite(plon)) {
    state.observer = { lat: plat, lon: plon, alt: parseFloat(params.get('alt')) || 10 };
    ui.setObserver(state.observer);
    refreshAircraft(); refreshWeather();
  }
}

// --- observer persistence ---
function loadObserver() {
  try {
    const s = JSON.parse(localStorage.getItem('observer'));
    if (s && isFinite(s.lat) && isFinite(s.lon)) return s;
  } catch { /* ignore */ }
  return { lat: 40.7128, lon: -74.0060, alt: 10 };
}
function saveObserver(o) { localStorage.setItem('observer', JSON.stringify(o)); }

if (!localStorage.getItem('observer') && navigator.geolocation) {
  navigator.geolocation.getCurrentPosition((pos) => {
    const obs = { lat: pos.coords.latitude, lon: pos.coords.longitude, alt: pos.coords.altitude || 10 };
    state.observer = obs; saveObserver(obs); ui.setObserver(obs); refreshAircraft();
  }, () => {}, { timeout: 8000 });
}
