// GET /api/aircraft?lat=..&lon=..&radius=..  — community ADS-B (adsb.lol -> adsb.fi).
// Faithful port of server/index.js: unit-normalised records (metres, m/s), airborne
// filter, 2 s freshness, serve-stale on total upstream failure.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use reqwest::header::USER_AGENT;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::server::{unix_now, AppState, Cached};

const ADSB_UA: &str =
    "Vantage/0.1 (all-domain situational awareness; github.com/ReconGrunt/vantage)";

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
    radius: Option<String>,
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "lat and lon required" })))
                .into_response()
        }
    };
    let radius_km = q
        .radius
        .as_deref()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| *v != 0.0)
        .unwrap_or(250.0)
        .min(600.0);
    let nm = ((radius_km / 1.852).round() as i64).min(250);

    let key = format!("ac:{:.2},{:.2},{}", lat, lon, nm);

    // Fresh cache hit -> return with cached:true.
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            return Json(with_flag(&c.value, "cached")).into_response();
        }
    }

    let sources = [
        format!("https://api.adsb.lol/v2/lat/{}/lon/{}/dist/{}", lat, lon, nm),
        format!("https://opendata.adsb.fi/api/v2/lat/{}/lon/{}/dist/{}", lat, lon, nm),
    ];

    let mut last_err = String::from("no source");
    for url in sources.iter() {
        match fetch(&st, url).await {
            Ok(list) => {
                let payload = json!({
                    "time": unix_now(),
                    "count": list.len(),
                    "aircraft": list,
                    "source": host_of(url),
                });
                st.json
                    .insert(
                        key.clone(),
                        Cached {
                            value: Arc::new(payload.clone()),
                            good_until: Instant::now() + Duration::from_millis(2000),
                        },
                    )
                    .await;
                return Json(payload).into_response();
            }
            Err(e) => last_err = e,
        }
    }

    // Both sources failed — serve last-known so the dome holds.
    if let Some(c) = st.json.get(&key).await {
        let mut v = (*c.value).clone();
        if let Some(o) = v.as_object_mut() {
            o.insert("stale".into(), json!(true));
            o.insert("error".into(), json!(last_err));
        }
        return Json(v).into_response();
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": last_err, "aircraft": [] })),
    )
        .into_response()
}

async fn fetch(st: &AppState, url: &str) -> Result<Vec<Value>, String> {
    let resp = st
        .http
        .get(url)
        .header(USER_AGENT, ADSB_UA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for {}", resp.status(), url));
    }
    let raw: Value = resp.json().await.map_err(|e| e.to_string())?;
    let list = raw
        .get("ac")
        .or_else(|| raw.get("aircraft"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list.iter().map(map_record).filter(airborne).collect())
}

/// One readsb/tar1090 record -> our named, unit-normalised object (metres, m/s).
fn map_record(a: &Value) -> Value {
    let on_ground = a.get("alt_baro").and_then(|v| v.as_str()) == Some("ground");
    let alt_ft: Option<f64> = if on_ground {
        Some(0.0)
    } else {
        a.get("alt_geom")
            .and_then(|v| v.as_f64())
            .or_else(|| a.get("alt_baro").and_then(|v| v.as_f64()))
    };
    let vr_fpm: Option<f64> = a
        .get("geom_rate")
        .and_then(|v| v.as_f64())
        .or_else(|| a.get("baro_rate").and_then(|v| v.as_f64()));
    let gs = a.get("gs").and_then(|v| v.as_f64());
    let track = a
        .get("track")
        .and_then(|v| v.as_f64())
        .or_else(|| a.get("true_heading").and_then(|v| v.as_f64()));
    let seen_pos = a
        .get("seen_pos")
        .and_then(|v| v.as_f64())
        .or_else(|| a.get("seen").and_then(|v| v.as_f64()))
        .unwrap_or(0.0);
    let db_flags = a.get("dbFlags").and_then(|v| v.as_i64()).unwrap_or(0);

    json!({
        "id": a.get("hex").cloned().unwrap_or(Value::Null),
        "callsign": a.get("flight").and_then(|v| v.as_str()).unwrap_or("").trim(),
        "country": Value::Null,
        "lon": a.get("lon").cloned().unwrap_or(Value::Null),
        "lat": a.get("lat").cloned().unwrap_or(Value::Null),
        "altitude": alt_ft.map(|f| f * 0.3048),
        "onGround": on_ground,
        "velocity": gs.map(|g| g * 0.514444),
        "heading": track,
        "verticalRate": vr_fpm.map(|v| v * 0.00508),
        "squawk": super::falsy_or_null(a, "squawk"),
        "type": super::falsy_or_null(a, "t"),
        "registration": super::falsy_or_null(a, "r"),
        "category": super::falsy_or_null(a, "category"),
        "military": (db_flags & 1) != 0,
        "seenPos": seen_pos,
    })
}

/// Airborne only: reject on-ground, no-altitude, and slow-AND-low traffic.
fn airborne(a: &Value) -> bool {
    if a.get("lat").and_then(|v| v.as_f64()).is_none()
        || a.get("lon").and_then(|v| v.as_f64()).is_none()
    {
        return false;
    }
    if a.get("onGround").and_then(|v| v.as_bool()) == Some(true) {
        return false;
    }
    let alt = match a.get("altitude").and_then(|v| v.as_f64()) {
        Some(m) if m > 0.0 => m,
        _ => return false,
    };
    let slow = a.get("velocity").and_then(|v| v.as_f64()).map_or(false, |v| v < 15.0);
    if slow && alt < 150.0 {
        return false;
    }
    true
}

fn with_flag(value: &Value, flag: &str) -> Value {
    let mut v = value.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert(flag.into(), json!(true));
    }
    v
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .unwrap_or_default()
}
