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
    "divas.cloud", "amazonaws.com", "tfl.gov.uk",
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

/// GET /api/camimg/:id — native port of the Express camera-image proxy.
pub async fn image(State(st): State<AppState>, Path(id): Path<String>) -> Response {
    let url = match cam_index().lock().ok().and_then(|m| m.get(&id).cloned()) {
        Some(u) => u,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    if !host_allowed(&url) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match st.http.get(&url).header("User-Agent", "Vantage/0.1 (camera view)").send().await {
        Ok(r) if r.status().is_success() => {
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/jpeg")
                .to_string();
            match r.bytes().await {
                Ok(b) => ([(header::CONTENT_TYPE, ct), (header::CACHE_CONTROL, "no-store".into())], b).into_response(),
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

type CamFut<'a> = Pin<Box<dyn Future<Output = Result<Vec<Value>, String>> + Send + 'a>>;

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "lat and lon required", "cameras": [] })),
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

    let mut futs: Vec<CamFut<'_>> = Vec::new();
    futs.push(Box::pin(async move { cams::caltrans(stref, bref).await }));
    futs.push(Box::pin(async move { cams::nyctmc(stref, bref).await }));
    futs.push(Box::pin(async move { cams::tfl(stref, bref).await }));
    for ly in arcgis::LAYERS {
        if ly.category != "cameras" {
            continue;
        }
        futs.push(Box::pin(async move { arcgis::fetch(stref, ly, bref).await }));
    }

    let mut cameras: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for r in join_all(futs).await {
        if let Ok(v) = r {
            for cam in v {
                let k = cam.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                if k.is_empty() || seen.insert(k) {
                    cameras.push(cam);
                }
            }
        }
    }

    index_cameras(&cameras); // so /api/camimg/:id can resolve what we just served
    let out = json!({ "cameras": cameras, "ts": unix_now() });
    st.json
        .insert(
            key.clone(),
            Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(10 * 60) },
        )
        .await;
    Json(out).into_response()
}
