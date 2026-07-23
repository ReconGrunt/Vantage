// Natural-hazard + weather feeds — native mirror of server/sources/{usgs,nws,iem,eonet,
// gdacs,nwps}.js. All keyless and national/global, so the desktop app has real hazard
// coverage everywhere, not just in cities with an open CAD feed.

use serde_json::Value;

use super::arcgis::centroid;
use super::{get_json, make_event, now_ms, num, parse_iso_ms, s_of, Bbox};
use crate::server::AppState;

/// Depth-first search for the first [lon, lat] pair in an arbitrarily nested coord array.
fn first_lonlat(v: &Value) -> Option<(f64, f64)> {
    if let Some(a) = v.as_array() {
        if a.len() >= 2 && a[0].is_number() && a[1].is_number() {
            return Some((a[0].as_f64()?, a[1].as_f64()?));
        }
        for x in a {
            if let Some(r) = first_lonlat(x) {
                return Some(r);
            }
        }
    }
    None
}

fn has_any(s: &str, words: &[&str]) -> bool {
    words.iter().any(|w| s.contains(w))
}

// --- USGS earthquakes (global, last 24 h) -----------------------------------------
pub async fn quakes(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", "application/json").await?;
    let mut out = Vec::new();
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let c = match f.get("geometry").and_then(|g| g.get("coordinates")).and_then(|c| c.as_array()) {
                Some(c) if c.len() >= 2 => c,
                _ => continue,
            };
            let (lo, la) = match (num(&c[0]), num(&c[1])) {
                (Some(x), Some(y)) => (x, y),
                _ => continue,
            };
            if !b.contains(la, lo) {
                continue;
            }
            let p = f.get("properties").cloned().unwrap_or(Value::Null);
            let mag = p.get("mag").and_then(|m| m.as_f64()).unwrap_or(0.0);
            let sev = if mag >= 5.0 { 3 } else if mag >= 4.0 { 2 } else if mag >= 2.5 { 1 } else { 0 };
            let ts = p.get("time").and_then(|t| t.as_f64()).unwrap_or_else(now_ms);
            let id = f.get("id").and_then(|i| i.as_str()).unwrap_or("q");
            let title = format!("M{:.1} earthquake", mag);
            if let Some(ev) = make_event("usgs-quake", id, "quake", sev, la, lo, &title, s_of(&p, "place"), p.get("url").cloned().unwrap_or(Value::Null), ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}

// --- USGS elevated volcanoes -------------------------------------------------------
pub async fn volcano(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes", "application/json").await?;
    let list: Vec<Value> = if let Some(a) = d.as_array() {
        a.clone()
    } else {
        d.get("features").and_then(|x| x.as_array()).cloned().unwrap_or_default()
    };
    let mut out = Vec::new();
    for v in &list {
        let (la, lo) = match (v.get("latitude").and_then(num), v.get("longitude").and_then(num)) {
            (Some(a), Some(c)) => (a, c),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let lvl = s_of(v, "alertLevel").to_uppercase();
        let sev = match lvl.as_str() {
            "WARNING" => 3,
            "WATCH" => 2,
            "ADVISORY" => 1,
            _ => 1,
        };
        let name = s_of(v, "volcanoName");
        let title = format!("Volcano {}: {}", lvl, name);
        let desc = format!("Color code {}", s_of(v, "colorCode"));
        if let Some(ev) = make_event("usgs-volcano", name, "hazard", sev, la, lo, title.trim(), &desc, Value::from("https://volcanoes.usgs.gov"), now_ms(), Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- NWS active alerts --------------------------------------------------------------
pub async fn nws(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let url = format!("https://api.weather.gov/alerts/active?point={:.4},{:.4}", b.lat, b.lon);
    let d = get_json(st, &url, "application/geo+json").await?;
    let now = now_ms();
    let mut out = Vec::new();
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let p = match f.get("properties") {
                Some(p) => p,
                None => continue,
            };
            // polygon centroid when present; else the observer (zone-wide alert)
            let (la, lo) = f.get("geometry").and_then(centroid).unwrap_or((b.lat, b.lon));
            let ev_name = {
                let e = s_of(p, "event");
                if e.is_empty() { "Weather alert" } else { e }
            };
            let sev = match s_of(p, "severity") {
                "Extreme" => 3,
                "Severe" => 2,
                "Moderate" => 1,
                _ => 0,
            };
            let lower = ev_name.to_lowercase();
            let kind = if has_any(&lower, &["flood", "tsunami", "marine", "coastal", "surge"]) { "hazard" } else { "weather" };
            let id = s_of(p, "id");
            let desc = {
                let h = s_of(p, "headline");
                if h.is_empty() { s_of(p, "areaDesc") } else { h }
            };
            let ts = parse_iso_ms(s_of(p, "sent")).unwrap_or(now);
            if let Some(ev) = make_event("nws-alerts", if id.is_empty() { "nws" } else { id }, kind, sev, la, lo, ev_name, desc, p.get("uri").cloned().unwrap_or(Value::Null), ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}

// --- NWS Local Storm Reports (via Iowa Environmental Mesonet) ------------------------
pub async fn iem(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=12", "application/json").await?;
    let mut out = Vec::new();
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let (lo, la) = match f.get("geometry").and_then(|g| g.get("coordinates")).and_then(first_lonlat) {
                Some(x) => x,
                None => continue,
            };
            if !b.contains(la, lo) {
                continue;
            }
            let p = match f.get("properties") {
                Some(p) => p,
                None => continue,
            };
            let ttype = {
                let t = s_of(p, "typetext");
                if t.is_empty() { s_of(p, "type") } else { t }
            };
            let ttype = if ttype.is_empty() { "Storm report" } else { ttype };
            let lower = ttype.to_lowercase();
            let sev = if has_any(&lower, &["tornado", "flash flood", "funnel"]) {
                3
            } else if has_any(&lower, &["flood", "hail", "wind", "tstm", "marine", "surge", "snow", "ice", "fire"]) {
                2
            } else {
                1
            };
            let kind = if has_any(&lower, &["tornado", "flood", "funnel", "water spout", "surge"]) { "hazard" } else { "weather" };
            let magf = s_of(p, "magf");
            let title = if magf.is_empty() || magf == "0" {
                ttype.to_string()
            } else {
                format!("{} {} {}", ttype, magf, s_of(p, "unit")).trim().to_string()
            };
            let valid = s_of(p, "valid");
            let ts = parse_iso_ms(valid).unwrap_or_else(now_ms);
            let native = format!("{:.4},{:.4},{}", la, lo, valid);
            let desc = format!("{} {}", s_of(p, "city"), s_of(p, "remark"));
            if let Some(ev) = make_event("iem-lsr", &native, kind, sev, la, lo, &title, desc.trim(), Value::from("https://mesonet.agron.iastate.edu/lsr/"), ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}

// --- NASA EONET open natural events --------------------------------------------------
fn eonet_kind(cat: &str) -> &'static str {
    match cat {
        "wildfires" => "fire-wildland",
        "severeStorms" | "snow" | "tempExtremes" => "weather",
        "earthquakes" => "quake",
        _ => "hazard",
    }
}

pub async fn eonet(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=10&limit=200", "application/json").await?;
    let mut out = Vec::new();
    if let Some(evs) = d.get("events").and_then(|e| e.as_array()) {
        for e in evs {
            if e.get("closed").map(|c| !c.is_null()).unwrap_or(false) {
                continue;
            }
            let g = match e.get("geometry").and_then(|g| g.as_array()).and_then(|a| a.last()) {
                Some(g) => g,
                None => continue,
            };
            let (lo, la) = match g.get("coordinates").and_then(first_lonlat) {
                Some(x) => x,
                None => continue,
            };
            if !b.contains(la, lo) {
                continue;
            }
            let cat_id = e.get("categories").and_then(|c| c.as_array()).and_then(|a| a.first()).map(|c| s_of(c, "id")).unwrap_or("");
            let cat_title = e.get("categories").and_then(|c| c.as_array()).and_then(|a| a.first()).map(|c| s_of(c, "title")).unwrap_or("");
            let kind = eonet_kind(cat_id);
            let sev = if kind == "fire-wildland" { 2 } else { 1 };
            let ts = parse_iso_ms(s_of(g, "date")).unwrap_or_else(now_ms);
            if let Some(ev) = make_event("eonet", s_of(e, "id"), kind, sev, la, lo, s_of(e, "title"), cat_title, e.get("link").cloned().unwrap_or(Value::Null), ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}

// --- GDACS global disasters -----------------------------------------------------------
fn gdacs_kind(t: &str) -> &'static str {
    match t {
        "EQ" => "quake",
        "TC" => "weather",
        "WF" => "fire-wildland",
        _ => "hazard",
    }
}

pub async fn gdacs(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let d = get_json(st, "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP", "application/json").await?;
    let mut out = Vec::new();
    if let Some(feats) = d.get("features").and_then(|f| f.as_array()) {
        for f in feats {
            let (lo, la) = match f.get("geometry").and_then(|g| g.get("coordinates")).and_then(first_lonlat) {
                Some(x) => x,
                None => continue,
            };
            if !b.contains(la, lo) {
                continue;
            }
            let p = match f.get("properties") {
                Some(p) => p,
                None => continue,
            };
            let etype = s_of(p, "eventtype");
            let sev = match s_of(p, "alertlevel") {
                "Red" => 3,
                "Orange" => 2,
                _ => 1,
            };
            let url = match p.get("url") {
                Some(u) if u.is_object() => u.get("report").or_else(|| u.get("details")).cloned().unwrap_or(Value::Null),
                Some(u) if u.is_string() => u.clone(),
                _ => Value::Null,
            };
            let url = if url.is_null() { Value::from("https://www.gdacs.org") } else { url };
            let name = {
                let n = s_of(p, "eventname");
                if n.is_empty() { s_of(p, "name") } else { n }
            };
            let title = if name.is_empty() { format!("{} disaster", etype) } else { name.to_string() };
            let native = format!("{}{}", etype, s_of(p, "eventid"));
            let ts = parse_iso_ms(s_of(p, "fromdate")).unwrap_or_else(now_ms);
            if let Some(ev) = make_event("gdacs", &native, gdacs_kind(etype), sev, la, lo, &title, s_of(p, "description"), url, ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}

// --- NOAA/NWS NWPS river & tide gauges (only those actually flooding) -------------------
pub async fn nwps(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin={}&bbox.ymin={}&bbox.xmax={}&bbox.ymax={}&srid=EPSG_4326",
        b.min_lon, b.min_lat, b.max_lon, b.max_lat
    );
    let d = get_json(st, &url, "application/json").await?;
    let mut out = Vec::new();
    if let Some(gs) = d.get("gauges").and_then(|g| g.as_array()) {
        for g in gs {
            let (la, lo) = match (g.get("latitude").and_then(num), g.get("longitude").and_then(num)) {
                (Some(a), Some(c)) => (a, c),
                _ => continue,
            };
            let cat = g
                .get("status")
                .and_then(|s| s.get("observed"))
                .map(|o| s_of(o, "floodCategory"))
                .unwrap_or("")
                .to_lowercase();
            let sev = match cat.as_str() {
                "major" | "moderate" => 3,
                "minor" => 2,
                "action" => 1,
                _ => continue, // no flooding / no data
            };
            let lid = s_of(g, "lid");
            let name = s_of(g, "name");
            let title = format!("Flooding ({}) - {}", cat, if name.is_empty() { lid } else { name });
            let src = format!("https://water.noaa.gov/gauges/{}", lid);
            if let Some(ev) = make_event("nwps", lid, "hazard", sev, la, lo, &title, &format!("Gauge {}", lid), Value::from(src), now_ms(), Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}
