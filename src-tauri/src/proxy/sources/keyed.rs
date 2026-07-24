// keyed.rs — native mirror of the keyed-but-free Node adapters (airquality, firms, windy,
// wsdot, open511sf, events). Every one is OFF until its env key is present (gated by the
// registry's enabled predicate at the fan-out), so with no keys this module never runs and
// the fused source set is identical to Node's keyless core.

use serde_json::Value;

use super::{get_json, get_text, make_camera, make_event, now_ms, num, parse_iso_ms, s_of, Bbox, UA};
use crate::server::AppState;

const WA: (f64, f64, f64, f64) = (45.5, 49.1, -124.9, -116.9);
const BAY: (f64, f64, f64, f64) = (36.9, 38.9, -123.2, -121.2);

// --- AirNow (EPA) air quality — one hazard event when AQI > 50 --------------------------
pub async fn airnow(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.airnow_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    let url = format!(
        "https://www.airnowapi.org/aq/observation/latLong/current/?format=application/json&latitude={}&longitude={}&distance=75&API_KEY={}",
        b.lat, b.lon, key
    );
    let rows = get_json(st, &url, "application/json").await?;
    let arr = match rows.as_array() {
        Some(a) if !a.is_empty() => a,
        _ => return Ok(vec![]),
    };
    let mut worst = &arr[0];
    for r in arr {
        if r.get("AQI").and_then(num).unwrap_or(-1.0) > worst.get("AQI").and_then(num).unwrap_or(-1.0) {
            worst = r;
        }
    }
    let aqi = worst.get("AQI").and_then(num).unwrap_or(0.0);
    if aqi <= 50.0 {
        return Ok(vec![]);
    }
    let la = worst.get("Latitude").and_then(num).unwrap_or(b.lat);
    let lo = worst.get("Longitude").and_then(num).unwrap_or(b.lon);
    let cat = worst.get("Category").and_then(|c| c.get("Name")).and_then(|n| n.as_str()).unwrap_or("");
    let param = s_of(worst, "ParameterName");
    let area = s_of(worst, "ReportingArea");
    let sev = if aqi > 150.0 { 3 } else if aqi > 100.0 { 2 } else { 1 };
    let title = format!("Air quality: AQI {} {} ({})", aqi as i64, cat, param);
    let hour = worst.get("HourObserved").and_then(num).unwrap_or(0.0) as i64;
    let ts = parse_iso_ms(&format!("{}T{:02}:00:00Z", s_of(worst, "DateObserved").trim(), hour)).unwrap_or_else(now_ms);
    let native = format!("{}:{}", area, param);
    Ok(make_event("airnow", &native, "hazard", sev, la, lo, &title, area, Value::from("https://www.airnow.gov"), ts, Value::Null)
        .into_iter()
        .collect())
}

// --- NASA FIRMS wildfire thermal detections (VIIRS S-NPP, CSV) ---------------------------
pub async fn firms(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.firms_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    let area = format!("{},{},{},{}", b.min_lon, b.min_lat, b.max_lon, b.max_lat);
    let url = format!("https://firms.modaps.eosdis.nasa.gov/api/area/csv/{}/VIIRS_SNPP_NRT/{}/1", key, area);
    let txt = get_text(st, &url).await?;
    let lines: Vec<&str> = txt.trim().lines().collect();
    if lines.len() < 2 {
        return Ok(vec![]);
    }
    let hdr: Vec<&str> = lines[0].split(',').collect();
    let idx = |name: &str| hdr.iter().position(|h| *h == name);
    let (ilat, ilon) = match (idx("latitude"), idx("longitude")) {
        (Some(a), Some(o)) => (a, o),
        _ => return Ok(vec![]),
    };
    let (ifrp, idate, itime, iconf) = (idx("frp"), idx("acq_date"), idx("acq_time"), idx("confidence"));
    let mut out = Vec::new();
    for line in &lines[1..] {
        let c: Vec<&str> = line.split(',').collect();
        let la = c.get(ilat).and_then(|s| s.parse::<f64>().ok());
        let lo = c.get(ilon).and_then(|s| s.parse::<f64>().ok());
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let frp = ifrp.and_then(|i| c.get(i)).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
        let sev = if frp > 50.0 { 3 } else if frp > 20.0 { 2 } else { 1 };
        let date = idate.and_then(|i| c.get(i)).copied().unwrap_or("");
        let raw_t = itime.and_then(|i| c.get(i)).copied().unwrap_or("0000");
        let t = format!("{:0>4}", raw_t);
        let ts = parse_iso_ms(&format!("{}T{}:{}:00Z", date, &t[..2], &t[2..])).unwrap_or_else(now_ms);
        let conf = iconf.and_then(|i| c.get(i)).copied().unwrap_or("?");
        let native = format!("{:.4},{:.4},{}{}", la, lo, date, t);
        let title = format!("Wildfire hotspot (FRP {})", frp);
        let desc = format!("VIIRS thermal detection · confidence {}", conf);
        if let Some(ev) = make_event("firms", &native, "fire-wildland", sev, la, lo, &title, &desc, Value::from("https://firms.modaps.eosdis.nasa.gov"), ts, Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- Windy Webcams v3 (cameras) ---------------------------------------------------------
pub async fn windy(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.windy_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    let radius = (b.radius_km.round() as i64).clamp(1, 50);
    let url = format!(
        "https://api.windy.com/webcams/api/v3/webcams?nearby={},{},{}&limit=50&include=images,location",
        b.lat, b.lon, radius
    );
    let resp = st
        .http
        .get(&url)
        .header("User-Agent", UA)
        .header("x-windy-api-key", key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} for windy webcams", resp.status()));
    }
    let d: Value = resp.json().await.map_err(|e| e.to_string())?;
    let list = d.get("webcams").and_then(|w| w.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for w in &list {
        let loc = w.get("location");
        let la = loc.and_then(|l| l.get("latitude")).and_then(num);
        let lo = loc.and_then(|l| l.get("longitude")).and_then(num);
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        let imgs = w.get("images");
        let still = imgs
            .and_then(|i| i.get("current")).and_then(|c| c.get("preview")).and_then(|p| p.as_str())
            .or_else(|| imgs.and_then(|i| i.get("daylight")).and_then(|c| c.get("preview")).and_then(|p| p.as_str()));
        let still = match still {
            Some(s) => s,
            None => continue,
        };
        let id = json_id(w.get("webcamId")).or_else(|| json_id(w.get("id"))).unwrap_or_default();
        let name = {
            let n = s_of(w, "title");
            if n.is_empty() { "Webcam" } else { n }
        };
        if let Some(cam) = make_camera("windy", &id, name, la, lo, Some(still), None, true) {
            out.push(cam);
        }
    }
    Ok(out)
}

// --- WSDOT (Washington) cameras + traffic alerts ----------------------------------------
pub async fn wsdot_cam(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.wsdot_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    if !b.intersects(WA) {
        return Ok(vec![]);
    }
    let url = format!("https://www.wsdot.wa.gov/Traffic/api/HighwayCameras/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode={}", key);
    let d = get_json(st, &url, "application/json").await?;
    let arr = d.as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for c in &arr {
        let loc = c.get("CameraLocation");
        let la = loc.and_then(|l| l.get("Latitude")).and_then(num);
        let lo = loc.and_then(|l| l.get("Longitude")).and_then(num);
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let img = s_of(c, "ImageURL");
        if img.is_empty() {
            continue;
        }
        let id = json_id(c.get("CameraID")).unwrap_or_default();
        let name = {
            let t = s_of(c, "Title");
            if !t.is_empty() { t.to_string() } else { loc.map(|l| s_of(l, "Description").to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "WSDOT camera".into()) }
        };
        if let Some(cam) = make_camera("wsdot", &id, &name, la, lo, Some(img), None, true) {
            out.push(cam);
        }
    }
    Ok(out)
}

pub async fn wsdot_alerts(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.wsdot_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    if !b.intersects(WA) {
        return Ok(vec![]);
    }
    let url = format!("https://www.wsdot.wa.gov/Traffic/api/HighwayAlerts/HighwayAlertsREST.svc/GetAlertsAsJson?AccessCode={}", key);
    let d = get_json(st, &url, "application/json").await?;
    let arr = d.as_array().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for a in &arr {
        let loc = a.get("StartRoadwayLocation");
        let la = loc.and_then(|l| l.get("Latitude")).and_then(num);
        let lo = loc.and_then(|l| l.get("Longitude")).and_then(num);
        let (la, lo) = match (la, lo) {
            (Some(x), Some(o)) => (x, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let prio = s_of(a, "Priority").to_lowercase();
        let sev = if prio.contains("highest") { 3 } else if prio.contains("high") { 2 } else { 1 };
        let title = {
            let h = s_of(a, "HeadlineDescription");
            if !h.is_empty() { h } else { let e = s_of(a, "EventCategory"); if e.is_empty() { "Traffic alert" } else { e } }
        };
        let native = json_id(a.get("AlertID")).unwrap_or_default();
        if let Some(ev) = make_event("wsdot-alerts", &native, "traffic", sev, la, lo, title, s_of(a, "EventCategory"), Value::from("https://wsdot.com/travel/real-time"), now_ms(), Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- 511 SF Bay traffic events (Open511) ------------------------------------------------
pub async fn open511sf(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let token = match &st.cfg.five11_sf_token {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    if !b.intersects(BAY) {
        return Ok(vec![]);
    }
    let url = format!("https://api.511.org/traffic/events?api_key={}&format=json", token);
    let d = get_json(st, &url, "application/json").await?;
    let list = d.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for e in &list {
        let geo = e.get("geography");
        let is_point = geo.and_then(|g| g.get("type")).and_then(|t| t.as_str()) == Some("Point");
        let coords = if is_point { geo.and_then(|g| g.get("coordinates")).and_then(|c| c.as_array()) } else { None };
        let (la, lo) = match coords {
            Some(c) => match (c.get(1).and_then(num), c.get(0).and_then(num)) {
                (Some(a), Some(o)) => (a, o),
                _ => continue,
            },
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let etype = s_of(e, "event_type");
        let kind = if etype.to_lowercase().contains("construction") || etype.to_lowercase().contains("roadwork") { "civic" } else { "traffic" };
        let sev = match s_of(e, "severity").to_uppercase().as_str() {
            "MAJOR" | "SEVERE" => 3,
            "MODERATE" => 2,
            _ => 1,
        };
        let title = {
            let h = s_of(e, "headline");
            if !h.is_empty() { h.to_string() } else if !etype.is_empty() { etype.to_string() } else { "Traffic event".into() }
        };
        let desc = e.get("event_subtypes").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let native = json_id(e.get("id")).unwrap_or_default();
        let ts = parse_iso_ms(s_of(e, "updated")).unwrap_or_else(now_ms);
        let url_v = { let u = s_of(e, "url"); Value::from(if u.is_empty() { "https://511.org".to_string() } else { u.to_string() }) };
        if let Some(ev) = make_event("511sfbay", &native, kind, sev, la, lo, &title, &desc, url_v, ts, Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

// --- Ticketmaster Discovery events (scheduled civic gatherings, severity 0) --------------
pub async fn ticketmaster(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    let key = match &st.cfg.ticketmaster_key {
        Some(k) => k,
        None => return Ok(vec![]),
    };
    let radius = (b.radius_km.round() as i64).clamp(1, 100);
    let url = format!(
        "https://app.ticketmaster.com/discovery/v2/events.json?apikey={}&latlong={},{}&radius={}&unit=km&size=50&sort=date,asc",
        key, b.lat, b.lon, radius
    );
    let d = get_json(st, &url, "application/json").await?;
    let list = d.get("_embedded").and_then(|e| e.get("events")).and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for e in &list {
        let venue = e.get("_embedded").and_then(|x| x.get("venues")).and_then(|v| v.as_array()).and_then(|a| a.first());
        let loc = venue.and_then(|v| v.get("location"));
        let la = loc.and_then(|l| l.get("latitude")).and_then(num);
        let lo = loc.and_then(|l| l.get("longitude")).and_then(num);
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        let start = e.get("dates").and_then(|d| d.get("start"));
        let when = start.and_then(|s| s.get("dateTime")).and_then(|x| x.as_str())
            .or_else(|| start.and_then(|s| s.get("localDate")).and_then(|x| x.as_str())).unwrap_or("");
        let ts = parse_iso_ms(when).unwrap_or_else(now_ms);
        let native = json_id(e.get("id")).unwrap_or_default();
        let title = s_of(e, "name");
        let desc = venue.map(|v| s_of(v, "name")).unwrap_or("");
        let url_v = { let u = s_of(e, "url"); Value::from(if u.is_empty() { "https://ticketmaster.com".to_string() } else { u.to_string() }) };
        if let Some(ev) = make_event("ticketmaster", &native, "civic", 0, la, lo, title, desc, url_v, ts, Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}

/// A JSON id that may be a string or a number -> owned String.
fn json_id(v: Option<&Value>) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        Some(s.to_string())
    } else if let Some(n) = v.as_i64() {
        Some(n.to_string())
    } else {
        v.as_u64().map(|n| n.to_string())
    }
}
