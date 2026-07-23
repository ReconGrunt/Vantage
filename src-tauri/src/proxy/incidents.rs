// GET /api/incidents?lat&lon&radius — Ground/City domain, native port of the fused
// incident route in server/index.js. The Node backend fans out to many city feeds; the
// native app mirrors the RESPONSE SHAPE and a keyless subset that works offline-first
// everywhere (USGS earthquakes + NWS active alerts — both free, no key, global/national).
// Response: { events: Event[], sources: [{id,ok,count}], ts }.  Event keys match Node's
// makeEvent exactly (see scripts/contract-smoke.mjs).

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

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
    radius: Option<String>,
}

fn num(v: &Value) -> Option<f64> {
    if v.is_null() {
        None
    } else if let Some(n) = v.as_f64() {
        Some(n)
    } else if let Some(s) = v.as_str() {
        s.trim().parse::<f64>().ok()
    } else {
        None
    }
}

async fn get_json(st: &AppState, url: &str, accept: &str) -> Result<Value, String> {
    let r = st
        .http
        .get(url)
        .header("User-Agent", UA)
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

fn make_event(
    source: &str, native: &str, kind: &str, sev: i64, lat: f64, lon: f64,
    title: &str, desc: &str, url: Value, ts: f64, expires: Value,
) -> Value {
    json!({
        "id": format!("{}:{}", source, native),
        "kind": kind,
        "severity": sev.clamp(0, 3),
        "lat": lat, "lon": lon,
        "title": title, "description": desc,
        "source": source, "sourceUrl": url,
        "ts": ts, "expiresTs": expires,
    })
}

async fn quakes(st: &AppState, mnlat: f64, mxlat: f64, mnlon: f64, mxlon: f64) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", "application/json").await?;
    let mut out = vec![];
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let c = match f.get("geometry").and_then(|g| g.get("coordinates")).and_then(|c| c.as_array()) {
                Some(c) if c.len() >= 2 => c,
                _ => continue,
            };
            let (lon, lat) = match (num(&c[0]), num(&c[1])) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };
            if lat < mnlat || lat > mxlat || lon < mnlon || lon > mxlon {
                continue;
            }
            let p = f.get("properties").cloned().unwrap_or_else(|| json!({}));
            let mag = p.get("mag").and_then(|m| m.as_f64()).unwrap_or(0.0);
            let sev = if mag >= 5.0 { 3 } else if mag >= 4.0 { 2 } else if mag >= 2.5 { 1 } else { 0 };
            let ts = p.get("time").and_then(|t| t.as_f64()).unwrap_or(0.0);
            let id = f.get("id").and_then(|i| i.as_str()).unwrap_or("q").to_string();
            out.push(make_event(
                "usgs-quake", &id, "quake", sev, lat, lon,
                &format!("M{:.1} earthquake", mag),
                p.get("place").and_then(|x| x.as_str()).unwrap_or(""),
                p.get("url").cloned().unwrap_or(Value::Null), ts, Value::Null,
            ));
        }
    }
    Ok(out)
}

async fn nws(st: &AppState, lat: f64, lon: f64) -> Result<Vec<Value>, String> {
    let url = format!("https://api.weather.gov/alerts/active?point={:.4},{:.4}", lat, lon);
    let d = get_json(st, &url, "application/geo+json").await?;
    let now_ms = (unix_now() as f64) * 1000.0;
    let mut out = vec![];
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let p = f.get("properties").cloned().unwrap_or_else(|| json!({}));
            let ev = p.get("event").and_then(|x| x.as_str()).unwrap_or("Weather alert");
            let sev = match p.get("severity").and_then(|x| x.as_str()).unwrap_or("") {
                "Extreme" => 3, "Severe" => 2, "Moderate" => 1, _ => 0,
            };
            let evl = ev.to_lowercase();
            let kind = if evl.contains("flood") || evl.contains("tsunami") || evl.contains("marine") || evl.contains("coastal") { "hazard" } else { "weather" };
            let id = p.get("id").and_then(|x| x.as_str()).unwrap_or("nws").to_string();
            // area-wide alert → pin at the observer (parity: Node uses geometry centroid
            // when present, else the observer; shape is identical either way).
            out.push(make_event(
                "nws-alerts", &id, kind, sev, lat, lon, ev,
                p.get("headline").and_then(|x| x.as_str())
                    .or_else(|| p.get("areaDesc").and_then(|x| x.as_str())).unwrap_or(""),
                p.get("uri").cloned().unwrap_or(Value::Null), now_ms, Value::Null,
            ));
        }
    }
    Ok(out)
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "lat and lon required", "events": [], "sources": [] }))).into_response(),
    };
    let radius = q.radius.as_deref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(30.0).min(120.0);
    let dlat = radius / 111.0;
    let dlon = radius / (111.0 * (lat.to_radians().cos()).abs().max(0.05));
    let (mnlat, mxlat, mnlon, mxlon) = (lat - dlat, lat + dlat, lon - dlon, lon + dlon);

    let key = format!("inc:{:.1},{:.1},{}", lat, lon, radius.round());
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() { o.insert("cached".into(), json!(true)); }
            return Json(v).into_response();
        }
    }

    // fan out (both guarded individually → a dead feed is {ok:false}, never fatal)
    let (q_res, n_res) = tokio::join!(quakes(&st, mnlat, mxlat, mnlon, mxlon), nws(&st, lat, lon));
    let mut events: Vec<Value> = vec![];
    let mut sources: Vec<Value> = vec![];
    match q_res {
        Ok(v) => { sources.push(json!({"id":"usgs-quake","ok":true,"count":v.len(),"optin":false})); events.extend(v); }
        Err(e) => sources.push(json!({"id":"usgs-quake","ok":false,"count":0,"optin":false,"error":e})),
    }
    match n_res {
        Ok(v) => { sources.push(json!({"id":"nws-alerts","ok":true,"count":v.len(),"optin":false})); events.extend(v); }
        Err(e) => sources.push(json!({"id":"nws-alerts","ok":false,"count":0,"optin":false,"error":e})),
    }
    events.sort_by(|a, b| b.get("ts").and_then(|x| x.as_f64()).unwrap_or(0.0)
        .partial_cmp(&a.get("ts").and_then(|x| x.as_f64()).unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
    events.truncate(700);

    let out = json!({ "events": events, "sources": sources, "ts": unix_now() });
    st.json.insert(key.clone(), Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(20) }).await;
    Json(out).into_response()
}
