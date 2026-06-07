# OPTIMIZATION_SUMMARY.md

Unified result of the 3-agent optimization sprint (ATLAS · LENS · CORE) on
LivelySky — the ceiling-projection app for real-time overhead aircraft + satellites.
Focused tune-up, **not a rewrite**. Working functionality preserved; positioning
math left untouched (it was audited and found correct). Full per-agent log in
[`AGENT_COMMS.md`](AGENT_COMMS.md).

**Verification:** all modified files pass `node --check`; the app boots on
`localhost:3000`, renders the ceiling skylight, shows live aircraft (31) /
satellites (5) / stars (8921), hover/picking + Sun card work, and the on-screen
error overlay stays empty (no runtime errors).

---

## Correctness audit (the priority — no plane in the wrong part of the sky)

| Area | Verdict | Evidence |
|------|---------|----------|
| Aircraft az/el/range (`coords.js` ECEF→ENU, `lookAngles`) | ✅ correct | `coords.js:43-50` — az=atan2(E,N) 0=N CW, alt=asin(U/range), range in m |
| az/alt → world vector | ✅ correct | `coords.js:55-63` — +X=E, +Y=Up, −Z=N; az0→N, az90→E |
| Satellite SGP4 pipeline | ✅ correct | `satellites.js:101-110` — propagate→eciToEcf(gmst)→ecfToLookAngles, rad→deg, height in km |
| Ceiling "skylight" projection | ✅ correct | `main.js` camera-up mapping → N=top, **E=left** = the physically right *view-from-below* |
| Dead-reckoning to "now" | ✅ correct | `aircraft.js` great-circle forward + source-age compensation |

No positioning math was changed. The only projection note (E–W mirror differs
between ceiling and fisheye) is **by design** — see Arbitration below.

---

## Changes made (by file, with before → after)

### `public/js/satellites.js` — render hot path (LENS) + GPU upload (CORE)
- **Per-frame allocations 3 → 0.** Before: every frame built a JS array →
  `new Float32Array` → `new THREE.BufferAttribute` → `setAttribute` →
  `computeBoundingSphere()`. After: a 12 000-point buffer is preallocated once
  (`_posArr`, ctor) and written in place; only `setDrawRange` + `needsUpdate`.
- **Per-frame bounding-sphere recompute removed.** Replaced with a fixed sphere
  (centre 0, radius = satellite shell ×1.01) so frustum culling never wrongly
  hides points.
- **GPU upload narrowed.** Before: `needsUpdate` re-uploaded the whole ~144 KB
  buffer every frame regardless of how many sats were up. After:
  `clearUpdateRanges?.()` + `addUpdateRange?.(0, n*3)` (three r160 API, verified
  against the pinned 0.160.0 source; optional-chained to degrade safely) →
  uploads only the floats actually written.
- Removed a per-frame `issPos.p.clone()`.

### `public/js/aircraft.js` — label hot path (LENS)
- `aircraft.js:439`: removed `pos.clone().normalize()` (one `Vector3` per visible
  labeled plane per frame) → reuses a module-scope scratch `_lblOff`.

### `public/js/planets.js` — ephemeris throttle (CORE)
- `update()` solved the full astronomy-engine ephemeris **every frame** though the
  Sun/Moon/planets move arcseconds per frame. After: recompute at **~1 Hz** (or
  immediately if the observer moves; first call always runs), holding cached
  positions/`sunDir`/`sunAltitude` between solves. Removes ~9 ephemeris solves +
  Vector3 allocs from 59 of every 60 frames. **Zero visual change** — verified the
  Sun card + scene lighting still update.

### `public/js/main.js` — feed freshness + error boundaries (ATLAS + CORE)
- **TLE refresh (ATLAS):** TLEs were fetched once at boot and never refreshed —
  a 24/7 kiosk drifts as orbital-element epochs age. Added a 6-hour client-side
  reload (`layers.satellites.load(...)`), matching the server's 6 h cache so it's
  mostly a cheap cache hit; satrecs swap only after the fetch resolves (no flicker).
- **Stale/offline feedback (CORE):** `refreshAircraft()` now reflects the server's
  `stale`/`error` flags in the status line and self-heals to "Live" — previously a
  dead feed silently showed frozen traffic.
- **GPS-denied fallback (CORE):** the boot geolocation error callback (was an empty
  `() => {}`) now surfaces a "using default location" hint; GPS denial never blocks
  the dome.

---

## Measurable wins

| Win | Before | After |
|-----|--------|-------|
| Satellite update allocations | 3 heap allocs + bounds recompute / frame | 0 / frame |
| Satellite GPU upload | ~144 KB / frame (full buffer) | only sats currently up |
| Planet ephemeris solves | every frame (~60/s) | ~1/s |
| Aircraft label allocs | 1 Vector3 / labeled plane / frame | 0 |
| TLE freshness (kiosk) | frozen at page load | refreshed every 6 h |
| Dead feed UX | silent frozen traffic | status shows stale/offline, self-heals |

---

## Arbitration decisions (CORE has final say)

1. **Ceiling-vs-fisheye E–W mirror default → KEEP `dome.mirror = false`, ceiling
   stays the default; do NOT pre-mirror fisheye.** The primary use case is a
   projector pointed straight up at a flat ceiling, viewed from below — for which
   ceiling's N=top / **E=left** mapping is already physically correct. Fisheye's
   N=top / E=right is the correct dome-master convention. The two being mirror
   images is two *different physical projections*, not a bug; `dome.mirror` is the
   documented escape hatch for mirror-bounce rigs. No code change.
2. **Satellite buffer `updateRange` narrowing → IMPLEMENTED** (see satellites.js
   above), after verifying the non-deprecated r160 API (`addUpdateRange` /
   `clearUpdateRanges`).

---

## Architectural debt for next sprint (deliberately NOT done — correctness > speed)

- **SGP4 in a Web Worker (deferred).** Per-frame SGP4 over every satrec is the
  dominant main-thread cost as sat count grows. Deferred because satellite.js
  arrives via the importmap `+esm` CDN (a plain module Worker won't inherit it)
  and results feed both the points buffer *and* `visibleSats[]` (picking, ISS,
  pass prediction). A correct split needs double-buffered positions + duplicated
  satrecs — too much regression surface for this no-build sprint. Concrete plan is
  in `AGENT_COMMS.md`.
- **Per-plane GPU resource disposal (slow leak).** `aircraft.js` `_despawn` doesn't
  dispose per-plane label textures or cloned glTF materials → slow multi-day VRAM
  creep on a kiosk. Left until disposal ownership (shared/cached materials from
  `makeTextSprite` / `instantiate`) is traced, to avoid corrupting shared resources.
- **`main.js` is a ~660-line god module** (renderer + picking + UI + kiosk params +
  geolocation + loop) and `pick()` mutates module-locals (`focused/hovered`) outside
  the central `state`. Candidate for extraction; no behavior issue today.
- **`navlights.js:91-151`** builds an array-of-arrays per plane per frame — next
  cheap allocation cleanup after the bigger levers above.

---

## What was intentionally left alone
`coords.js` (verified correct), shell radii / `SHELLS`, both projection paths,
the no-build CDN/importmap architecture (sound for this scale — webpack-style
bundle/code-split levers are N/A here), and all live data source choices
(all free / no-key, CORS handled by the proxy).
