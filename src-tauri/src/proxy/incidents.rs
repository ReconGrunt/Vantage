// GET /api/incidents?lat&lon&radius — Ground/City domain, native port of the fused
// incident route in server/index.js. Fans out concurrently across every keyless adapter
// in proxy::sources (Socrata CAD/911 + 311, ArcGIS city layers, NWS, USGS, IEM, EONET,
// GDACS, NWPS), fuses + de-duplicates, and reports HONEST per-source health: one dead
// feed becomes {ok:false} and never fails the route.
//
// Response: { events: Event[], sources: [{id,ok,count,optin}], ts } — key-for-key identical
// to the Node backend (scripts/contract-smoke.mjs guards this).

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

use crate::proxy::sources::{arcgis, hazards, socrata, Bbox};
use crate::server::{unix_now, AppState, Cached};

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
    radius: Option<String>,
}

type SrcFut<'a> = Pin<Box<dyn Future<Output = (&'static str, Result<Vec<Value>, String>)> + Send + 'a>>;

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "lat and lon required", "events": [], "sources": [] })),
            )
                .into_response()
        }
    };
    let radius = q.radius.as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(30.0).min(120.0);

    // Quantized cache key (0.1 deg) so a browsable map can't grow the cache unbounded.
    let key = format!("inc:{:.1},{:.1},{}", lat, lon, radius.round());
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

    let mut futs: Vec<SrcFut<'_>> = Vec::new();
    for ds in socrata::DATASETS {
        futs.push(Box::pin(async move { (ds.id, socrata::fetch(stref, ds, bref).await) }));
    }
    for ly in arcgis::LAYERS {
        if ly.category != "incidents" {
            continue;
        }
        futs.push(Box::pin(async move { (ly.id, arcgis::fetch(stref, ly, bref).await) }));
    }
    futs.push(Box::pin(async move { ("nws-alerts", hazards::nws(stref, bref).await) }));
    futs.push(Box::pin(async move { ("usgs-quake", hazards::quakes(stref, bref).await) }));
    futs.push(Box::pin(async move { ("usgs-volcano", hazards::volcano(stref, bref).await) }));
    futs.push(Box::pin(async move { ("iem-lsr", hazards::iem(stref, bref).await) }));
    futs.push(Box::pin(async move { ("eonet", hazards::eonet(stref, bref).await) }));
    futs.push(Box::pin(async move { ("gdacs", hazards::gdacs(stref, bref).await) }));
    futs.push(Box::pin(async move { ("nwps", hazards::nwps(stref, bref).await) }));

    let results = join_all(futs).await;

    let mut events: Vec<Value> = Vec::new();
    let mut sources: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (id, r) in results {
        match r {
            Ok(v) => {
                let n = v.len();
                for ev in v {
                    let k = ev.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if k.is_empty() || seen.insert(k) {
                        events.push(ev);
                    }
                }
                sources.push(json!({ "id": id, "ok": true, "count": n, "optin": false }));
            }
            Err(e) => sources.push(json!({ "id": id, "ok": false, "count": 0, "optin": false, "error": e })),
        }
    }

    // Freshest first, then cap — a 30-day crime layer alone can exceed the working set.
    events.sort_by(|a, b| {
        let ta = a.get("ts").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let tb = b.get("ts").and_then(|x| x.as_f64()).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    events.truncate(700);

    let out = json!({ "events": events, "sources": sources, "ts": unix_now() });
    st.json
        .insert(
            key.clone(),
            Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(20) },
        )
        .await;
    Json(out).into_response()
}
