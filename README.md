# LivelySky

A live planetarium dome that projects the **real sky above your location** — aircraft,
satellites, planets, the Sun and the Moon — each placed at its true azimuth and
altitude. Everything is sourced from **free, no-key data** and respects the actual
object in flight (real callsigns, real NORAD objects, real ephemerides).

Built as a Three.js + WebXR web app so the same code runs on a projector
(Chromium kiosk), in a browser, and in **Oculus / WebXR** headsets. Apple TV
packaging and a native Roku port are the next platform steps.

## Tech stack — and why it's the right one

| Concern | Choice | Why |
|--------|--------|-----|
| Rendering | **Three.js (WebGL2)** | Mature, fast, direct control of the real-time render loop. The whole app is one continuous draw loop over thousands of points + dozens of meshes — exactly what a thin WebGL layer is best at. |
| XR | **WebXR** (built into Three.js) | One codebase gives desktop, projector, **and Oculus/Quest VR + passthrough AR** for free. No native VR rewrite. |
| App code | **Vanilla ES modules** | No framework. A 60 fps render loop driving imperative GPU state gets nothing from React/Vue's diffing — they'd only add overhead and indirection. Modules keep it organised without a build step. |
| Backend | **Node + Express** (tiny proxy) | Only job is to proxy/cache the free APIs (CORS + rate limits). Stateless and ~250 lines. |
| Data | OpenSky · CelesTrak (SGP4 via `satellite.js`) · `astronomy-engine` · Open-Meteo · adsbdb · HYG | All free, mostly no-key; orbital + ephemeris math runs locally. |
| Deps | CDN import-map (`three`, `satellite.js`, `astronomy-engine`) | Zero bundler; instant load; trivial to pin versions. |

**Verdict: no rewrite needed.** This is already the optimal stack for "one web codebase → screen + projector + Quest." The alternatives are worse fits here:
- *React / react-three-fiber* — declarative reconciliation fights a manual render loop; pure overhead.
- *Unity / Unreal* — great native graphics but can't run in a browser/kiosk, huge runtime, and throws away the free WebXR path.
- *CesiumJS* — built for a geospatial globe, not a from-the-ground sky dome.
- *Babylon.js* — peer of Three.js; switching buys nothing.

Optional future polish (not required): add **Vite + TypeScript** for build-time bundling and types — a tooling upgrade, not an architecture change.

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

On first load it asks for your location (or defaults to New York). You can also
type a lat/lon/altitude in the panel.

- **Drag** to look around the dome · **scroll** to zoom (telescope-style FOV).
- Toggle the **Aircraft / Satellites / Planets** layers in the panel.
- Hover an aircraft or planet for live details (callsign, altitude, speed, etc.).

## What it shows

- **A real night sky** — 8,900+ naked-eye stars from the HYG catalogue, placed by
  their true RA/Dec and rotated into your local sky using your latitude and the
  live sidereal time. Star colours come from real B–V colour indices; sizes from
  magnitude; they twinkle, and bright stars can be labelled.
- **3D airliners** — each plane is a procedurally built airliner model (fuselage,
  swept wings, tail, engines), lit by the **real Sun position**, oriented along
  its true track, climbing/descending per its vertical rate, trailing a **fading
  contrail**.
- **Flight info** (toggle) — aircraft type, registration, operator, and route
  (origin → destination) pulled live from adsbdb.
- **Satellites** glowing at their true look-angles, and **planets / Sun / Moon**
  at accurate positions.
- **Cinematic rendering** — ACES tone mapping, bloom, environment reflections on
  the metal, and a day/night exposure + lighting cycle driven by the Sun.

## Data sources (all free, no API key)

| Layer       | Source        | How                                                    |
|-------------|---------------|--------------------------------------------------------|
| Aircraft    | OpenSky Network | Live state vectors near you, polled every ~12 s, dead-reckoned between polls for smooth motion |
| Flight info | adsbdb        | Callsign → route, ICAO24 → aircraft type (enriched on demand, cached) |
| Satellites  | CelesTrak     | TLEs propagated locally with SGP4 (`satellite.js`)      |
| Planets/Sun/Moon | (none)   | Computed locally from ephemerides (`astronomy-engine`) |
| Stars       | HYG catalogue | Public-domain; baked once into `public/data/stars.json` via `scripts/build-stars.mjs` |

A tiny Node proxy (`server/index.js`) fetches and **caches** OpenSky, CelesTrak,
and adsbdb to dodge CORS and rate limits. Optional: set `OPENSKY_USER` /
`OPENSKY_PASS` (a free OpenSky account) for higher aircraft rate limits.

### Rebuilding the star catalogue

`public/data/stars.json` is already committed. To regenerate (e.g. a different
magnitude limit), download the HYG CSV and run:

```bash
node scripts/build-stars.mjs hygdata_v41.csv public/data/stars.json
```

## How positions work

- **Aircraft**: reported lat/lon/alt → ECEF → local ENU → azimuth/altitude
  relative to you (accounts for Earth curvature). See `public/js/coords.js`.
- **Satellites**: TLE → SGP4 propagation → look angles (az/el/range) from your
  ground station.
- **Planets**: of-date RA/Dec with aberration → refracted horizontal coordinates.

Each object's **direction (az/alt) is physically exact**. Distances are compressed
onto nested dome shells so an 8 km plane and a 500 km satellite are both legible;
that radius is a display choice, not a claim about scale.

## Project layout

```
server/index.js        proxy + static host (OpenSky, CelesTrak, caching)
public/index.html      page + import map (CDN: three, satellite.js, astronomy-engine)
public/js/coords.js    geodetic <-> az/alt <-> dome geometry
public/js/sky.js       horizon, cardinal markers, alt/az grid, backdrop
public/js/planets.js   Sun, Moon, planets (astronomy-engine)
public/js/satellites.js TLE + SGP4 (satellite.js)
public/js/aircraft.js  live planes (OpenSky) + dead reckoning
public/js/ui.js        layer toggles, location, clock, info panel
public/js/main.js      scene, camera, controls, render loop, WebXR
```

## Aircraft realism

- **Service colour-coding** — 🔵 blue = law enforcement, 🟢 green = military, 🔴 red = EMS/fire, white = civilian. Classified from the adsbdb operator/owner/route plus the US-military ICAO24 hex range (see `public/js/classify.js`).
- **Helicopters** render as a helicopter model (rotor, tail boom, skids), not an airliner.
- **Status-driven nav lights** (`public/js/navlights.js`) — steady red (left) / green (right) / white (tail) position lights, a flashing **red anti-collision beacon**, white wingtip **strobes**, and **landing lights** that switch on only at low altitude (approach/departure), just like the real procedure. Toggle under **Graphics → Aircraft nav lights**.

## Display / projection modes

Pick under **Display / Projection** in the panel, or via URL for kiosk auto-launch:

| Mode | Use | URL |
|------|-----|-----|
| Free look | A normal screen — drag to look around | `?display=free` |
| Overhead (ceiling) | Projector roughly above the viewer; zenith-centred perspective | `?display=ceiling` |
| Fisheye dome 180° | **True dome master** — projector pointed straight up at a flat ceiling; zenith = centre, horizon = disc edge | `?display=fisheye` |

- **North at top** slider aligns the projection to your room (`&north=90`).
- **Fullscreen / kiosk** hides the UI; add `&kiosk` to the URL to start hidden.
- Example projector launch: `http://localhost:3000/?display=fisheye&north=120&kiosk`
- **Ceiling shape (paint mask)** — real ceilings aren't clean rectangles (beams, crown
  molding, a round medallion, an alcove). Under **Display / Projection → Ceiling shape**,
  turn on **Custom ceiling shape**, hit **Paint**, and brush directly on the projected image
  to **Reveal sky** in your ceiling's true shape (or **Black out** the spill onto the walls).
  The painted mask is saved automatically, so a kiosk keeps it across reloads. Hit **Paint**
  again to stop painting and look around.

## VR & passthrough AR (Oculus Quest)

Open the app in the Quest browser and use the on-screen buttons:

- **ENTER VR** — full surrounding planetarium dome.
- **START AR** — **passthrough** overlay: the real room stays visible (the opaque sky dome + ground are hidden) while live aircraft, satellites, planets, and stars float in your actual space.

WebXR is only enabled while a session is active, so desktop/projector rendering is unaffected.

## 3D model credits (CC-BY 3.0)

Per-type aircraft and satellite models are self-hosted in `public/models/`,
sourced from **Poly Pizza** under CC-BY 3.0 (plus a low-poly ISS). Attribution:

```
"Airplane", "Gulfstream" (bizjet), "Satellite", low-poly "International Space Station" — Poly by Google
"Boeing 747" — Miha Lunar
"Jet" (fighter) — jeremy
"Helicopter" — jeremy
"Small plane" (cessna) — Eik Røgeberg
all via Poly Pizza (https://poly.pizza), licensed under CC-BY 3.0
```

Aircraft are matched to a model by ICAO type code (see `modelKeyFor` in
`public/js/aircraft.js`): airliner, 747 jumbo, business jet, GA prop, helicopter,
or stealth fighter (military). Satellites use a generic comms-sat model, with the
ISS getting its own model. `public/model-view.html` is a dev page that lays out
every model for orientation calibration.

## Roadmap to the TV / VR targets

- **Projector / kiosk** — works now: run Chromium fullscreen at `localhost:3000`.
- **Oculus / WebXR** — works now via the in-page VR button on a headset browser.
- **Apple TV (tvOS)** — wrap this web app, or port the renderer to SceneKit using
  the same `coords.js` math.
- **Roku** — needs a native SceneGraph/BrightScript port (no WebGL); reuse the
  proxy and the coordinate math as the spec.
