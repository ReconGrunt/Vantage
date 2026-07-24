// GET /api/cameras?lat&lon&radius — Ground/City public-camera catalog, native port of
// server/index.js. Fans out across every keyless camera adapter (Caltrans CWWP2, NYC DOT,
// FL511 via ArcGIS, TfL JamCams) and fuses the results.
//
// Response: { cameras: Camera[], ts } — key-for-key identical to the Node backend.
// Only officially-published public cameras; never private or unsecured streams.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::proxy::sources::{arcgis, cams, Bbox};
use crate::server::{unix_now, AppState, Cached};

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
    radius: Option<String>,
}

/// id -> image URL for every camera we've SERVED, so /api/camimg/:id resolves against our
/// own catalog and never a caller-supplied URL (no open proxy / SSRF). Mirrors the Node
/// `cameraIndex`. Bounded so a long-running kiosk can't grow it without limit.
static CAM_INDEX: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
const CAM_INDEX_MAX: usize = 8000;

fn cam_index() -> &'static Mutex<HashMap<String, String>> {
    CAM_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn index_cameras(cams: &[Value]) {
    if let Ok(mut idx) = cam_index().lock() {
        if idx.len() > CAM_INDEX_MAX {
            idx.clear(); // simplest bound: the next poll immediately repopulates
        }
        for c in cams {
            let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let url = c
                .get("still")
                .and_then(|x| x.as_str())
                .or_else(|| c.get("stream").and_then(|x| x.as_str()))
                .unwrap_or("");
            if !id.is_empty() && !url.is_empty() {
                idx.insert(id.to_string(), url.to_string());
            }
        }
    }
}

/// Hosts we will proxy an image from. Every camera is proxied rather than hotlinked, so
/// this must cover each provider's image host.
const CAMERA_HOST_ALLOW: &[&str] = &[
    "nyctmc.org", "dot.ca.gov", "ca.gov", "windy.com", "wsdot.wa.gov",
    "divas.cloud", "amazonaws.com", "tfl.gov.uk", "alertcalifornia.org",
];

fn host_allowed(url: &str) -> bool {
    let host = match url.split("://").nth(1).and_then(|r| r.split('/').next()) {
        Some(h) => h.to_lowercase(),
        None => return false,
    };
    let host = host.split(':').next().unwrap_or(&host).to_string();
    CAMERA_HOST_ALLOW
        .iter()
        .any(|a| host == *a || host.ends_with(&format!(".{}", a)))
}

/// Last-good camera frames: id -> (fetched-at, content-type, bytes). Serves two purposes:
/// a 15 s freshness cache (parity with the Node imgCache — one upstream pull per 15 s per
/// camera no matter how many viewers), and a stale fallback so an upstream blip shows the
/// last-good frame instead of an instant error.
static IMG_CACHE: OnceLock<Mutex<HashMap<String, (Instant, String, Vec<u8>)>>> = OnceLock::new();
const IMG_CACHE_MAX: usize = 1500;
const IMG_FRESH_S: u64 = 15;

fn img_cache() -> &'static Mutex<HashMap<String, (Instant, String, Vec<u8>)>> {
    IMG_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// GET /api/camimg/:id — native port of the Express camera-image proxy.
pub async fn image(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let url = match cam_index().lock().ok().and_then(|m| m.get(&id).cloned()) {
        Some(u) => u,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if !host_allowed(&url) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // Fresh cache hit — no upstream call.
    if let Ok(m) = img_cache().lock() {
        if let Some((at, ct, bytes)) = m.get(&id) {
            if at.elapsed().as_secs() < IMG_FRESH_S {
                return ([(header::CONTENT_TYPE, ct.clone()), (header::CACHE_CONTROL, "no-store".into())], bytes.clone()).into_response();
            }
        }
    }
    let fetched = match st.http.get(&url).header("User-Agent", "Vantage/0.1 (camera view)").send().await {
        Ok(r) if r.status().is_success() => {
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            match r.bytes().await {
                Ok(b) => Some((ct, b.to_vec())),
                Err(_) => None,
            }
        }
        _ => None,
    };
    match fetched {
        Some((ct, bytes)) => {
            if let Ok(mut m) = img_cache().lock() {
                if m.len() >= IMG_CACHE_MAX {
                    m.clear(); // simplest bound; the next poll immediately repopulates
                }
                m.insert(id, (Instant::now(), ct.clone(), bytes.clone()));
            }
            ([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "no-store".into())], bytes).into_response()
        }
        None => {
            // Upstream failed — serve the last-good frame if we have one (stale beats blank).
            if let Ok(m) = img_cache().lock() {
                if let Some((_, ct, bytes)) = m.get(&id) {
                    return ([(header::CONTENT_TYPE, ct.clone()), (header::CACHE_CONTROL, "no-store".into())], bytes.clone()).into_response();
                }
            }
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}

type CamFut<'a> = Pin<Box<dyn Future<Output = Result<cams::CamOut, String>> + Send + 'a>>;

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "lat and lon required", "cameras": [], "sources": [] })),
            )
                .into_response()
        }
    };
    let radius = q.radius.as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(30.0).min(120.0);

    let key = format!("cam:{:.1},{:.1},{}", lat, lon, radius.round());
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() {
                o.insert("cached".into(), json!(true));
            }
            return Json(v).into_response();
        }
    }

    let b = Bbox::new(lat, lon, radius);
    let stref = &st;
    let bref = &b;

    // (source id, fetch) pairs so the fused response can carry honest per-source health
    // (ok/count/note) — parity with the Node registry's `sources` for the cameras category.
    let mut futs: Vec<(&'static str, CamFut<'_>)> = Vec::new();
    futs.push(("caltrans-cam", Box::pin(async move { cams::caltrans(stref, bref).await })));
    futs.push(("alertca-cam", Box::pin(async move { cams::alertca(stref, bref).await })));
    futs.push(("nyc-dot-cam", Box::pin(async move { cams::nyctmc(stref, bref).await })));
    futs.push(("tfl-jamcam", Box::pin(async move { cams::tfl(stref, bref).await })));
    for ly in arcgis::LAYERS {
        if ly.category != "cameras" {
            continue;
        }
        futs.push((ly.id, Box::pin(async move { arcgis::fetch(stref, ly, bref).await.map(cams::CamOut::simple) })));
    }

    let mut cameras: Vec<Value> = Vec::new();
    let mut sources: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let results = join_all(futs.into_iter().map(|(id, f)| async move { (id, f.await) })).await;
    for (id, r) in results {
        match r {
            Ok(v) => {
                for cam in &v.items {
                    let k = cam.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if k.is_empty() || seen.insert(k) {
                        cameras.push(cam.clone());
                    }
                }
                let mut src = json!({ "id": id, "ok": true, "count": v.items.len(), "optin": false });
                if let Some(note) = v.note {
                    src.as_object_mut().unwrap().insert("note".into(), json!(note));
                }
                sources.push(src);
            }
            Err(e) => {
                sources.push(json!({ "id": id, "ok": false, "count": 0, "optin": false, "error": e.chars().take(140).collect::<String>() }));
            }
        }
    }

    index_cameras(&cameras); // so /api/camimg/:id can resolve what we just served
    let out = json!({ "cameras": cameras, "sources": sources, "ts": unix_now() });
    st.json
        .insert(
            key.clone(),
            Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(10 * 60) },
        )
        .await;
    Json(out).into_response()
}
