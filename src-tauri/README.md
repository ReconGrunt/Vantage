# Vantage for Windows (`src-tauri/`)

Native desktop shell for the Air/Sky domain — **Tauri v2 + WebView2** with a native
**Rust (axum) proxy** embedded in the binary. No Node, no bundled Chromium.

## How it works

On launch the app:

1. Binds a `TcpListener` to **`127.0.0.1:47615`** synchronously (fixed port, never
   `0.0.0.0`). The port is fixed on purpose: WebView `localStorage` is keyed by
   origin **including port**, so an ephemeral port would wipe saved observer location,
   dashboard layout, ceiling mask, and incident log every launch. If 47615 is taken it
   falls back to an ephemeral port and logs a one-session warning.
2. Spawns `axum` on that listener (`src/server.rs`) serving both the embedded frontend
   (`src/static_assets.rs`, `rust-embed` of `../public`) and the `/api/*` proxy routes
   (`src/proxy/*.rs`).
3. Opens the window at `http://127.0.0.1:47615/`. The frontend is therefore "just a
   browser at localhost" — its relative `/api/*` fetches are unchanged and there is **no
   Tauri IPC in `public/`**. Every native behaviour is driven from `src/main.rs`.

The `/api` routes are a faithful native port of `server/index.js` (same upstreams, units,
UA headers, cache windows, adsb.lol→adsb.fi fallback, serve-stale). Drift between the two
implementations is caught by `scripts/contract-smoke.mjs` (run `npm run smoke` with both
backends up).

### Native features (all in `src/main.rs`)

- **Single-instance** — a second launch shows/focuses the running window (registered first
  so it can't fight for the fixed port).
- **Window-state** — size/position/maximised restored on launch, saved on exit.
- **Minimise-to-tray** — closing hides the window; the tray menu has Show / Check for
  Updates / Quit; left-click shows the window.
- **Render-pause** — hiding the window calls `window.__vantageActive(false)`, which detaches
  the Three.js `setAnimationLoop` (idle GPU) and suspends data polls; showing resumes them.
  The webview's own `visibilitychange` covers minimise.
- **Graceful shutdown** — quitting fires a oneshot that lets axum drain.

## Building

```bash
npm install            # brings in @tauri-apps/cli
npm run tauri:dev      # dev window + devtools
npm run tauri:build    # release: NSIS installer under target/release/bundle/nsis/
```

Release profile is size-optimised (`opt-level="s"`, LTO, `strip`, `panic="abort"`).

## Icon

The reticle icon is generated (no external art) and expanded into the full set:

```bash
npm run icon           # node scripts/gen-icon.mjs + tauri icon -> src-tauri/icons/
```

Edit `scripts/gen-icon.mjs` to change the mark, then re-run.

## Auto-updater (release signing)

`tauri.conf.json` has `createUpdaterArtifacts: true` and a placeholder
`plugins.updater.pubkey`. To ship signed updates:

1. **Generate a keypair once:** `npx tauri signer generate -w vantage.key`
   (keep the private key + password OUT of git — store as CI secrets
   `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
2. Put the printed **public** key into `tauri.conf.json` → `plugins.updater.pubkey`.
3. `npm run tauri:build` produces the installer plus a signed update artifact + `.sig`.
4. Publish the artifact and a `latest.json`
   (`{ version, notes, platforms."windows-x86_64".{ signature, url } }`) to the GitHub
   Releases endpoint referenced in `plugins.updater.endpoints`. The tray "Check for
   Updates" item checks it, installs a newer signed build, and relaunches.

> Losing the private key ends signed updates for existing installs — treat it as a secret.

## Notes

- `bundle.identifier` = `com.vantage.desktop`; product name = **Vantage**.
- `target/` and `gen/schemas/` are git-ignored.
- macOS/Linux packaging is a later step (Tauri supports both; this is Windows-first).
- The GitHub repo lives at `ReconGrunt/Vantage`; the updater endpoint and User-Agent
  strings point there (GitHub resolves the path case-insensitively).
