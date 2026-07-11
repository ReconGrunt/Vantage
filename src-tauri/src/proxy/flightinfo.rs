// GET /api/flightinfo?callsign=UAL123&icao24=a1b2c3  — route + airframe enrichment from
// adsbdb (free, no key). Hits cached 24 h, misses 1 h. Both lookups run concurrently and
// fail silently (missing data -> null), mirroring server/index.js.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::proxy::{falsy_or_null, to_num};
use crate::server::{AppState, Cached};

#[derive(Deserialize)]
pub struct Q {
    callsign: Option<String>,
    icao24: Option<String>,
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let callsign = q.callsign.unwrap_or_default().trim().to_uppercase();
    let icao24 = q.icao24.unwrap_or_default().trim().to_lowercase();
    let key = format!("fi:{}:{}", callsign, icao24);

    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() {
                o.insert("cached".into(), json!(true));
            }
            return Json(v).into_response();
        }
    }

    let (route, aircraft) = tokio::join!(fetch_route(&st, &callsign), fetch_aircraft(&st, &icao24));

    let out = json!({
        "callsign": callsign,
        "route": route.clone().unwrap_or(Value::Null),
        "aircraft": aircraft.clone().unwrap_or(Value::Null),
    });

    // Cache hits for 24 h; misses for 1 h (the flight may not be in adsbdb yet).
    let ttl = if route.is_some() || aircraft.is_some() {
        Duration::from_secs(24 * 3600)
    } else {
        Duration::from_secs(3600)
    };
    st.json
        .insert(
            key,
            Cached { value: Arc::new(out.clone()), good_until: Instant::now() + ttl },
        )
        .await;

    Json(out).into_response()
}

async fn fetch_route(st: &AppState, callsign: &str) -> Option<Value> {
    if callsign.is_empty() {
        return None;
    }
    let url = format!("https://api.adsbdb.com/v0/callsign/{}", urlenc(callsign));
    let d = get_json(st, &url).await?;
    let fr = d.get("response")?.get("flightroute")?;
    Some(json!({
        "origin": pick_airport(fr.get("origin")),
        "destination": pick_airport(fr.get("destination")),
        "airline": fr.get("airline").map(|a| falsy_or_null(a, "name")).unwrap_or(Value::Null),
    }))
}

async fn fetch_aircraft(st: &AppState, icao24: &str) -> Option<Value> {
    if icao24.is_empty() {
        return None;
    }
    let url = format!("https://api.adsbdb.com/v0/aircraft/{}", urlenc(icao24));
    let d = get_json(st, &url).await?;
    let ac = d.get("response")?.get("aircraft")?;
    Some(json!({
        "type": falsy_or_null(ac, "type"),
        "manufacturer": falsy_or_null(ac, "manufacturer"),
        "registration": falsy_or_null(ac, "registration"),
        "owner": falsy_or_null(ac, "registered_owner"),
    }))
}

fn pick_airport(a: Option<&Value>) -> Value {
    let a = match a {
        Some(v) if !v.is_null() => v,
        _ => return Value::Null,
    };
    let num = |k: &str| a.get(k).filter(|v| !v.is_null()).and_then(to_num);
    json!({
        "iata": falsy_or_null(a, "iata_code"),
        "icao": falsy_or_null(a, "icao_code"),
        "name": falsy_or_null(a, "name"),
        "municipality": falsy_or_null(a, "municipality"),
        "country": falsy_or_null(a, "country_name"),
        "lat": num("latitude"),
        "lon": num("longitude"),
    })
}

async fn get_json(st: &AppState, url: &str) -> Option<Value> {
    let r = st.http.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json::<Value>().await.ok()
}

/// Minimal path-segment percent-encoding (callsigns/hex are alphanumerics, but be safe).
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
