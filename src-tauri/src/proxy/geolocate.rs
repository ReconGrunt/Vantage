// GET /api/geolocate — coarse network (IP-based) geolocation, native port of the Express
// handler in server/index.js.
//
// Why this exists: the desktop shell renders in WebView2, which DENIES the browser
// Geolocation API unless the host app explicitly grants the permission (our capability set
// is core+updater only). Without a fallback, "Use my location" simply dead-ends in the
// packaged app. City-level accuracy is exactly the granularity a city activity map needs.
// Free, no key, cached 30 min so we stay a polite client.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::proxy::sources::{get_json, num};
use crate::server::{AppState, Cached};

const PROVIDERS: &[(&str, &str)] = &[
    ("ipwho.is", "https://ipwho.is/"),
    ("ipapi.co", "https://ipapi.co/json/"),
];

pub async fn handler(State(st): State<AppState>) -> Response {
    let key = "geo:self".to_string();
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() {
                o.insert("cached".into(), json!(true));
            }
            return Json(v).into_response();
        }
    }

    for (name, url) in PROVIDERS {
        if let Ok(d) = get_json(&st, url, "application/json").await {
            let lat = d.get("latitude").and_then(num);
            let lon = d.get("longitude").and_then(num);
            if let (Some(lat), Some(lon)) = (lat, lon) {
                let region = d
                    .get("region")
                    .and_then(|x| x.as_str())
                    .or_else(|| d.get("region_name").and_then(|x| x.as_str()));
                let out = json!({
                    "lat": lat,
                    "lon": lon,
                    "accuracyKm": 25,
                    "city": d.get("city").and_then(|x| x.as_str()).map(Value::from).unwrap_or(Value::Null),
                    "region": region.map(Value::from).unwrap_or(Value::Null),
                    "source": name,
                });
                st.json
                    .insert(
                        key.clone(),
                        Cached { value: Arc::new(out.clone()), good_until: Instant::now() + Duration::from_secs(30 * 60) },
                    )
                    .await;
                return Json(out).into_response();
            }
        }
    }

    // every provider failed — serve last-known if we have it
    if let Some(c) = st.json.get(&key).await {
        let mut v = (*c.value).clone();
        if let Some(o) = v.as_object_mut() {
            o.insert("stale".into(), json!(true));
        }
        return Json(v).into_response();
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({
            "lat": Value::Null, "lon": Value::Null, "accuracyKm": Value::Null,
            "city": Value::Null, "region": Value::Null, "source": Value::Null,
            "error": "geolocation unavailable"
        })),
    )
        .into_response()
}
