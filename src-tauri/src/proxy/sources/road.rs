// road.rs — REAL-TIME California road activity: Caltrans Lane Closure System (LCS) and
// Changeable Message Signs (CMS). Native mirror of server/sources/caltrans-{lcs,cms}.js.
//
// This is the live backbone for Los Angeles, which publishes no real-time police/fire
// dispatch feed at all. Two design points carried over from the Node side:
//
// 1. ACTIVE-NOW FILTERING. LCS is mostly *scheduled* work (D07 alone carries ~4,800
//    records, most in the future). There's no status field — a closure is live only when
//    closureStartEpoch <= now <= closureEndEpoch, or the end is indefinite.
//
// 2. NON-BLOCKING WARM CACHE. The D07 payload is ~14 MB, far more than the shared 8 s
//    HTTP client allows. A stale district spawns a BACKGROUND refresh (on the no-total-
//    timeout `stream` client) and we serve the last-known set immediately, so the request
//    path never stalls and the raw payload never reaches a client.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{get_json, make_event, num, s_of, Bbox};
use crate::server::{unix_now, AppState, Cached};

const DISTRICTS: &[(u32, (f64, f64, f64, f64))] = &[
    (3, (38.2, 39.6, -122.1, -119.9)),
    (4, (36.9, 38.6, -123.2, -121.2)),
    (7, (33.6, 34.9, -119.7, -117.6)), // LA / Ventura
    (8, (33.4, 35.5, -117.8, -114.4)),
    (11, (32.5, 33.5, -117.7, -114.5)),
    (12, (33.4, 33.98, -118.2, -117.4)),
];

// ---------------------------------------------------------------- LCS (lane closures)

const STANDING_SECS: i64 = 7 * 24 * 60 * 60; // active > 7 days = standing condition

fn severity_of(c: &Value, start_epoch: i64, now_sec: i64) -> i64 {
    // Mirrors server/sources/caltrans-lcs.js: a closure in effect for weeks (permanent hwy
    // closures, long bridge works) is a STANDING CONDITION, not an incident. Left at full
    // severity it dominates the severity-sorted list — real LA data had multi-year
    // "Landscape Work" full closures outranking message-sign alerts from seconds ago.
    if now_sec - start_epoch > STANDING_SECS {
        return 1;
    }
    match s_of(c, "typeOfClosure") {
        "Full" => 3,
        "One-Way Traffic" | "Traffic Break" => 2,
        _ => {
            let closed = s_of(c, "lanesClosed").parse::<f64>().ok();
            let total = s_of(c, "totalExistingLanes").parse::<f64>().ok();
            match (closed, total) {
                (Some(cl), Some(tt)) if tt > 0.0 && cl / tt >= 0.5 => 2,
                _ => 1,
            }
        }
    }
}

fn active_now(c: &Value, now_sec: i64) -> (bool, Option<i64>) {
    let ts = match c.get("closureTimestamp") {
        Some(t) => t,
        None => return (false, None),
    };
    let start = s_of(ts, "closureStartEpoch").parse::<i64>().ok();
    let end = s_of(ts, "closureEndEpoch").parse::<i64>().ok();
    let started = matches!(start, Some(s) if now_sec >= s);
    if !started {
        return (false, end);
    }
    if s_of(ts, "isClosureEndIndefinite") == "true" {
        return (true, None);
    }
    match end {
        Some(e) => (now_sec <= e, Some(e)),
        None => (true, None),
    }
}

/// Download + normalise one district. Uses the `stream` client (connect timeout only) —
/// the shared 8 s client would abort the ~14 MB D07 file.
async fn load_lcs(st: &AppState, d: u32) -> Result<Vec<Value>, String> {
    let url = format!("https://cwwp2.dot.ca.gov/data/d{}/lcs/lcsStatusD{:02}.json", d, d);
    let r = st
        .stream
        .get(&url)
        .header("User-Agent", super::UA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    let raw: Value = r.json().await.map_err(|e| e.to_string())?;
    let now_sec = unix_now() as i64;
    let mut out = Vec::new();
    let empty: Vec<Value> = Vec::new();
    for rec in raw.get("data").and_then(|x| x.as_array()).unwrap_or(&empty) {
        let l = match rec.get("lcs") {
            Some(l) => l,
            None => continue,
        };
        let c = match l.get("closure") {
            Some(c) => c,
            None => continue,
        };
        let (live, end) = active_now(c, now_sec);
        if !live {
            continue;
        }
        let b = match l.get("location").and_then(|x| x.get("begin")) {
            Some(b) => b,
            None => continue,
        };
        let (la, lo) = match (b.get("beginLatitude").and_then(num), b.get("beginLongitude").and_then(num)) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        let work = match s_of(c, "typeOfWork") {
            "" | "Not Reported" => "closure",
            w => w,
        };
        let kind_of = match s_of(c, "typeOfClosure") {
            "" => "Lane",
            t => t,
        };
        let where_parts: Vec<&str> = ["beginRoute", "beginLocationName", "beginNearbyPlace"]
            .iter()
            .map(|k| s_of(b, k))
            .filter(|v| !v.is_empty() && *v != "Not Reported")
            .collect();
        let delay = match s_of(c, "estimatedDelay") {
            "" | "Not Reported" => String::new(),
            dl => format!(" · delay {}", dl),
        };
        let start_epoch = c
            .get("closureTimestamp")
            .map(|t| s_of(t, "closureStartEpoch"))
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(now_sec);
        let native = format!("{}-{}", s_of(c, "closureID"), s_of(c, "logNumber"));
        if let Some(ev) = make_event(
            "caltrans-lcs",
            &native,
            "traffic",
            severity_of(c, start_epoch, now_sec),
            la,
            lo,
            &format!("{} closure — {}", kind_of, work),
            &format!("{}{}", where_parts.join(" · "), delay),
            Value::from("https://quickmap.dot.ca.gov"),
            (start_epoch as f64) * 1000.0,
            end.map(|e| Value::from((e as f64) * 1000.0)).unwrap_or(Value::Null),
        ) {
            out.push(ev);
        }
    }
    Ok(out)
}

pub async fn lcs(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for &(d, region) in DISTRICTS {
        if !b.intersects(region) {
            continue;
        }
        let key = format!("lcs:d{}", d);
        let cached = st.json.get(&key).await;
        let stale = match &cached {
            Some(c) => Instant::now() >= c.good_until,
            None => true,
        };
        if stale {
            // fire-and-forget: never block the request path on a 14 MB download
            let st2 = st.clone();
            let k2 = key.clone();
            tokio::spawn(async move {
                if let Ok(evs) = load_lcs(&st2, d).await {
                    st2.json
                        .insert(
                            k2,
                            Cached {
                                value: Arc::new(Value::Array(evs)),
                                good_until: Instant::now() + Duration::from_secs(60),
                            },
                        )
                        .await;
                }
            });
        }
        if let Some(c) = cached {
            if let Some(arr) = c.value.as_array() {
                for e in arr {
                    if let (Some(la), Some(lo)) = (e.get("lat").and_then(|x| x.as_f64()), e.get("lon").and_then(|x| x.as_f64())) {
                        if b.contains(la, lo) {
                            out.push(e.clone());
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

// ------------------------------------------------------------ CMS (message signs)

fn message_text(m: &Value) -> String {
    match m.get("display").and_then(|d| d.as_str()) {
        None | Some("Blank") => return String::new(),
        _ => {}
    }
    let mut parts: Vec<String> = Vec::new();
    for phase in ["phase1", "phase2", "phase3"] {
        if let Some(p) = m.get(phase).and_then(|x| x.as_object()) {
            for (k, v) in p {
                if !k.contains("Line") {
                    continue;
                }
                if let Some(s) = v.as_str() {
                    if !s.is_empty() && s != "Not Reported" {
                        parts.push(s.trim().to_string());
                    }
                }
            }
        }
    }
    parts.retain(|s| !s.is_empty());
    parts.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cms_severity(text: &str) -> i64 {
    let t = text.to_lowercase();
    for w in ["amber alert", "silver alert", "fatal", "closed", "full closure", "evacuat"] {
        if t.contains(w) {
            return 3;
        }
    }
    for w in ["accident", "crash", "collision", "incident", "delay", "stalled", "fire", "police activity"] {
        if t.contains(w) {
            return 2;
        }
    }
    1
}

pub async fn cms(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for &(d, region) in DISTRICTS {
        if !b.intersects(region) {
            continue;
        }
        let url = format!("https://cwwp2.dot.ca.gov/data/d{}/cms/cmsStatusD{:02}.json", d, d);
        let raw = match get_json(st, &url, "application/json").await {
            Ok(v) => v,
            Err(_) => continue, // one dead district must not kill the rest
        };
        let empty: Vec<Value> = Vec::new();
        for rec in raw.get("data").and_then(|x| x.as_array()).unwrap_or(&empty) {
            let c = match rec.get("cms") {
                Some(c) => c,
                None => continue,
            };
            if s_of(c, "inService") == "false" {
                continue;
            }
            let text = match c.get("message") {
                Some(m) => message_text(m),
                None => String::new(),
            };
            if text.is_empty() {
                continue; // sign is blank — nothing happening
            }
            let loc = match c.get("location") {
                Some(l) => l,
                None => continue,
            };
            let (la, lo) = match (loc.get("latitude").and_then(num), loc.get("longitude").and_then(num)) {
                (Some(a), Some(o)) => (a, o),
                _ => continue,
            };
            if !b.contains(la, lo) {
                continue;
            }
            let where_parts: Vec<&str> = ["route", "locationName", "nearbyPlace"]
                .iter()
                .map(|k| s_of(loc, k))
                .filter(|v| !v.is_empty() && *v != "Not Reported")
                .collect();
            let title: String = text.chars().take(120).collect();
            if let Some(ev) = make_event(
                "caltrans-cms",
                s_of(c, "index"),
                "traffic",
                cms_severity(&text),
                la,
                lo,
                &title,
                &format!("Freeway sign · {}", where_parts.join(" · ")),
                Value::from("https://quickmap.dot.ca.gov"),
                (unix_now() as f64) * 1000.0,
                Value::Null,
            ) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}
