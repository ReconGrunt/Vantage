// GET /api/cameras?lat&lon&radius — Ground/City public-camera catalog, native port of
// server/index.js. Fans out across every keyless camera adapter (Caltrans CWWP2, NYC DOT,
// FL511 via ArcGIS, TfL JamCams) and fuses the results.
//
// Response: { cameras: Camera[], ts } — key-for-key identical to the Node backend.
// Only officially-published public cameras; never private or unsecured streams.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::StatusCode,
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

    let out = json!({ "cameras": cameras, "ts": unix_now() });
    st.json
        .insert(
            key.clone(),
            Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(10 * 60) },
        )
        .await;
    Json(out).into_response()
}
