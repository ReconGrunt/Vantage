// Live ATC audio (LiveATC.net). GET /api/atc lists host-verified facilities with coords;
// GET /api/atc/:feed resolves the current regional Icecast host and stream-proxies it.
//
// Drop-to-cancel: when the client closes, axum drops the response body, which drops the
// reqwest stream, which closes the upstream socket — simpler and more correct than the
// Node backend's manual drain/close loop.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use reqwest::header::{REFERER, USER_AGENT};
use serde_json::{json, Value};

use crate::server::AppState;

// id, label, lat, lon — insertion order matches server/index.js.
const FEEDS: &[(&str, &str, f64, f64)] = &[
    ("klax_twr", "KLAX Tower", 33.9425, -118.4081),
    ("ksfo_twr", "KSFO Tower", 37.6189, -122.3750),
    ("kdal_twr", "KDAL Tower", 32.8470, -96.8518),
    ("kdtw_twr", "KDTW Tower", 42.2124, -83.3534),
    ("kjfk_twr", "KJFK Tower", 40.6398, -73.7789),
    ("klga_twr", "LaGuardia Tower", 40.7769, -73.8740),
    ("kewr_twr", "KEWR Tower", 40.6925, -74.1687),
    ("katl_twr", "KATL Tower", 33.6367, -84.4281),
];
const ATC_HOSTS: &[&str] = &["s1-bos", "s1-fmt2", "s1-sjc"];
const ATC_UA: &str = "Mozilla/5.0";
const ATC_REFERER: &str = "https://www.liveatc.net/";

/// GET /api/atc — list feeds (with coords) so the client can pick the nearest.
pub async fn list() -> Json<Value> {
    let feeds: Vec<Value> = FEEDS
        .iter()
        .map(|(id, label, lat, lon)| json!({ "id": id, "label": label, "lat": lat, "lon": lon }))
        .collect();
    Json(json!({ "feeds": feeds }))
}

/// GET /api/atc/:feed — stream-proxy one facility.
pub async fn stream(State(st): State<AppState>, Path(feed): Path<String>) -> Response {
    let feed = sanitize(&feed);
    let label = match FEEDS.iter().find(|(id, ..)| *id == feed) {
        Some((_, label, ..)) => *label,
        None => return (StatusCode::NOT_FOUND, Json(json!({ "error": "unknown feed" }))).into_response(),
    };

    let url = match resolve_url(&st, &feed).await {
        Some(u) => u,
        None => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "feed offline" }))).into_response(),
    };

    let upstream = match st
        .stream
        .get(&url)
        .header(USER_AGENT, ATC_UA)
        .header(REFERER, ATC_REFERER)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": "stream unavailable" }))).into_response(),
    };

    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("audio/mpeg")
        .to_string();
    let name = upstream
        .headers()
        .get("icy-name")
        .and_then(|v| v.to_str().ok())
        .map(String::from)
        .unwrap_or_else(|| label.to_string());

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Atc-Name", name)
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap()
}

/// Find which regional Icecast host currently serves a feed; cache the winner 30 min.
async fn resolve_url(st: &AppState, feed: &str) -> Option<String> {
    let ck = format!("atcurl:{}", feed);
    if let Some(u) = st.atc_urls.get(&ck).await {
        return Some(u);
    }
    for h in ATC_HOSTS {
        let url = format!("https://{}.liveatc.net/{}", h, feed);
        let probe = st
            .http
            .get(&url)
            .header(USER_AGENT, ATC_UA)
            .header(REFERER, ATC_REFERER)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await;
        if let Ok(r) = probe {
            let ct = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            // dropping `r` cancels the probe body (we only needed the headers)
            if r.status().is_success() && ct.contains("audio") {
                st.atc_urls.insert(ck, url.clone()).await;
                return Some(url);
            }
        }
    }
    None
}

fn sanitize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
        .collect()
}
