// Ground/City feed adapters — the native mirror of server/sources/* in the Node backend.
// One module per feed family; each exposes `fetch(...) -> Result<Vec<Value>, String>` and
// returns already-normalized Event/Camera JSON so the route handlers just fan out and fuse.
//
// Parity rules with Node (scripts/contract-smoke.mjs guards the shapes):
//   · Event keys: id, kind, severity, lat, lon, title, description, source, sourceUrl, ts, expiresTs
//   · Camera keys: id, name, lat, lon, still, stream, provider, proxied, az, fovDeg, frameTs
//   · An item with no usable coordinates is dropped, never guessed (place/event-centric).

pub mod arcgis;
pub mod cams;
pub mod hazards;
pub mod la;
pub mod road;
pub mod socrata;

use serde_json::{json, Value};

use crate::server::AppState;

pub const UA: &str = "Vantage/0.1 (all-domain situational awareness; +github.com/ReconGrunt/vantage)";

/// A query centre + radius, pre-expanded into a bounding box (most upstreams want a bbox).
#[derive(Clone, Copy)]
pub struct Bbox {
    pub lat: f64,
    pub lon: f64,
    /// kept for parity with the Node bbox helper (used by radius-based keyed feeds there)
    #[allow(dead_code)]
    pub radius_km: f64,
    pub min_lat: f64,
    pub max_lat: f64,
    pub min_lon: f64,
    pub max_lon: f64,
}

impl Bbox {
    pub fn new(lat: f64, lon: f64, radius_km: f64) -> Self {
        let dlat = radius_km / 111.0;
        let dlon = radius_km / (111.0 * lat.to_radians().cos().abs().max(0.05));
        Self {
            lat,
            lon,
            radius_km,
            min_lat: lat - dlat,
            max_lat: lat + dlat,
            min_lon: lon - dlon,
            max_lon: lon + dlon,
        }
    }
    pub fn contains(&self, la: f64, lo: f64) -> bool {
        la >= self.min_lat && la <= self.max_lat && lo >= self.min_lon && lo <= self.max_lon
    }
    /// region = (min_lat, max_lat, min_lon, max_lon) — skip a city feed we're nowhere near.
    pub fn intersects(&self, r: (f64, f64, f64, f64)) -> bool {
        !(self.min_lat > r.1 || self.max_lat < r.0 || self.min_lon > r.3 || self.max_lon < r.2)
    }
}

/// JS `Number(x)` semantics: numbers or numeric strings, else None.
pub fn num(v: &Value) -> Option<f64> {
    if v.is_null() {
        None
    } else if let Some(n) = v.as_f64() {
        Some(n)
    } else if let Some(s) = v.as_str() {
        s.trim().parse::<f64>().ok()
    } else {
        None
    }
}

pub fn s_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

// --- dependency-free date parsing ------------------------------------------------
// No chrono (the release profile optimises hard for size); these feeds emit ISO-8601 or
// "YYYY-MM-DD HH:MM:SS". Anything else falls back to "now" at the call site.

/// Howard Hinnant's days_from_civil — days since the Unix epoch for a civil date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2026-07-23T04:15:09Z" / "2026-07-23 04:15:09" / "2026-07-23" -> epoch ms (UTC).
pub fn parse_iso_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (mut hh, mut mm, mut ss) = (0i64, 0i64, 0i64);
    if b.len() >= 19 && (b[10] == b'T' || b[10] == b' ') {
        hh = s.get(11..13)?.parse().ok()?;
        mm = s.get(14..16)?.parse().ok()?;
        ss = s.get(17..19)?.parse().ok()?;
    }
    let days = days_from_civil(y, m, d);
    Some(((days * 86400 + hh * 3600 + mm * 60 + ss) as f64) * 1000.0)
}

pub fn now_ms() -> f64 {
    (crate::server::unix_now() as f64) * 1000.0
}

/// Parse a date-ish JSON value to epoch ms, falling back to now.
pub fn ts_or_now(v: Option<&Value>) -> f64 {
    match v {
        Some(x) => {
            if let Some(n) = x.as_f64() {
                // already epoch ms (USGS) or epoch s
                return if n > 1e11 { n } else { n * 1000.0 };
            }
            x.as_str().and_then(parse_iso_ms).unwrap_or_else(now_ms)
        }
        None => now_ms(),
    }
}

// --- http ------------------------------------------------------------------------

pub async fn get_json(st: &AppState, url: &str, accept: &str) -> Result<Value, String> {
    let r = st
        .http
        .get(url)
        .header("User-Agent", UA)
        .header("Accept", accept)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

/// Available for CSV feeds (e.g. FIRMS) — those are keyed and currently Node-only.
#[allow(dead_code)]
pub async fn get_text(st: &AppState, url: &str) -> Result<String, String> {
    let r = st
        .http
        .get(url)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{} for {}", r.status(), url));
    }
    r.text().await.map_err(|e| e.to_string())
}

// --- normalized builders ----------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn make_event(
    source: &str,
    native: &str,
    kind: &str,
    sev: i64,
    lat: f64,
    lon: f64,
    title: &str,
    desc: &str,
    url: Value,
    ts: f64,
    expires: Value,
) -> Option<Value> {
    if !lat.is_finite() || !lon.is_finite() || !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    let t: String = title.chars().take(160).collect();
    let d: String = desc.chars().take(400).collect();
    Some(json!({
        "id": format!("{}:{}", source, native),
        "kind": kind,
        "severity": sev.clamp(0, 3),
        "lat": lat, "lon": lon,
        "title": t, "description": d,
        "source": source, "sourceUrl": url,
        "ts": ts, "expiresTs": expires,
    }))
}

pub fn make_camera(
    provider: &str,
    native: &str,
    name: &str,
    lat: f64,
    lon: f64,
    still: Option<&str>,
    stream: Option<&str>,
    proxied: bool,
) -> Option<Value> {
    make_camera_ex(provider, native, name, lat, lon, still, stream, proxied, None, None, None)
}

// Full form: PTZ/freshness metadata (az = look direction deg, fov_deg = horizontal FOV,
// frame_ts = epoch ms of the newest frame). Keys are ALWAYS emitted (null when absent) so
// the Node/Rust contract and the frontend never have to guess — mirror of the JS makeCamera.
#[allow(clippy::too_many_arguments)]
pub fn make_camera_ex(
    provider: &str,
    native: &str,
    name: &str,
    lat: f64,
    lon: f64,
    still: Option<&str>,
    stream: Option<&str>,
    proxied: bool,
    az: Option<f64>,
    fov_deg: Option<f64>,
    frame_ts: Option<f64>,
) -> Option<Value> {
    if !lat.is_finite() || !lon.is_finite() {
        return None;
    }
    if still.is_none() && stream.is_none() {
        return None;
    }
    let n: String = name.chars().take(120).collect();
    Some(json!({
        "id": format!("{}:{}", provider, native),
        "name": n, "lat": lat, "lon": lon,
        "still": still.map(Value::from).unwrap_or(Value::Null),
        "stream": stream.map(Value::from).unwrap_or(Value::Null),
        "provider": provider, "proxied": proxied,
        "az": az, "fovDeg": fov_deg, "frameTs": frame_ts,
    }))
}

// --- shared text classifiers (mirror server/sources/types.js order) ----------------

fn any_of(s: &str, words: &[&str]) -> bool {
    words.iter().any(|w| s.contains(w))
}

pub fn kind_from_text(t: &str) -> &'static str {
    let s = t.to_lowercase();
    if any_of(&s, &["fire", "smoke", "arson", "burn", "alarm", "flame"]) {
        return "fire";
    }
    if any_of(&s, &["medic", "aid", "ems", "injur", "cardiac", "overdose", "sick", "breathing", "unconsc", "seizure", "stroke", "casualt", "fall"]) {
        return "medical";
    }
    if any_of(&s, &["theft", "robb", "assault", "burglar", "shoot", "shots", "weapon", "homicid", "stab", "battery", "narcotic", "domestic", "dui", "arrest", "shoplift", "trespass", "vandal", "prowler", "gun"]) {
        return "police";
    }
    if any_of(&s, &["crash", "collision", "accident", "traffic", "vehicle", "mva", "mvc", "disabled", "road"]) {
        return "traffic";
    }
    if any_of(&s, &["hazmat", "gas leak", "spill", "wires down", "flood", "rescue", "water"]) {
        return "hazard";
    }
    "civic"
}

pub fn sev_from_text(t: &str) -> i64 {
    let s = t.to_lowercase();
    if any_of(&s, &["working fire", "structure fire", "shooting", "shots fired", "homicid", "stab", "explosion", "hazmat", "not breathing", "cardiac arrest", "major", "fatal", "entrapment", "active"]) {
        return 3;
    }
    if any_of(&s, &["fire", "assault", "robb", "crash", "collision", "injur", "overdose", "weapon", "rescue", "gas leak"]) {
        return 2;
    }
    1
}
