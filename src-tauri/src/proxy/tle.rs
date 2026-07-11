// GET /api/tle?group=visual  — CelesTrak GP/TLE elements, parsed to {name,line1,line2}.
// 6 h freshness, serve-stale on failure. Group allow-list mirrors server/index.js.

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

use crate::server::{AppState, Cached};

const ALLOWED: &[&str] = &[
    "stations", "visual", "starlink", "gps-ops", "galileo", "glo-ops", "science", "weather",
    "noaa", "goes", "geo", "active", "last-30-days",
];

#[derive(Deserialize)]
pub struct Q {
    group: Option<String>,
}

pub async fn handler(State(st): State<AppState>, Query(q): Query<Q>) -> Response {
    let group = q.group.unwrap_or_else(|| "visual".into()).to_lowercase();
    if !ALLOWED.contains(&group.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown group \"{}\"", group) })),
        )
            .into_response();
    }

    let key = format!("tle:{}", group);
    if let Some(c) = st.json.get(&key).await {
        if Instant::now() < c.good_until {
            return Json(wrap(&group, &c.value, Some("cached"))).into_response();
        }
    }

    let url = format!(
        "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle",
        group
    );
    match fetch_text(&st, &url).await {
        Ok(text) => {
            let sats = Value::Array(parse_tle(&text));
            st.json
                .insert(
                    key.clone(),
                    Cached {
                        value: Arc::new(sats.clone()),
                        good_until: Instant::now() + Duration::from_secs(6 * 3600),
                    },
                )
                .await;
            Json(wrap(&group, &sats, None)).into_response()
        }
        Err(e) => {
            if let Some(c) = st.json.get(&key).await {
                return Json(wrap(&group, &c.value, Some("stale"))).into_response();
            }
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": e, "sats": [] }))).into_response()
        }
    }
}

/// Build the response envelope around the cached `sats` array.
fn wrap(group: &str, sats: &Value, flag: Option<&str>) -> Value {
    let count = sats.as_array().map(|a| a.len()).unwrap_or(0);
    let mut out = json!({ "group": group, "count": count, "sats": sats });
    if let (Some(f), Some(o)) = (flag, out.as_object_mut()) {
        o.insert(f.into(), json!(true));
    }
    out
}

fn parse_tle(text: &str) -> Vec<Value> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.trim().is_empty())
        .collect();
    let mut sats = Vec::new();
    let mut i = 0;
    while i + 2 < lines.len() {
        let name = lines[i].trim();
        let l1 = lines[i + 1];
        let l2 = lines[i + 2];
        if !name.is_empty() && l1.starts_with("1 ") && l2.starts_with("2 ") {
            sats.push(json!({ "name": name, "line1": l1, "line2": l2 }));
        }
        i += 3;
    }
    sats
}

async fn fetch_text(st: &AppState, url: &str) -> Result<String, String> {
    let r = st.http.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    r.text().await.map_err(|e| e.to_string())
}
