# LivelySky Radar — Roku channel

A native Roku (BrightScript / SceneGraph) app that turns your TV into a **top‑down
live radar of the sky above you**: real aircraft overhead right now (live ADS‑B),
tonight's real bright stars, and the Sun — under a sweeping radar animation.

It is a **separate app** from the LivelySky web/projector dome (which is WebGL and
cannot run on Roku — Roku has no browser/WebGL). This Roku build reuses the same
coordinate math, ported to BrightScript.

> **One package, two roles.** The same channel is both an **app** (Home screen,
> interactive radar) and a **screensaver** (the ambient sweeping radar). See
> `source/main.brs` — `Main()` runs the app, `RunScreenSaver()` runs the ambient
> version. This is the supported Roku pattern and is the core of the go‑to‑market
> plan in [PUBLISHING.md](PUBLISHING.md).

## What it shows

- **Aircraft** — live from **adsb.lol** (free, no key, ODbL). Each plane is plotted
  at its true azimuth/elevation (zenith = centre, horizon = rim), coloured by
  altitude (green low / amber mid / cyan high, red = military). The app labels the
  nearest ones; the screensaver keeps it clean.
- **Bright stars** — ~130 naked‑eye stars from the HYG catalogue, placed by real
  RA/Dec + local sidereal time.
- **Sun** — true position (a gold disc when it's up).
- **HUD** — your location, a live UTC clock, aircraft count, and the required
  adsb.lol/ODbL attribution.

### Remote (app mode)
- **Up / Down** — change radar range (how far out it reaches).
- **Left / Right** — cycle the selected aircraft (shows a details card).
- **OK** — toggle the details card.
- **Back** — exit.

## Project layout

```
manifest                      channel metadata + both entry points
source/main.brs               Main() (app) + RunScreenSaver() (screensaver)
components/
  RadarScene.xml/.brs         interactive app scene  (focus -> remote)
  ScreensaverScene.xml/.brs   ambient scene          (render only)
  RadarView.xml/.brs          the shared radar render (grid, sweep, blips, stars)
  AircraftTask.xml/.brs       adsb.lol fetch -> az/alt blips
  LocationTask.xml/.brs       saved location or IP geolocation
  lib/coords.brs              geodetic <-> az/alt + radar projection (port of coords.js)
  lib/astro.brs               sidereal time, star + Sun alt/az
images/                       generated PNGs (radar grid, sweep, dot, star, icons, splash)
data/stars_bright.json        generated bright‑star list
tools/                        build‑time generators (NOT shipped in the channel)
```

## Build the assets (one time / when you tweak them)

The PNGs and the star list are generated (no fonts/native deps):

```bash
cd roku/tools
npm install
npm run all        # gen-bright-stars.mjs + gen-assets.mjs
```

Outputs land in `roku/images/` and `roku/data/` and are committed, so you only need
this if you change the look.

## Sideload to your Roku (developer mode)

1. On the Roku: **Home ×3, Up ×2, Right, Left, Right, Left, Right** → enable
   **Developer mode**, note the device IP, set a dev password.
2. Zip the **channel contents** (manifest must be at the zip root — do **not** zip
   the `roku/` folder itself, and exclude `tools/`):

   **Windows PowerShell**
   ```powershell
   cd roku
   Compress-Archive -Path manifest,source,components,images,data -DestinationPath LivelySkyRadar.zip -Force
   ```
   **macOS/Linux**
   ```bash
   cd roku
   zip -r LivelySkyRadar.zip manifest source components images data
   ```
3. Browse to `http://<roku-ip>/` (user `rokudev`, your dev password) and **Upload**
   the zip → **Install**.
4. The app launches. To test the **screensaver**: Roku Settings → Theme →
   Screensavers → pick **LivelySky Radar**, or just leave the device idle.

### Location
No GPS on Roku, so the app geolocates by your public IP on first run. To pin an
exact spot, set it once in the registry (future build adds an on‑screen settings
screen); the app reads `LivelySky` → `observer` = `{"lat":..,"lon":..,"label":".."}`.

## Publishing & monetization

The full, source‑cited go‑to‑market plan — pricing ($4.99 pay‑to‑install, 80/20
split), the screensaver‑led hybrid positioning, store‑listing copy, ASO reality
(Roku has **no keyword search** — your title *is* the SEO), cert checklist, and the
adsb.lol/ODbL legal go‑/no‑go — is in **[PUBLISHING.md](PUBLISHING.md)**.

## Data & attribution

Aircraft data © **adsb.lol** contributors, licensed **ODbL**. This attribution is
shown in‑app and must remain for any public/paid release. adsb.fi and OpenSky are
**non‑commercial** and are intentionally **not** used here.

## Status / roadmap

- ✅ Live aircraft radar, bright stars, Sun, dual app+screensaver package, IP
  location, graceful offline state, generated assets.
- ⏭️ Next: on‑screen location/settings screen; satellites (needs an SGP4 port or a
  hosted ephemeris endpoint); Moon; ISS‑pass highlight; day/night ambiance; on‑device
  performance pass for budget ONN hardware (node pooling instead of rebuild).

> **Not yet tested on a physical Roku.** It's written to Roku conventions but I had
> no device/simulator here — sideload to your ONN TV and we'll iterate on anything
> the device flags.
