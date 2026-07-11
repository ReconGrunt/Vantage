// GET /api/weather?lat=..&lon=..  — Open-Meteo current conditions, 10-min freshness,
// serve-stale on failure. Field defaults mirror server/index.js exactly.

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

use crate::proxy::coalesce;
use crate::server::{AppState, Cached};

#[derive(Deserialize)]
pub struct Q {
    lat: Option<String>,
    lon: Option<String>,
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let lat = q.lat.as_deref().and_then(|s| s.parse::<f64>().ok());
    let lon = q.lon.as_deref().and_then(|s| s.parse::<f64>().ok());
    let (lat, lon) = match (lat, lon) {
        (Some(a), Some(b)) if a.is_finite() && b.is_finite() => (a, b),
        _ => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "lat/lon required" })))
                .into_response()
        }
    };

    let key = format!("wx:{:.2},{:.2}", lat, lon);
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            let mut v = (*c.value).clone();
            if let Some(o) = v.as_object_mut() {
                o.insert("cached".into(), json!(true));
            }
            return Json(v).into_response();
        }
    }

    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}\
&current=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,visibility,\
weather_code,temperature_2m,wind_speed_10m,wind_direction_10m,is_day",
        lat, lon
    );

    match fetch_json(&st, &url).await {
        Ok(d) => {
            let c = d.get("current").cloned().unwrap_or_else(|| json!({}));
            let out = json!({
                "cloudCover": coalesce(&c, "cloud_cover", json!(0)),
                "cloudLow": coalesce(&c, "cloud_cover_low", Value::Null),
                "cloudMid": coalesce(&c, "cloud_cover_mid", Value::Null),
                "cloudHigh": coalesce(&c, "cloud_cover_high", Value::Null),
                "visibility": coalesce(&c, "visibility", Value::Null),
                "weatherCode": coalesce(&c, "weather_code", Value::Null),
                "temperature": coalesce(&c, "temperature_2m", Value::Null),
                "windSpeed": coalesce(&c, "wind_speed_10m", Value::Null),
                "windDir": coalesce(&c, "wind_direction_10m", json!(0)),
                "isDay": coalesce(&c, "is_day", Value::Null),
            });
            st.json
                .insert(
                    key.clone(),
                    Cached {
                        value: Arc::new(out.clone()),
                        good_until: Instant::now() + Duration::from_secs(10 * 60),
                    },
                )
                .await;
            Json(out).into_response()
        }
        Err(e) => {
            if let Some(c) = st.json.get(&key).await {
                let mut v = (*c.value).clone();
                if let Some(o) = v.as_object_mut() {
                    o.insert("stale".into(), json!(true));
                }
                return Json(v).into_response();
            }
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e, "cloudCover": 0 })),
            )
                .into_response()
        }
    }
}

async fn fetch_json(st: &AppState, url: &str) -> Result<Value, String> {
    let r = st.http.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    r.json::<Value>().await.map_err(|e| e.to_string())
}
