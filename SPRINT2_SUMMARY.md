# SPRINT2_SUMMARY.md

Unified result of **Sprint 2** of the 3-agent effort (ATLAS · LENS · CORE) on
LivelySky — the ceiling-projection app for real-time overhead aircraft +
satellites. Sprint 1's tune-up is in
[`OPTIMIZATION_SUMMARY.md`](OPTIMIZATION_SUMMARY.md); the full per-agent Sprint 2
log is the internal scratchpad `AGENT_SWARM.md`.

**Mandate this sprint:** correctness BEFORE performance/visuals; surgical,
reversible changes; preserve the working app. **The north star — correctness of
overhead az/el positioning math — was independently RE-PROVEN by two standalone
test vectors (below), so `coords.js` was not touched.**

**Verification:** every edited app file passes `node --check`. App-code changes
this sprint are minimal by design (see "Why so few app-code edits"). HEAD_DEV runs
the live browser smoke test.

---

## TL;DR — what changed

- **Positioning math re-proven correct** by two independent standalone tests
  (SGP4 az/el pipeline + ceiling projection mapping). No sky-math edits.
- **One app-code change** (`main.js` boot path): parallelized the two independent
  boot fetches (cold-start win) and guarded them so a TLE/stars outage can't abort
  the boot (error-boundary fix).
- **Off-thread SGP4 Worker: re-deferred to Sprint 3** (authoritative CORE
  tiebreaker ruling) with a concrete message-passing design locked in.
- **Pass-prediction lookahead: contract approved, implementation deferred to
  Sprint 3** (LENS + CORE concur) — to be computed inside that same Worker.
- **Memory audit:** no unbounded 30-min growth exists; every structure's bound
  documented. One multi-day VRAM creep deferred with its fix now fully scoped.
- **Error boundaries:** all six async failure paths now map to a defined UI state.

---

## Correctness audit — independently re-proven (test-only scripts, no app code)

Both are standalone `node` scripts that exercise the **real** app code/library
versions; they touch no app source, no network, no server.

| Test | Script (test-only) | Result |
|------|--------------------|--------|
| SGP4 az/el pipeline (ATLAS) | `scripts/sgp4-testvector.mjs` | **PASS.** ISS over Greenwich, TLE epoch +30 min. App pipeline `propagate→eciToEcf(gmst)→ecfToLookAngles` gives az=299.6209°, el=−23.8509°, range=6074.53 km; an independent ECI→ECEF→ENU cross-check agrees to **dAz=3.95e-10°, dEl=3.21e-10°**; vs recorded expected dAz=dEl=0.0000°, dRange=0.004 km. |
| Ceiling projection mapping (LENS) | `scripts/projection-test.mjs` (+ `three-loader.mjs`, `three-shim.mjs`) | **PASS — 12/12.** Imports the REAL `coords.js` under a minimal `three` Vector3 shim. N@45→world −Z & screen TOP; E@30→world +X & screen LEFT (the correct *view-from-below*); near-zenith→+Y & screen CENTER; `domePosition==unit*R`; northDeg=90 rotates East→top. |

**Verdict: `coords.js` az/el/projection math is CORRECT and was NOT modified**
(guardrail satisfied — a documented test vector exists for any future sky-math
change).

---

## App-code change (by file, before → after)

### `public/js/main.js` — boot path (`initData`) — CORE

Two declared items landed in one surgical edit; no other app file touched.

**Before** (sequential, unguarded):

```js
ui.status('Loading stars…');
ui.setCount('stars', await layers.stars.load());
ui.status('Loading satellites…');
ui.setCount('satellites', await layers.satellites.load(state.satGroup));
ui.status('Loading aircraft…'); await refreshAircraft(); refreshWeather(); ui.status('Live');
```

**After** (parallel + per-load guard):

```js
ui.status('Loading sky data…');
const [starN, satN] = await Promise.all([
  layers.stars.load().catch(() => 0),
  layers.satellites.load(state.satGroup).catch(() => 0),
]);
ui.setCount('stars', starN);
ui.setCount('satellites', satN);
ui.status('Loading aircraft…'); await refreshAircraft(); refreshWeather(); ui.status('Live');
```

- **Cold-start win:** stars (HYG catalogue) and satellites (TLE) are independent
  endpoints; loading them concurrently cuts boot data-load latency from
  **sum(stars, tle) → max(stars, tle)**. Same counts set, same downstream order.
- **Error-boundary fix:** each load is `.catch(() => 0)`-guarded, so a hard
  stars/TLE fetch failure at boot resolves to count 0 instead of rejecting
  `initData` and stranding the dome on the loading status with no aircraft. On
  failure, sats simply stay empty until the existing 6 h refresh
  (already `.catch`-guarded) or a manual group change.
- **Identical on success:** the only observable difference on the happy path is a
  single combined "Loading sky data…" status line and that the two fetches
  overlap. No effect on the rendered dome, projection, or positioning.
- `node --check public/js/main.js` → **PASS.**

> `refreshAircraft` is already safe to await unguarded: `aircraft.poll()` catches
> its own fetch error and returns `{error:true}` rather than throwing, so a dead
> ADS-B feed at boot also cannot abort `initData`.

**Sprint 1 changes confirmed still present & intact:** planets ~1 Hz throttle
(`planets.js`), satellite `addUpdateRange` GPU narrowing (`satellites.js`),
aircraft/ISS per-frame label allocation removals, `refreshAircraft` stale/error
banner, GPS-denied hint, 6 h TLE refresh (`main.js`).

---

## Measurable results

| Item | Before | After |
|------|--------|-------|
| SGP4 pipeline vs independent cross-check | — | agree to **~4e-10°** (PASS) |
| Ceiling projection assertions | — | **12 / 12 PASS** |
| Boot data-load latency (stars + TLE) | sum of the two fetches | **max** of the two (parallel) |
| Boot resilience to a TLE/stars outage | rejects → dome stuck, no aircraft | boots with 0 sats, aircraft + "Live" proceed |

---

## Off-thread ruling (CORE tiebreaker) — SGP4 Worker RE-DEFERRED to Sprint 3

The brief framed per-frame SGP4 as "a Sprint 2 P0 if not off-thread." **Ruling:
re-defer**, with a concrete design — a deliberate call, not avoidance.

A Worker fails the no-build / no-regression bar because:

1. **Split-brain state.** `satellites.js:update()` emits the Points position buffer
   and `visibleSats[]` **index-aligned** (picking maps `hit.index` → `visibleSats`).
   `visibleSats` also carries the live `satrec` object (used by picking metadata,
   ISS status, overhead/pass prediction). A `satrec` is **not structured-cloneable**,
   so it can't be posted back; the main thread would have to re-associate
   worker-computed positions to the right entry every frame — new per-frame work
   and a new ordering-bug surface in the exact path picking relies on.
2. **Per-frame round-trip latency.** The render loop reads `visibleSats` the same
   frame it updates (ISS label, model placement). A Worker makes positions arrive
   ≥1 frame late → either the dome lags the data or we double-buffer stale
   positions; both are behavior deltas in a correctness sprint.
3. **No-build import path.** A module Worker doesn't inherit the document importmap,
   so it must hard-code the `satellite.js` `+esm` CDN URL (drift risk vs
   `index.html`). Manageable but a maintenance edge.

The per-frame SGP4 cost is the #1 main-thread cost but **tolerable today**
(hundreds of sats, cheap pure-JS trig, GPU path already optimal from Sprint 1).
Correctness-first means not destabilizing a working synchronous loop for a perf
win not yet needed.

**Locked Sprint-3 Worker interface** (so it isn't re-litigated):

- `{type:'load', sats:[{name,line1,line2}]}` → worker builds satrecs in-worker
  (satrecs never cross the boundary).
- `{type:'tick', t, observer}` → worker replies **transferable**
  `{positions: Float32Array(n*3), meta: Float32Array(n*5)}`
  (`meta = [azDeg, altDeg, rangeKm, heightKm, speedKmS]`, same index order), names
  posted once on load. Main thread rebuilds `visibleSats` from `meta` — identical
  shape, index-alignment preserved by construction.
- `{type:'predict', observer, t, sunAltDeg, opts}` →
  `{passPredictions: PassPrediction[]}` on the existing 12 s / 3 s cadence, so
  `issStatus`/`_peak`/`overheadReport`/`passLookahead` all move off-thread together.
- Reversible: drop-in behind `SatelliteLayer.update()`; delete the worker to revert.

---

## Memory audit (30-min growth) — no unbounded growth; no eviction added

| Structure | Bound | Mechanism |
|-----------|-------|-----------|
| `aircraft.planes` (Map) | in-range count | despawn TTL: not seen >16 s → `_despawn` |
| trail `entry.history[]` | 48 nodes | `TRAIL_MAX` shift + zenith-jump/contrail-off reset |
| `visibleSats[]` | ≤ 12000 | **rebuilt** (`= []`) every frame, not appended |
| sat `_posArr` buffer | fixed | `Float32Array(12000*3)` once in ctor, written in place |
| path lines (came/going) | 256 pts each | fixed `PATH_MAX` buffers, 2 singletons, drawRange-clamped |
| `_enrichQueue[]` | self-draining | pump drains 6/s and skips despawned entries |
| texture/material caches | finite | `_texCache`/`_dot`/`_auraTex`/per-category mats — singletons or finite keys |
| per-plane label texture | 1 live | old CanvasTexture disposed on every text change while alive |

**The one memory item (deferred):** `_despawn` (`aircraft.js`) frees the trail
geometry + aura material but not the label's final texture/material nor the cloned
glTF materials → a **multi-day** VRAM creep (one leaked label texture + clone
materials per *unique* plane ever seen), **not** 30-min growth. Deferred because
the brief calls for eviction only where genuine unbounded growth exists (it
doesn't here) and disposing clone resources risks corrupting the **shared template
geometry**. Ownership is now fully traced for a safe Sprint-3 fix: dispose the
label `material.map` + `material`, and traverse the mesh disposing **materials
only** (never the shared geometry); `instantiate()` clones materials but shares
geometry, and `makeTextSprite` gives each label its own canvas/texture.

---

## Error-boundary map — every async failure path → defined UI state

| Failure | UI state | Where |
|---------|----------|-------|
| ADS-B down | "feed offline — showing last-known" / "feed stale — upstream down"; keeps dead-reckoning; self-heals to "Live" | `main.js` `refreshAircraft` (Sprint 1) |
| GPS denied/unavailable | "Location unavailable — using default…"; NYC fallback loads; dome runs | `main.js` boot geolocation cb (Sprint 1) |
| **TLE fetch fail (boot)** | **NEW: guarded — boots with 0 sats, aircraft/weather/"Live" still proceed** | `main.js` `initData` (this sprint) |
| TLE fetch fail (runtime) | 6 h refresh `.catch`-guarded; existing satrecs keep propagating | `main.js` (Sprint 1) |
| WebGL context lost | errlog "WebGL context lost — restoring…"; restored → `location.reload()` | `main.js` context-lost/restored handlers |
| glTF model load fail | per-model catch → falls back to procedural airliner/heli geometry (sats → glowing Points) | `assets.js` + `aircraft.js` `_applyModel` |
| Weather fetch fail | try/catch "keep last"; clouds retain prior coverage (cosmetic) | `main.js` `refreshWeather` |

The single gap (a TLE failure at **boot** could cascade and abort the whole boot)
was filled this sprint. All others were already truthful and were confirmed, not
duplicated.

---

## Cold-start inventory (by code inspection — no browser profiler available)

| Contributor | Status |
|-------------|--------|
| CDN module fan-out (three + 8 addons + satellite.js + astronomy-engine, 2 origins) | Biggest cold-cache latency — **inherent to no-build**; N/A without a bundler. Documented. |
| `PMREMGenerator.fromScene(RoomEnvironment())` (sync env prefilter at module top) | Real first-paint cost; deferring needs a deferred-then-swap of `scene.environment` — not surgical. Documented, not touched. |
| `loadModels()` 8 glTF fetches | Already `Promise.all` parallel + non-blocking (planes render procedurally, upgrade in place). Optimal. |
| `initData()` stars → TLE awaits | **Was sequential; now parallel (this sprint's safe win).** |

---

## Deferred to Sprint 3 (with reasons)

1. **SGP4 propagation Web Worker** — re-deferred; would split index-aligned
   positions/`visibleSats`/`satrec` state and add per-frame latency. Concrete
   message-passing interface locked (above). *(Carried from Sprint 1.)*
2. **Pass-prediction lookahead** (`passLookahead()` / `PassPrediction[]`) —
   contract **approved** (LENS), implementation deferred; belongs **inside** the
   Worker (`{type:'predict'}` → `{passPredictions}`), never on the main thread.
   Building it on-thread now then moving it would be throwaway work.
3. **Per-plane resource disposal in `_despawn`** — multi-day VRAM creep; fix now
   fully scoped (dispose label texture + clone **materials** only, never shared
   geometry). *(Carried from Sprint 1.)*
4. **Arbitrary-throw keystone correction** (LENS) — current projection is
   nadir-only (projector straight up); off-axis throw needs a real homography +
   calibration UI = a new feature, not a surgical edit.
5. **Aircraft label-density cull** (LENS) — labels default OFF, so pile-up is
   low-risk; a cull changes what the user sees and should be a deliberate toggle,
   not a stealth change in a correctness sprint.
6. **`navlights._lightsFor()` per-plane array-of-arrays/frame** — last remaining
   per-frame GC source; refactor to write into the preallocated buffer.
7. **`main.js` god-module split** (renderer/picking/loop/boot) — cosmetic
   readability; no behavior change.

---

## Test-only scripts vs app-code changes

- **Test-only (no app impact, deletable):** `scripts/sgp4-testvector.mjs` (ATLAS),
  `scripts/projection-test.mjs` + `scripts/three-loader.mjs` +
  `scripts/three-shim.mjs` (LENS).
- **App-code change:** `public/js/main.js` `initData` only (CORE) — boot-fetch
  parallelization + per-load guard.
- **No changes** to `coords.js`, `satellites.js`, `aircraft.js`, `planets.js`,
  `server/index.js`, shell radii, or either projection path.

---

## What was intentionally left alone

`coords.js` (re-proven correct by two test vectors), shell radii / `SHELLS`, both
projection paths, the synchronous satellite render path (Worker deferred to avoid
destabilizing index-aligned picking), and the no-build CDN/importmap architecture
(sound for this scale).
