// GET /api/cameras?lat&lon&radius — Ground/City domain public-camera catalog, native
// port of server/index.js. Mirrors the RESPONSE SHAPE and a keyless subset: Caltrans
// CWWP2 CCTV (explicitly free, no key), fetching only the district(s) near the observer.
// Response: { cameras: Camera[], ts }. Camera keys match Node's makeCamera exactly.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::{AppState, Cached, unix_now};

const UA: &str = "Vantage/0.1 (all-domain situational awareness; +github.com/ReconGrunt/vantage)";

// district number + rough region bbox (minLat,maxLat,minLon,maxLon)
const DISTRICTS: &[(u32, f64, f64, f64, f64)] = &[
    (3, 38.2, 39.6, -122.1, -119.9),
    (4, 36.9, 38.6, -123.2, -121.2),
    (7, 33.6, 34.9, -119.7, -117.6),
    (8, 33.4, 35.5, -117.8, -114.4),
    (11, 32.5, 33.5, -117.7, -114.5),
    (12, 33.4, 33.98, -118.2, -117.4),
];

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
    radius: Option<String>,
}

fn num(v: &Value) -> Option<f64> {
    if v.is_null() { None }
    else if let Some(n) = v.as_f64() { Some(n) }
    else if let Some(s) = v.as_str() { s.trim().parse::<f64>().ok() }
    else { None }
}

async fn get_json(st: &AppState, url: &str) -> Result<Value, String> {
    let r = st.http.get(url).header("User-Agent", UA).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() { return Err(format!("{} for {}", r.status(), url)); }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

async fn district(st: &AppState, d: u32, mnlat: f64, mxlat: f64, mnlon: f64, mxlon: f64) -> Result<Vec<Value>, String> {
    let url = format!("https://cwwp2.dot.ca.gov/data/d{}/cctv/cctvStatusD{:02}.json", d, d);
    let data = get_json(st, &url).await?;
    let mut out = vec![];
    if let Some(arr) = data.get("data").and_then(|x| x.as_array()) {
        for rec in arr {
            let c = match rec.get("cctv") { Some(c) => c, None => continue };
            let loc = c.get("location").cloned().unwrap_or_else(|| json!({}));
            let (lat, lon) = match (num(loc.get("latitude").unwrap_or(&Value::Null)), num(loc.get("longitude").unwrap_or(&Value::Null))) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            if lat < mnlat || lat > mxlat || lon < mnlon || lon > mxlon { continue; }
            let still = c.get("imageData").and_then(|i| i.get("static")).and_then(|s| s.get("currentImageURL")).and_then(|u| u.as_str());
            let stream = c.get("imageData").and_then(|i| i.get("streamingVideoURL")).and_then(|u| u.as_str());
            if still.is_none() && stream.is_none() { continue; }
            let idx = c.get("index").and_then(|x| x.as_str()).map(|s| s.to_string())
                .or_else(|| c.get("index").and_then(|x| x.as_u64()).map(|n| n.to_string()))
                .unwrap_or_else(|| format!("{:.5},{:.5}", lat, lon));
            let name = loc.get("locationName").and_then(|x| x.as_str())
                .or_else(|| loc.get("nearbyPlace").and_then(|x| x.as_str())).unwrap_or("Caltrans CCTV");
            out.push(json!({
                "id": format!("caltrans:{}", idx),
                "name": name, "lat": lat, "lon": lon,
                "still": still.map(Value::from).unwrap_or(Value::Null),
                "stream": stream.map(Value::from).unwrap_or(Value::Null),
                "provider": "caltrans", "proxied": false,
            }));
        }
    }
    Ok(out)
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "lat and lon required", "cameras": [] }))).into_response(),
    };
    let radius = q.radius.as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(30.0).min(120.0);
    let dlat = radius / 111.0;
    let dlon = radius / (111.0 * (lat.to_radians().cos()).abs().max(0.05));
    let (mnlat, mxlat, mnlon, mxlon) = (lat - dlat, lat + dlat, lon - dlon, lon + dlon);

    let key = format!("cam:{:.1},{:.1},{}", lat, lon, radius.round());
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() { o.insert("cached".into(), json!(true)); }
            return Json(v).into_response();
        }
    }

    let mut cameras: Vec<Value> = vec![];
    for &(d, rlat0, rlat1, rlon0, rlon1) in DISTRICTS {
        // skip districts whose region doesn't overlap the query bbox
        if mnlat > rlat1 || mxlat < rlat0 || mnlon > rlon1 || mxlon < rlon0 { continue; }
        if let Ok(v) = district(&st, d, mnlat, mxlat, mnlon, mxlon).await { cameras.extend(v); }
    }

    let out = json!({ "cameras": cameras, "ts": unix_now() });
    st.json.insert(key.clone(), Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(10 * 60) }).await;
    Json(out).into_response()
}
