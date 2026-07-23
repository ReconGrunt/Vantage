# Vantage

**Vantage** is a real-time, **multi-domain common operating picture** built entirely on
**free, no-key data**. Two domains run from one frontend codebase:

- **Air / Sky** — the **real sky above your location**: aircraft, satellites, planets, the
  Sun, the Moon, the **Milky Way** and live **meteor showers**, each placed at its true
  azimuth and altitude (real callsigns, real NORAD objects, real ephemerides), plus a
  top-down tactical **radar** scope. Point a projector straight up and it becomes an
  immersive ceiling.
- **Ground / City** — a live **city activity map**: incidents, hazards, traffic and public
  cameras from dozens of free public feeds, fused into **hotspots** and an event feed
  (`?display=city`; see the [Ground / City domain](#ground--city-domain--the-all-domain-picture-extends-to-the-street) section below).

Most of this README documents the Air domain (the original core); the Ground/City domain
has its own section further down.

Vantage ships two ways from **one frontend codebase**:

- **Vantage for Windows** — a native desktop app (Tauri v2 + WebView2) with its own
  window, system tray (minimise-to-tray), single-instance, saved window position/size,
  and auto-update. Its proxy is a **native Rust server embedded in the app** — no Node,
  no bundled Chromium. The render loop pauses when the window is hidden so it doesn't eat
  resources in the background.
- **Web** — the identical UI served by a tiny Node/Express proxy, for a browser or a
  Chromium projector kiosk. Also runs in **Oculus / WebXR** headsets.

Both backends serve a **byte-compatible `/api` contract** (guarded by
`scripts/contract-smoke.mjs`). Apple TV packaging and a native Roku port are next.

## Tech stack — and why it's the right one

| Concern | Choice | Why |
|--------|--------|-----|
| Rendering | **Three.js (WebGL2)** | Mature, fast, direct control of the real-time render loop. The whole app is one continuous draw loop over thousands of points + dozens of meshes — exactly what a thin WebGL layer is best at. |
| XR | **WebXR** (built into Three.js) | One codebase gives desktop, projector, **and Oculus/Quest VR + passthrough AR** for free. No native VR rewrite. |
| App code | **Vanilla ES modules** | No framework. A 60 fps render loop driving imperative GPU state gets nothing from React/Vue's diffing — they'd only add overhead and indirection. Modules keep it organised without a build step. |
| Desktop shell | **Tauri v2 + WebView2** | Native window using the OS's existing Chromium (WebView2) — same WebGL2 renderer as Electron, without bundling a second browser. Tiny binary, low RAM. |
| Backend | **Native Rust (axum)** for the app · **Node + Express** for web | Only job is to proxy/cache the free APIs (CORS + rate limits). One `/api` contract, two implementations kept in sync by a smoke test. |
| Data | adsb.lol / adsb.fi · CelesTrak (SGP4 via `satellite.js`) · `astronomy-engine` · Open-Meteo · adsbdb · HYG | All free, no key; orbital + ephemeris math runs locally. |
| Deps | **Vendored locally** (`public/vendor/`: `three`, `satellite.js`, `astronomy-engine`) via an import-map | No bundler and **no CDN** — the app boots fully offline. |

**Verdict: no rewrite needed.** This is already the optimal stack for "one web codebase → screen + projector + Quest." The alternatives are worse fits here:
- *React / react-three-fiber* — declarative reconciliation fights a manual render loop; pure overhead.
- *Unity / Unreal* — great native graphics but can't run in a browser/kiosk, huge runtime, and throws away the free WebXR path.
- *CesiumJS* — built for a geospatial globe, not a from-the-ground sky dome.
- *Babylon.js* — peer of Three.js; switching buys nothing.

Optional future polish (not required): add **Vite + TypeScript** for build-time bundling and types — a tooling upgrade, not an architecture change.

## Run it

### Web (browser / projector kiosk)

```bash
npm install
npm start
# open http://localhost:3000
```

### Vantage for Windows (native app)

Requires the Rust toolchain (`rustup`) and the WebView2 runtime (preinstalled on
Windows 11). The Tauri CLI comes in as a dev dependency via `npm install`.

```bash
npm run tauri:dev      # dev window with live devtools
npm run tauri:build    # NSIS installer -> src-tauri/target/release/bundle/nsis/
```

The app embeds a native Rust proxy on `127.0.0.1:47615` and opens its window there,
so the same UI runs with no Node process. Closing the window minimises to the tray;
quit from the tray menu. See [`src-tauri/README.md`](src-tauri/README.md) for the
architecture, icon regeneration (`npm run icon`), and the auto-updater signing model.

On first load it asks for your location (or defaults to New York). You can also
type a lat/lon/altitude in the panel.

- **Drag** to look around the dome · **scroll** to zoom (telescope-style FOV).
- Toggle the **Aircraft / Satellites / Planets** layers in the panel.
- Hover an aircraft or planet for live details (callsign, altitude, speed, etc.).

## What it shows

- **A real night sky** — 8,900+ naked-eye stars from the HYG catalogue, placed by
  their true RA/Dec and rotated into your local sky using your latitude and the
  live sidereal time. Star colours come from real B–V colour indices; sizes from
  magnitude; they twinkle, the brightest get a soft glow + diffraction glint, and
  bright stars can be labelled.
- **The Milky Way** — a procedural band painted on the **true galactic plane**, so it
  arcs across the dome and wheels overhead exactly as the real one does for your place
  and time (with the brighter bulge toward the galactic centre in Sagittarius).
- **Meteors, true to the date and place** — the major annual showers (Perseids,
  Geminids, Quadrantids, Lyrids, …) with their **real radiants** rotated into your local
  sky and activity that ramps around each shower's peak date; shower meteors stream out
  of the radiant, sporadics fall toward the horizon. Quiet between showers, busy on peak
  night — just like the real sky.
- **3D aircraft** — each plane is the real reported flight as a per-type 3D model, lit
  by the **real Sun position**, oriented along its true track, climbing/descending per
  its vertical rate, trailing a **fading contrail**. Overhead in the ceiling view it
  swells into a dramatic **low flyover** so you can read the airframe and livery.
- **Flight info** (toggle) — aircraft type, registration, operator, and route
  (origin → destination) pulled live from adsbdb.
- **Satellites** glowing at their true look-angles, a **phase-accurate Moon** (a real
  Sun-lit sphere with the correct crescent/gibbous terminator + earthshine), and the
  **Sun + planets** at accurate positions.
- **A sky that matches the hour** — physically-flavoured twilight with a sunset glow
  and the pink **Belt of Venus** opposite the Sun, real cloud decks driven by live
  weather, and a day/night exposure + lighting cycle.
- **Cinematic rendering** — ACES tone mapping, bloom, environment reflections on the
  metal, and a soft-edged 180° fisheye dome with a warm horizon glow.

## Data sources (all free, no API key)

| Layer       | Source        | How                                                    |
|-------------|---------------|--------------------------------------------------------|
| Aircraft    | adsb.lol (adsb.fi fallback) | Live ADS-B near you, polled every ~4 s, dead-reckoned between polls for smooth motion |
| Flight info | adsbdb        | Callsign → route, ICAO24 → aircraft type (enriched on demand, cached) |
| Satellites  | CelesTrak     | TLEs propagated locally with SGP4 (`satellite.js`)      |
| Planets/Sun/Moon | (none)   | Computed locally from ephemerides (`astronomy-engine`) |
| Stars       | HYG catalogue | Public-domain; baked once into `public/data/stars.json` via `scripts/build-stars.mjs` |

The proxy fetches and **caches** these upstreams to dodge CORS and rate limits. The web
build uses a tiny Node proxy (`server/index.js`); the Windows app uses an equivalent
native Rust proxy (`src-tauri/src/proxy/`) — same routes, units, and cache windows, all
free and no-key.

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
server/index.js          web proxy + static host (ADS-B, CelesTrak, weather, ATC, caching)
src-tauri/               native Windows app: Tauri shell + Rust proxy (mirrors server/index.js)
public/vendor/           locally-vendored libs (three, satellite.js, astronomy-engine) — offline
public/index.html        page + import map (local vendor paths, no CDN)
public/js/coords.js      geodetic <-> az/alt <-> dome geometry
public/js/sky.js         horizon, cardinal markers, alt/az grid, twilight backdrop
public/js/stars.js       HYG star field + the Milky Way
public/js/meteors.js     date/location-accurate meteor showers + sporadics
public/js/planets.js     Sun, phase-accurate Moon, planets (astronomy-engine)
public/js/satellites.js  TLE + SGP4 (satellite.js)
public/js/aircraft.js    live planes (ADS-B) + dead reckoning + ceiling low-flyover
public/js/clouds.js      live-weather cloud decks
public/js/fisheye.js     180° fisheye dome-master projection
public/js/ceiling-brush.js  paint-to-reveal custom ceiling-shape mask
public/js/radar.js       tactical top-down PPI scope (tracks, rings, sweep, track list)
public/js/city.js        Ground/City domain map (incidents + hotspots + public cameras)
public/js/hotspots.js    client-side hotspot (kernel-density) engine for the city view
server/sources/          pluggable Ground/City feed adapters (CAD/911, 311, NWS, USGS, cameras; opt-in gray)
public/js/atc.js         live ATC audio (LiveATC) — single-stream resolver + voice activity
public/js/towers.js      nearby ATC facilities placed on the horizon
public/js/dashboard.js   "Arrange" mode — drag/resize widgets per view
public/js/ui.js          the ONE command menu: view switcher + per-view sections, location, clock, info
public/js/main.js        scene, camera, controls, render loop, WebXR
```

## Aircraft realism

- **Service colour-coding** — 🔵 blue = law enforcement, 🟢 green = military, 🔴 red = EMS/fire, white = civilian. Classified from the adsbdb operator/owner/route plus the US-military ICAO24 hex range (see `public/js/classify.js`).
- **Helicopters** render as a helicopter model (rotor, tail boom, skids), not an airliner.
- **Status-driven nav lights** (`public/js/navlights.js`) — steady red (left) / green (right) / white (tail) position lights, a flashing **red anti-collision beacon**, white wingtip **strobes**, and **landing lights** that switch on only at low altitude (approach/departure), just like the real procedure. On by default.

## Situational-awareness tools

- **Tactical radar (top-down)** — a flat geographic scope (Web Mercator, pan/zoom,
  optional free satellite/terrain basemap), your position centred, live aircraft plotted
  at their true lat/lon with range rings, a rotating sweep, MIL-STD-2525-flavoured
  affiliation tracks, and a live track list + per-track detail. The status strip reports
  **honest ADS-B link health** — no classification theatre.
- **Live ATC audio** — the facility (tower/approach) an overhead or hovered aircraft is
  working, streamed free from LiveATC.net and proxied same-origin. One voice at a time
  (hovered › kept › auto-overhead) with an "on air" indicator from a WebAudio
  voice-activity detector. **Comms follow you** — change your location and out-of-range
  feeds drop, so you always hear the sky above where you actually are.
- **Distress + air-incident log** — aircraft squawking 7500 (hijack), 7600 (radio fail)
  or 7700 (emergency) surface in a distress panel (shown in every view) and are
  self-logged into a per-UTC-day incident list, since no free public air-incident feed
  exists.
- **Arrange mode** — drag / resize / show-hide any on-screen widget on a snap grid, saved
  per view (hit **Arrange layout**, or press **E**).

## Ground / City domain — the all-domain picture extends to the street

Vantage is a **multi-domain common operating picture**. Alongside the Air/Sky domain it now
has a **Ground / City** view (the **City** button, or `?display=city`): a top-down geographic
map of what's happening on the ground right now, fusing many **free, public** feeds into live
**hotspots**, an event list, and clickable public cameras.

- **Live incidents** — official **CAD/911 dispatch + crime + 311** open data (Seattle Fire,
  SF Police/Fire real-time, DC MPD, Chicago, Cincinnati, NYC), normalized into one Event
  model and classified by kind (fire · medical · police · traffic · hazard · civic).
- **Hazards & natural events** — **NWS** alerts, **USGS** quakes + volcanoes, **NWS storm
  reports** (IEM), **NASA EONET**, **GDACS** global disasters, and **NWPS** flood gauges — all free, no key.
- **Public cameras** — officially-published DOT cameras (**Caltrans** CWWP2, **NYC DOT**),
  click a pin for a live snapshot. **No private/unsecured cameras — ever.**
- **Hotspots** — a client-side kernel-density engine (`public/js/hotspots.js`) ranks activity
  by **severity × recency × density**, so a working fire from minutes ago outweighs a hundred
  day-old calls. The heat overlay + "top hotspots" board update on every poll, not per frame.
- **Honest feed health** — a per-source status list shows which feeds are live, empty, or
  offline right now (the same no-theatre ethos as the radar link-health strip).

Feeds auto-activate by location (live CAD/911 where a city publishes it). Adding a feed is
**one file**: each source is a small **adapter** in `server/sources/*` that turns an upstream
record into the shared Event/Camera model and **degrades to empty on failure** — one dead
feed never breaks the map. Every keyless adapter is mirrored **feed-for-feed** in the native
Rust proxy (`src-tauri/src/proxy/sources/`), so the packaged desktop app shows the same
picture as the web build; both `/api/incidents` + `/api/cameras` are guarded by the contract
smoke test. (The free-key Phase-2 feeds remain Node-side.)

### Opt-in sources (default OFF)

Snap Map, Citizen, PulsePoint, scanner and social have no official free (mappable) feed, so
they're **opt-in, pluggable adapters** — enable with `VANTAGE_ENABLE_CITIZEN=1`,
`VANTAGE_ENABLE_SNAPMAP=1`, `VANTAGE_ENABLE_PULSEPOINT=1` (+ `VANTAGE_PULSEPOINT_AGENCIES=…`),
`VANTAGE_ENABLE_SCANNER=1` (+ `VANTAGE_SCANNER_SYSTEMS=…`), or `VANTAGE_BLUESKY_QUERY="<place>"`
(a free, unauthenticated Bluesky search). They stay strictly **place/event-centric**:
aggregate activity at a location, never a person.

### Free-key feeds (set an env var to activate)

Trivially-free keys unlock national/global breadth. Each stays **off** until its key is set;
`GET /api/sources` (and the City **feeds** panel) shows every feed's state — live, `key`, or `opt-in`.

| Feed | Adds | Env var | Where |
|---|---|---|---|
| EPA AirNow | Air-quality (AQI) hazards, US | `AIRNOW_KEY` | airnowapi.org |
| NASA FIRMS | Wildfire thermal hotspots, global | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov |
| Windy Webcams | Global public webcams | `WINDY_KEY` | api.windy.com |
| WSDOT | Washington traffic alerts + cameras | `WSDOT_KEY` | wsdot.wa.gov |
| 511 SF Bay | Bay Area traffic incidents / closures | `FIVE11_SF_TOKEN` | 511.org/open-data |
| Ticketmaster | Public events (crowd context) | `TICKETMASTER_KEY` | developer.ticketmaster.com |
| Socrata | *(optional)* lifts the anonymous rate limit | `SOCRATA_APP_TOKEN` | portal dev settings |

Keyless additions shipped this phase (no key needed): **FL511** (Florida DOT cameras) and
**TfL JamCams** (London traffic cameras — an optional `TFL_APP_KEY` just lifts the rate).

### Guardrails (non-negotiable)

1. **Public / authorized feeds only** — official agency feeds, legal aggregators, open APIs.
   Never unauthorized access to private or unsecured cameras, never auth-bypass or
   ToS-circumvention. The camera-image proxy resolves an **id against the server's own
   catalog**, never a caller-supplied URL (no open proxy / SSRF surface).
2. **Places & events, never persons** — the picture is of the *city* (incidents, hazards,
   hotspots), not any individual. Social/place-heat sources are ingested as aggregates only.

## One command menu, every view

Vantage drives every view from a **single command menu** — one tactical panel
(top-left) with a **View** switcher on top and sections that adapt to the view you
pick. Shared controls (aircraft **service filter**, **ATC**, the **air-incident log**,
your **location**) stay one click away everywhere; view-specific controls appear only
where they apply — dome layers / star labels / projection tuning / ceiling-shape paint
in the projector views, and range rings / basemap / sweep in radar. Pick a view in the
panel, or via URL for kiosk auto-launch:

| View | Use | URL |
|------|-----|-----|
| Ceiling skylight | Projector roughly above the viewer; a round window of overhead sky, zenith-centred — correct for a **flat** roof | `?display=ceiling` |
| Fisheye dome 180° | **True dome master** — projector straight up at a flat ceiling; zenith = centre, horizon = disc edge (correct on a curved planetarium dome) | `?display=fisheye` |
| Free look | A normal screen — drag to look around | `?display=free` |
| Tactical radar | Top-down geographic PPI scope: ownship centred, North up, live tracks by real lat/lon, range rings, sweep, MIL-STD-2525 tracks + track list | `?display=radar` |
| City activity | Ground/City common-operating-picture: live incidents, hazards, hotspots + public cameras on a geo map, with a per-source feed-health readout | `?display=city` (e.g. `&lat=37.78&lon=-122.42`) |

- **North at top** slider aligns the projection to your room (`&north=90`).
- **Fullscreen / kiosk** hides the UI; add `&kiosk` to the URL to start hidden.
- Example projector launch: `http://localhost:3000/?display=fisheye&north=120&kiosk`
- **Ceiling shape (paint mask)** — real ceilings aren't clean rectangles (beams, crown
  molding, a round medallion, an alcove). Under **Display / Projection → Ceiling shape**,
  turn on **Custom ceiling shape**, hit **Paint**, and brush directly on the projected image
  to **Reveal sky** in your ceiling's true shape (or **Black out** the spill onto the walls).
  The painted mask is saved automatically, so a kiosk keeps it across reloads. Hit **Paint**
  again to stop painting and look around.

## Realtime performance

The whole scene is one continuous draw loop, tuned to stay smooth on a 24/7 projector
kiosk:

- The 180° **fisheye dome renders only the 5 cube faces it actually samples** — the
  down-facing face is never seen at ≤180°, so it's skipped (~17% off the dome's GPU
  cost, with zero change to any pixel).
- The **cloud shader** uses a trimmed multi-octave noise (≈half the samples) since the
  dome re-renders the scene per cube face.
- **Satellites** upload only the points currently above the horizon; the **ephemeris**
  (Sun/Moon/planets) solves at ~1 Hz; per-frame allocations in the hot paths are zero.

Details and before/after numbers are in [`SPRINT3_SUMMARY.md`](SPRINT3_SUMMARY.md) and
[`OPTIMIZATION_SUMMARY.md`](OPTIMIZATION_SUMMARY.md).

## VR & passthrough AR (Oculus Quest)

Open the app in the Quest browser and use the on-screen buttons:

- **ENTER VR** — full surrounding planetarium dome.
- **START AR** — **passthrough** overlay: the real room stays visible (the opaque sky dome + ground are hidden) while live aircraft, satellites, planets, and stars float in your actual space.

WebXR is only enabled while a session is active, so desktop/projector rendering is unaffected.

## 3D model credits (CC-BY 3.0)

Per-type aircraft and satellite models are self-hosted in `public/models/`,
sourced from **Poly Pizza** under CC-BY 3.0 (plus a low-poly ISS). Attribution:

```
"Airplane" (airliner, also used for bizjets), "Satellite", low-poly "International Space Station" — Poly by Google
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
