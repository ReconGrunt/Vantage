// Native port of server/index.js: an axum app serving the embedded frontend plus the
// /api/* proxy contract. Kept byte-compatible with the Node backend (see
// scripts/contract-smoke.mjs). All upstreams are free / no-key.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{routing::get, Router};
use moka::future::Cache;
use serde_json::Value;

use crate::proxy;
use crate::static_assets;

/// A cached JSON payload with a manual freshness deadline. moka evicts on its own long
/// retention TTL; we gate freshness with `good_until` so a stale entry survives for
/// serve-stale-on-upstream-failure (mirrors Node's Map + getCached() returning null past
/// the window while the entry lingers for the stale path).
#[derive(Clone)]
pub struct Cached {
    pub value: Arc<Value>,
    pub good_until: Instant,
}

/// A cached basemap tile (binary). Bounded by capacity, not swept by freshness.
#[derive(Clone)]
pub struct CachedTile {
    pub bytes: bytes::Bytes,
    pub content_type: String,
}

#[derive(Clone)]
pub struct AppState {
    /// JSON + tile client: connect + total timeouts (parity with AbortSignal.timeout(8000)).
    pub http: reqwest::Client,
    /// HTTP/1.1-only client with a longer (12 s) total timeout, for slow upstreams like
    /// lapdonline.org — an Akamai-fronted WordPress feed that takes ~8-10 s to first byte,
    /// so the shared 8 s client always timed out (Node's govrss uses a 12 s timeout, hence
    /// it worked there). HTTP/1.1-only matches Node/undici and drops the needless h2 ALPN.
    pub http1: reqwest::Client,
    /// ATC stream client: connect timeout only, NO total timeout (a total timeout would
    /// kill a healthy infinite Icecast stream).
    pub stream: reqwest::Client,
    /// aircraft / tle / weather / flightinfo — prefixed keys, one long-retention cache.
    pub json: Cache<String, Cached>,
    /// basemap tiles — capacity-bounded (TinyLFU), 7-day TTL.
    pub tiles: Cache<String, CachedTile>,
    /// resolved LiveATC Icecast host per feed (30-min TTL).
    pub atc_urls: Cache<String, String>,
    /// resolved keyed/opt-in source config (env-derived, built once) — mirror of Node CITY_CFG.
    pub cfg: std::sync::Arc<crate::proxy::sources::registry::Config>,
}

impl AppState {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(8))
            .build()
            .expect("build http client");

        let http1 = reqwest::Client::builder()
            .http1_only()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12)) // lapdonline is slow (~8-10 s TTFB); match Node's 12 s
            .build()
            .expect("build http1 client");

        let stream = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            // deliberately no .timeout(): the ATC feed streams indefinitely
            .build()
            .expect("build stream client");

        // Long retention so serve-stale works; per-route freshness is gated via `good_until`.
        let json = Cache::builder()
            .max_capacity(10_000)
            .time_to_live(Duration::from_secs(24 * 3600))
            .build();

        let tiles = Cache::builder()
            .max_capacity(4000)
            .time_to_live(Duration::from_secs(7 * 24 * 3600))
            .build();

        let atc_urls = Cache::builder()
            .max_capacity(64)
            .time_to_live(Duration::from_secs(30 * 60))
            .build();

        let cfg = std::sync::Arc::new(crate::proxy::sources::registry::resolve_config());

        Self { http, http1, stream, json, tiles, atc_urls, cfg }
    }
}

/// Build the full router: /api/* proxies + embedded static fallback.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/aircraft", get(proxy::aircraft::handler))
        .route("/api/tle", get(proxy::tle::handler))
        .route("/api/flightinfo", get(proxy::flightinfo::handler))
        .route("/api/atc", get(proxy::atc::list))
        .route("/api/atc/{feed}", get(proxy::atc::stream))
        .route("/api/weather", get(proxy::weather::handler))
        .route("/api/incidents", get(proxy::incidents::handler))
        .route("/api/sources", get(proxy::incidents::sources))
        .route("/api/cameras", get(proxy::cameras::handler))
        .route("/api/camimg/{id}", get(proxy::cameras::image))
        .route("/api/geolocate", get(proxy::geolocate::handler))
        .route("/api/prefs", get(proxy::prefs::get_prefs).post(proxy::prefs::set_prefs))
        .route("/api/tile/{style}/{z}/{x}/{y}", get(proxy::tile::handler))
        .route("/api/health", get(proxy::health::handler))
        .fallback(static_assets::serve)
        .with_state(state)
}

/// Seconds since the Unix epoch (parity with Math.floor(Date.now()/1000)).
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
