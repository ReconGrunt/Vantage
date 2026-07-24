// gray.rs — native mirror of the opt-in "gray" Node adapters (gray/*.js). All DEFAULT OFF;
// each runs only when its explicit flag is set (gated at the fan-out by the registry's
// enabled predicate). Same guardrails as Node: strictly aggregate / place-centric — never a
// person, handle, or device; only "something is happening here". Degrade to empty on failure.

use serde_json::Value;

use super::{get_json, kind_from_text, make_event, now_ms, num, parse_iso_ms, s_of, sev_from_text, Bbox};
use crate::server::AppState;

const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

// --- Citizen (unofficial incident search, place/event-centric) --------------------------
pub async fn citizen(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    // insideBoundingBox[0..3] = S, W, N, E
    let url = format!(
        "https://citizen.com/api/incident/search?insideBoundingBox[0]={}&insideBoundingBox[1]={}&insideBoundingBox[2]={}&insideBoundingBox[3]={}&limit=200",
        b.min_lat, b.min_lon, b.max_lat, b.max_lon
    );
    let resp = st
        .http
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/json")
        .header("Referer", "https://citizen.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for citizen", resp.status()));
    }
    let d: Value = resp.json().await.map_err(|e| e.to_string())?;
    let list = d.get("results").or_else(|| d.get("hits")).or_else(|| d.get("incidents"))
        .and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for r in &list {
        let la = num_any(r, &["latitude", "lat"]).or_else(|| ll(r, 0));
        let lo = num_any(r, &["longitude", "lng", "lon"]).or_else(|| ll(r, 1));
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let title = {
            let t = s_of(r, "title");
            if !t.is_empty() { t.to_string() } else { let raw = s_of(r, "raw"); if raw.is_empty() { "Reported incident".into() } else { raw.to_string() } }
        };
        let sev = r.get("severity").and_then(num).map(|n| n as i64).unwrap_or_else(|| sev_from_text(&title));
        let ts = num_any(r, &["cs", "created_at", "ts"]).or_else(|| parse_iso_ms(s_of(r, "created_at"))).unwrap_or_else(now_ms);
        let key = s_of(r, "key");
        let native = if !key.is_empty() { key.to_string() } else { let id = s_of(r, "id"); if id.is_empty() { format!("{:.5},{:.5}", la, lo) } else { id.to_string() } };
        let desc = { let a = s_of(r, "address"); if !a.is_empty() { a } else { s_of(r, "neighborhood") } };
        let src = if !key.is_empty() { format!("https://citizen.com/incident/{}", key) } else { "https://citizen.com".into() };
        if let Some(ev) = make_event("citizen", &native, kind_from_text(&title), sev, la, lo, &title, desc, Value::from(src), ts, Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- Snap Map (ONE aggregate density marker at the query centre; never a person) ---------
pub async fn snapmap(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let epoch = snap_latest_epoch(st).await?;
    let epoch = match epoch {
        Some(e) => e,
        None => return Ok(vec![]),
    };
    let radius = (b.radius_km * 1000.0).min(15000.0);
    let body = format!(
        "{{\"requestGeoPoint\":{{\"lat\":{},\"lon\":{}}},\"zoomLevel\":12,\"tileSetId\":{{\"flavor\":\"default\",\"epoch\":{},\"type\":1}},\"radiusMeters\":{},\"maximumFuzzRadius\":0}}",
        b.lat, b.lon, epoch, radius
    );
    let resp = st
        .http
        .post("https://ms.sc-jpl.com/web/getPlaylist")
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0")
        .header("Origin", "https://map.snapchat.com")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for snap getPlaylist", resp.status()));
    }
    let d: Value = resp.json().await.map_err(|e| e.to_string())?;
    let n = d.get("manifest").and_then(|m| m.get("elements")).and_then(|e| e.as_array()).map(|a| a.len()).unwrap_or(0);
    if n == 0 {
        return Ok(vec![]);
    }
    let sev = if n >= 25 { 2 } else if n >= 8 { 1 } else { 0 };
    let native = format!("heat:{:.2},{:.2}", b.lat, b.lon);
    let title = format!("Public Snap activity: {} recent stories nearby", n);
    Ok(make_event("snapmap", &native, "social", sev, b.lat, b.lon, &title, "Aggregate place-activity signal (no individuals).", Value::from("https://map.snapchat.com"), now_ms(), Value::Null)
        .into_iter()
        .collect())
}

async fn snap_latest_epoch(st: &AppState) -> Result<Option<i64>, String> {
    let resp = st
        .http
        .post("https://ms.sc-jpl.com/web/getLatestTileSet")
        .header("Content-Type", "application/json")
        .header("User-Agent", "Mozilla/5.0")
        .header("Origin", "https://map.snapchat.com")
        .body("{}")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for snap tileset", resp.status()));
    }
    let d: Value = resp.json().await.map_err(|e| e.to_string())?;
    let infos = d.get("tileSetInfos").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let heat = infos.iter().find(|i| {
        i.get("id").and_then(|id| id.get("type")).and_then(|t| t.as_str()).map(|t| t.to_uppercase().contains("HEAT")).unwrap_or(false)
    }).or_else(|| infos.first());
    Ok(heat.and_then(|h| h.get("id")).and_then(|id| id.get("epoch")).and_then(|e| e.as_i64().or_else(|| e.as_str().and_then(|s| s.parse().ok()))))
}

// --- OpenMHz scanner activity (aggregate "radio busy" marker per configured system) ------
pub async fn scanner(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for sys in &st.cfg.scanner_systems {
        if !b.contains(sys.lat, sys.lon) {
            continue;
        }
        let ev = match scanner_one(st, sys).await {
            Ok(e) => e,
            Err(_) => continue, // one dead system must not kill the rest
        };
        if let Some(e) = ev {
            out.push(e);
        }
    }
    Ok(out)
}

async fn scanner_one(st: &AppState, sys: &super::registry::ScannerSys) -> Result<Option<Value>, String> {
    let url = format!("https://api.openmhz.com/{}/calls", sys.short_name);
    let resp = st
        .http
        .get(&url)
        .header("User-Agent", BROWSER_UA)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for openmhz", resp.status()));
    }
    let d: Value = resp.json().await.map_err(|e| e.to_string())?;
    let calls = d.get("calls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if calls.is_empty() {
        return Ok(None);
    }
    let now = now_ms();
    let recent = calls.iter().filter(|c| now - parse_iso_ms(s_of(c, "time")).unwrap_or(0.0) < 15.0 * 60_000.0).count();
    let recent = if recent > 0 { recent } else { calls.len() };
    let sev = if recent >= 20 { 2 } else if recent >= 5 { 1 } else { 0 };
    let native = format!("activity:{}", sys.short_name);
    let title = format!("{}: {} radio calls (15 min)", sys.label, recent);
    let src = format!("https://openmhz.com/system/{}", sys.short_name);
    Ok(make_event("scanner", &native, "police", sev, sys.lat, sys.lon, &title, "Aggregate scanner activity (no audio / no persons).", Value::from(src), now, Value::Null))
}

// --- Bluesky public search (ONE aggregate chatter marker at the observer) ----------------
pub async fn bluesky(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let q = match &st.cfg.bluesky_query {
        Some(q) => q,
        None => return Ok(vec![]),
    };
    let url = format!("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q={}&limit=25&sort=latest", urlq(q));
    let d = get_json(st, &url, "application/json").await?;
    let posts = d.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let now = now_ms();
    let fresh = posts.iter().filter(|p| now - parse_iso_ms(s_of(p, "indexedAt")).unwrap_or(0.0) < 6.0 * 3600.0 * 1000.0).count();
    let recent = if fresh > 0 { fresh } else { posts.len() };
    if recent == 0 {
        return Ok(vec![]);
    }
    let sev = if recent >= 20 { 2 } else if recent >= 8 { 1 } else { 0 };
    let native = format!("chatter:{}", q);
    let title = format!("Social chatter: {} recent Bluesky posts on \"{}\"", recent, q);
    Ok(make_event("bluesky", &native, "social", sev, b.lat, b.lon, &title, "Aggregate place-activity signal (no individuals).", Value::from("https://bsky.app"), now, Value::Null)
        .into_iter()
        .collect())
}

// --- PulsePoint — KNOWN BROKEN upstream (AES passphrase derivation yields "bad decrypt").
// Ported for catalog parity only; reports the failure honestly like Node, and deliberately
// does NOT pull in an AES/MD5 crate to reproduce a non-working path.
pub async fn pulsepoint(st: &AppState, _b: &Bbox) -> Result<Vec<Value>, String> {
    if let Some(agency) = st.cfg.pulsepoint_agencies.first() {
        let url = format!("https://web.pulsepoint.org/DB/giba.php?agency_id={}", agency);
        let _ = get_json(st, &url, "application/json").await; // real attempt, like Node
    }
    Err("pulsepoint: AES passphrase derivation broken (bad decrypt) — parity with Node".into())
}

// --- small helpers ----------------------------------------------------------------------
fn num_any(v: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|k| v.get(*k).and_then(num))
}
fn ll(v: &Value, i: usize) -> Option<f64> {
    v.get("ll").and_then(|a| a.as_array()).and_then(|a| a.get(i)).and_then(num)
}
/// Minimal percent-encoding for a query value (space + a few reserved chars).
fn urlq(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            ' ' => out.push_str("%20"),
            _ => {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}
