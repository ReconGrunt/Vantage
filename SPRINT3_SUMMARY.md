# SPRINT3_SUMMARY.md

Result of **Sprint 3** of the 3-agent effort (ATLAS · LENS · CORE) on LivelySky — the
ceiling-projection live-sky dome. Prior sprints:
[`OPTIMIZATION_SUMMARY.md`](OPTIMIZATION_SUMMARY.md) (S1),
[`SPRINT2_SUMMARY.md`](SPRINT2_SUMMARY.md) (S2). Full per-agent log:
[`AGENT_SWARM_S3.md`](AGENT_SWARM_S3.md). Ran under the
[2026 Multi-Agent Standard](2026_agent_schema.md).

**Mandate (HEAD_DEV, differs from S1–S2):** S1–S2 were correctness-first and conservative.
**S3 was to make the app genuinely REALTIME and BEAUTIFUL — a truly immersive ceiling
experience.** Still surgical, reversible, style-matched, app stays booting. `coords.js`
positioning math is proven correct (two test vectors) and was **not touched**.

**Execution:** strictly **disjoint file ownership** so three agents ran in parallel with
zero write conflicts. HEAD_DEV did the central AUDIT/DESIGN, then verified every diff +
ran a **live browser smoke test in both projection modes**.

---

## TL;DR — what changed

- **Realtime (default projector path):** the fisheye dome now re-renders **5 cube faces
  instead of 6** per frame (the down −Y face is never sampled at ≤180°) — ~16.7% fewer
  whole-scene draws, zero pixel change. The cloud shader's per-fragment noise cost was
  **halved** (≈30 → 15 `noise()` samples). Both compound under the 6×/frame cube camera.
- **Immersion:** a **procedural Milky Way** on the true galactic plane (wheels with the
  sky), **sparse meteors** (pooled, zero-alloc), a **phase-accurate Moon** (a real
  Sun-lit sphere with a correct terminator + earthshine), **bright-star glow/glint**, a
  **soft feathered dome edge + warm horizon glow**, and a twilight **Belt of Venus**.
- **Verified live** (Opera, NYC night): boots clean in ceiling AND fisheye, no error
  overlay; the full dome renders correctly (5-face render leaves no black faces) with the
  Milky Way arcing across it. All 7 files pass `node --check`.

---

## Changes by agent (before → after)

### LENS — celestial immersion (`stars.js`, `planets.js`, NEW `meteors.js`)

- **Milky Way (`stars.js`).** New `_buildMilkyWay(R)`: a `BackSide` sphere at
  `SHELLS.stars − 5` added to the StarLayer's already-rotated equatorial group, so it sits
  on the real galactic plane and wheels overhead **with no main.js wiring**. Fragment derives
  galactic latitude from `dot(dir, galacticPole)` (pole/centre vectors expressed in the
  stars' own equatorial frame), draws a soft Gaussian band with 4-octave fbm mottling/dark
  rifts and a brighter, faintly-warm Gaussian bulge toward the galactic centre (Sagittarius).
  Faint (peak α 0.18), additive, `depthWrite:false`, `renderOrder −1`, not pickable; dimmed
  in `setSky()` on the **same** day/cloud curve as the stars.
- **Bright-star rendering (`stars.js`).** A `vBright = smoothstep(5,11,size)` varying gates a
  wider soft halo + a faint 4-point diffraction glint and a small size bump for **only** the
  brightest stars; faint background stars are unchanged (no bloat). Twinkle / extinction /
  visibility / additive blending intact.
- **Phase-accurate Moon (`planets.js`).** Replaced the flat opacity-dimmed sprite with a
  `Mesh` sphere (radius `MOON_SIZE/2`) shaded by `lambert = dot(worldNormal, sunDir)` using
  the layer's world-space `this.sunDir` → a physically-correct crescent/gibbous terminator as
  seen from the ground, for free. Faint blue-grey **earthshine** floor on the dark side, soft
  limb + feathered rim, faint additive halo that tracks illuminated fraction. Preserved the
  picking/main.js contract (mesh in `pickables`, `userData.kind:'planet'`, label, `info.phase`
  from `Astronomy.Illumination`, `above` gate, ~1 Hz throttle). Sun + planets unchanged.
- **Meteors (NEW `meteors.js`).** `class MeteorLayer { constructor(scene); setVisible(on);
  update(elapsed, nightFactor, cloudCover) }`. Pool of 10 reusable additive `Line` streaks
  (12 pts), Poisson spawn at `0.18·night³·(1−cover)` (~11/min peak; deep-night + clear-sky
  only), each sweeping a great-circle-ish tangent on the star shell over 0.4–1.2 s with a
  baked cool-head→warm-tail gradient and life-fade. **Zero per-frame heap allocation** in
  steady state (module-scope scratch, preallocated buffers, index loops); `dt` clamped ≤0.1 s.

### CORE — render kernel + perf (`fisheye.js`, `main.js`) — tiebreaker

- **Fisheye face-skip (`fisheye.js`).** Replaced the blanket `cubeCam.update()` with a private
  `_renderCube()` that renders only the faces the disc samples: **5 faces at FOV ≤ 180°**
  (skips index 3 = −Y/NY, provably never read since `dir.y = cos θ ≥ 0`) and all 6 only for
  the rare >180° calibration. **6 → 5 whole-scene cube draws/frame (~16.7% off the dominant
  fisheye GPU cost), zero sampled pixel changed.** Verified verbatim against pinned
  three@0.160.0 `CubeCamera.update` — preserves the lazy `updateCoordinateSystem()` guard
  (the only place the 6 face cameras get oriented), render-target/active-face/mip save-restore,
  `xr.enabled` force-off, last-face `generateMipmaps` handling, `needsPMREMUpdate`. Face lists
  preallocated (no per-frame alloc). One-line fallback to `cubeCam.update()`.
- **Dome edge beauty (`fisheye.js` shader).** Hard `r>1.0` cut → anti-aliased feather
  (`edge = 1 − smoothstep(1−0.012, 1, r)`) + a faint warm **horizon glow ring** near `r≈1`.
  The `theta/phi → dir` mapping and all `uOffset/uScale/uMirror/uNorth` math are unchanged —
  no object moves.
- **Meteor wiring + loop hygiene (`main.js`).** Imported/constructed `MeteorLayer`, gated its
  visibility on `state.layers.stars && !state.skyOnly` (toggle, `applySkyVisibility`, boot),
  and call `meteors.update(elapsed, night, cover)` only when shown. **Hoisted `night`/`cover`
  to compute once per frame** (were computed twice) — value-identical, reused by nav-lights +
  sky + meteors. Bloom stays off by default (flickers on some GPUs; fisheye bypasses the
  composer anyway).

### ATLAS — atmosphere (`sky.js`, `clouds.js`)

- **Cloud shader perf (`clouds.js`).** `fbm` octaves **5 → 3** (base amplitude 0.5 → 0.6 so the
  3-octave sum keeps the magnitude the coverage→threshold map was tuned for); HIGH cirrus deck
  **2 → 1** fbm via a `single` flag (LOW/MID keep the dual-warp for crisp edges). Net **fbm
  calls 6 → 5**, **`noise()` samples 30 → 15 per fragment (~50%)** — the biggest realtime win
  on the default path (it runs 6× under the cube cam). Coverage mapping, horizon fade, drift,
  opacities unchanged.
- **Night clouds (`clouds.js`).** `nightCol` (0.05,0.06,0.09) → (0.085,0.095,0.125) and `civil`
  widened (−12 → −14) so an overcast **night** reads as a dim moonlit blue-grey deck, not a
  void — with a graceful dusk→night handoff. Clear nights (~0 coverage) still discard, so the
  star field is untouched.
- **Twilight beauty (`sky.js`).** Added the pink **Belt of Venus / anti-twilight arch** on the
  anti-sun side (keyed off `dot(vDir,−sunDir)`, banded just above the horizon, gated by the
  civil-twilight term + a just-below-horizon Sun-depth window). Warm sunset band widened
  (`pow(sd,6)→4.5`) and slightly warmer; richer daytime zenith→horizon gradient. **Night
  palette kept dark** so stars + the Milky Way pop. No new uniforms; `SHELLS` + all export
  signatures unchanged.

---

## Measurable results

| Item | Before | After |
|------|--------|-------|
| Fisheye whole-scene cube draws / frame (FOV ≤ 180°) | 6 faces | **5 faces (−16.7%)** |
| Cloud shader `noise()` samples / fragment | ~30 (5-oct fbm ×6) | **~15 (3-oct fbm ×5)** |
| `night`/`cover` computed per render frame | twice | **once (reused)** |
| Meteor steady-state heap allocation / frame | — | **0 (pooled)** |
| Night sky immersion | stars + gradient | **+ Milky Way, meteors, phase Moon, star glint** |
| Fisheye dome edge | hard aliased circle | **feathered + warm horizon glow** |
| Live boot (ceiling + fisheye) | — | **both clean, no error overlay** |

---

## Live verification (Opera, NYC, night)

- **Ceiling skylight (default):** 8921 stars, 76 aircraft (SWA4191 737NG STL→MSY overhead as a
  lit 3D model), 8 sats; bright-star glints visible; flight board / guides / compass live.
- **Fisheye `?display=fisheye&kiosk`:** the **full hemisphere renders correctly — the 5-face
  cube render leaves no black/broken faces**; the Milky Way arcs across the dome as a mottled
  luminous band (brighter bulge ≈ galactic centre); the disc edge is softly feathered with a
  faint warm rim. No error overlay in either mode; server logged no errors.
- `node --check`: PASS on all 7 files.

---

## What was intentionally left alone (and deferred)

- `coords.js`, shell radii / `SHELLS`, the projection direction math, `aircraft.js`,
  `satellites.js`, `server/index.js`, `ui.js` — out of scope this sprint (proven / mature /
  risk-controlled).
- **SGP4 Web Worker** — still deferred (fine for the default `visual` group; risky in no-build).
  Locked interface remains in `SPRINT2_SUMMARY.md`.
- **Per-plane GPU resource disposal** (`aircraft._despawn`) — multi-day VRAM creep, fix scoped
  in S2.
- **`navlights._lightsFor()` per-frame array-of-arrays** — last per-frame GC source.
- **Bloom in the fisheye path** — the cube path bypasses the composer; a dome-wide glow would
  need a post-pass on the disc. Left off (flicker risk) — per-object additive glow covers most
  of the need.

---

## Files

Changed: `public/js/stars.js`, `public/js/planets.js`, `public/js/fisheye.js`,
`public/js/main.js`, `public/js/sky.js`, `public/js/clouds.js`.
New: `public/js/meteors.js`. (+419 / −36.) Changes are uncommitted in the working tree —
committing is a human decision.
