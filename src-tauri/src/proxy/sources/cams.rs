// Public-camera feeds — native mirror of server/sources/{caltrans,nyctmc,tfl}.js.
// All keyless and officially published for public viewing. No private/unsecured cameras.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde_json::Value;

use super::{get_json, make_camera, make_camera_ex, num, s_of, Bbox};
use crate::server::AppState;

/// One adapter's fetch result: the cameras plus an optional honest ops note for the
/// feed-health panel (e.g. "3 unlocated dropped") — mirror of the Node { items, note }.
pub struct CamOut {
    pub items: Vec<Value>,
    pub note: Option<String>,
}
impl CamOut {
    pub fn simple(items: Vec<Value>) -> Self {
        Self { items, note: None }
    }
}

// Caltrans CWWP2: the district dir is un-padded (d4) but the filename is zero-padded (D04).
const CALTRANS_DISTRICTS: &[(u32, (f64, f64, f64, f64))] = &[
    (3, (38.2, 39.6, -122.1, -119.9)),   // Sacramento
    (4, (36.9, 38.6, -123.2, -121.2)),   // Bay Area
    (7, (33.6, 34.9, -119.7, -117.6)),   // LA / Ventura
    (8, (33.4, 35.5, -117.8, -114.4)),   // San Bernardino / Riverside
    (11, (32.5, 33.5, -117.7, -114.5)),  // San Diego / Imperial
    (12, (33.4, 33.98, -118.2, -117.4)), // Orange
];

pub async fn caltrans(st: &AppState, b: &Bbox) -> Result<CamOut, String> {
    let mut out = Vec::new();
    for &(d, region) in CALTRANS_DISTRICTS {
        if !b.intersects(region) {
            continue;
        }
        let url = format!("https://cwwp2.dot.ca.gov/data/d{}/cctv/cctvStatusD{:02}.json", d, d);
        let data = match get_json(st, &url, "application/json").await {
            Ok(x) => x,
            Err(_) => continue, // one dead district must not kill the rest
        };
        if let Some(arr) = data.get("data").and_then(|x| x.as_array()) {
            for rec in arr {
                let c = match rec.get("cctv") {
                    Some(c) => c,
                    None => continue,
                };
                let loc = c.get("location");
                let la = loc.and_then(|l| l.get("latitude")).and_then(num);
                let lo = loc.and_then(|l| l.get("longitude")).and_then(num);
                let (la, lo) = match (la, lo) {
                    (Some(a), Some(o)) => (a, o),
                    _ => continue,
                };
                if !b.contains(la, lo) {
                    continue;
                }
                // Skip units the agency reports as out of service (~89 of D07's 540) —
                // pinning them is what made the map look like most cameras were down.
                if s_of(c, "inService").eq_ignore_ascii_case("false") {
                    continue;
                }
                let still = c.get("imageData").and_then(|i| i.get("static")).and_then(|s| s.get("currentImageURL")).and_then(|u| u.as_str());
                let stream = c.get("imageData").and_then(|i| i.get("streamingVideoURL")).and_then(|u| u.as_str());
                if still.is_none() && stream.is_none() {
                    continue;
                }
                let idx = c
                    .get("index")
                    .and_then(|x| x.as_str().map(|s| s.to_string()).or_else(|| x.as_u64().map(|n| n.to_string())))
                    .unwrap_or_else(|| format!("{:.5},{:.5}", la, lo));
                let name = {
                    let mut n = String::new();
                    if let Some(l) = loc {
                        let a = s_of(l, "locationName");
                        let p = s_of(l, "nearbyPlace");
                        n = if !a.is_empty() { a.to_string() } else { p.to_string() };
                    }
                    if n.is_empty() { "Caltrans CCTV".to_string() } else { n }
                };
                if let Some(cam) = make_camera("caltrans", &idx, &name, la, lo, still, stream, true) {
                    out.push(cam);
                }
            }
        }
    }
    Ok(CamOut::simple(out))
}

// --- ALERTCalifornia (UC San Diego) PTZ wildfire cameras ----------------------------
// ~2,100 public cameras statewide, hundreds ringing LA in the SoCal mountains. Keyless,
// CORS-open GeoJSON; snapshots refresh ~every 10 s. Native mirror of server/sources/alertca.js.
const ALERTCA_BASE: &str = "https://cameras.alertcalifornia.org/public-camera-data";
const CA_REGION: (f64, f64, f64, f64) = (32.0, 43.0, -124.6, -114.0);
const CATALOG_TTL_S: u64 = 30 * 60;

// The catalog is ~2.6 MB and near-static; cache it adapter-side (serve-stale on a failed
// refresh) so a 10-min route-cache miss per bbox key doesn't re-download the whole list.
static ALERTCA_CACHE: OnceLock<Mutex<(Instant, Arc<Value>)>> = OnceLock::new();

async fn alertca_catalog(st: &AppState) -> Result<Arc<Value>, String> {
    let cache = ALERTCA_CACHE.get_or_init(|| Mutex::new((Instant::now(), Arc::new(Value::Null))));
    {
        if let Ok(g) = cache.lock() {
            if g.0.elapsed().as_secs() < CATALOG_TTL_S && !g.1.is_null() {
                return Ok(g.1.clone());
            }
        }
    }
    match get_json(st, &format!("{}/all_cameras-v3.json", ALERTCA_BASE), "application/json").await {
        Ok(fc) => {
            let arc = Arc::new(fc);
            if let Ok(mut g) = cache.lock() {
                *g = (Instant::now(), arc.clone());
            }
            Ok(arc)
        }
        Err(e) => {
            // serve-stale: a blip never empties the map
            if let Ok(g) = cache.lock() {
                if !g.1.is_null() {
                    return Ok(g.1.clone());
                }
            }
            Err(e)
        }
    }
}

pub async fn alertca(st: &AppState, b: &Bbox) -> Result<CamOut, String> {
    if !b.intersects(CA_REGION) {
        return Ok(CamOut::simple(vec![]));
    }
    let fc = alertca_catalog(st).await?;
    let feats = match fc.get("features").and_then(|f| f.as_array()) {
        Some(f) => f,
        None => return Ok(CamOut::simple(vec![])),
    };
    let mut out = Vec::new();
    let mut dropped = 0u32;
    for ft in feats {
        // GeoJSON coordinates are [lon, lat, elev]; offline cams carry [null,null,null].
        let coords = ft.get("geometry").and_then(|g| g.get("coordinates")).and_then(|c| c.as_array());
        let (la, lo) = match coords {
            Some(a) => match (a.get(1).and_then(num), a.get(0).and_then(num)) {
                (Some(la), Some(lo)) => (la, lo),
                _ => {
                    if !ft.get("properties").and_then(|p| p.get("name")).and_then(|n| n.as_str()).unwrap_or("").is_empty() {
                        dropped += 1; // named but unmappable — reported, not silent
                    }
                    continue;
                }
            },
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let p = match ft.get("properties") {
            Some(p) => p,
            None => continue,
        };
        let id = s_of(p, "id").trim();
        if id.is_empty() {
            continue;
        }
        let name = {
            let n = s_of(p, "name");
            if n.is_empty() { id } else { n }
        };
        let still = format!("{}/{}/latest-frame.jpg", ALERTCA_BASE, id);
        let az = p.get("az_current").and_then(num);
        let fov = p.get("fov").and_then(num);
        let frame_ts = p.get("last_frame_ts").and_then(num).map(|s| s * 1000.0);
        if let Some(cam) = make_camera_ex("alertca", id, name, la, lo, Some(&still), None, true, az, fov, frame_ts) {
            out.push(cam);
        }
    }
    Ok(CamOut {
        items: out,
        note: if dropped > 0 { Some(format!("{} unlocated dropped", dropped)) } else { None },
    })
}

// --- NYC DOT (nyctmc) ---------------------------------------------------------------
const NYC: (f64, f64, f64, f64) = (40.48, 40.93, -74.27, -73.68);

pub async fn nyctmc(st: &AppState, b: &Bbox) -> Result<CamOut, String> {
    if !b.intersects(NYC) {
        return Ok(CamOut::simple(vec![]));
    }
    let d = get_json(st, "https://webcams.nyctmc.org/api/cameras/", "application/json").await?;
    let list: Vec<Value> = if let Some(a) = d.as_array() {
        a.clone()
    } else {
        d.get("cameras").and_then(|x| x.as_array()).cloned().unwrap_or_default()
    };
    let mut out = Vec::new();
    for raw in &list {
        let c = raw.get("properties").unwrap_or(raw);
        if c.get("isOnline").and_then(|x| x.as_bool()) == Some(false) {
            continue;
        }
        let la = c.get("latitude").and_then(num).or_else(|| c.get("lat").and_then(num));
        let lo = c
            .get("longitude")
            .and_then(num)
            .or_else(|| c.get("lng").and_then(num))
            .or_else(|| c.get("lon").and_then(num));
        let (la, lo) = match (la, lo) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let id_s = s_of(c, "id");
        let id = if id_s.is_empty() { format!("{:.5},{:.5}", la, lo) } else { id_s.to_string() };
        let img = s_of(c, "imageUrl");
        let still = if img.is_empty() {
            format!("https://webcams.nyctmc.org/api/cameras/{}/image", id)
        } else {
            img.to_string()
        };
        let name = {
            let n = s_of(c, "name");
            if n.is_empty() { "NYC DOT camera" } else { n }
        };
        // nyctmc may block hotlinking -> route the image through /api/camimg
        if let Some(cam) = make_camera("nyc-dot", &id, name, la, lo, Some(&still), None, true) {
            out.push(cam);
        }
    }
    Ok(CamOut::simple(out))
}

// --- Transport for London JamCams (keyless at a low rate) -----------------------------
const LONDON: (f64, f64, f64, f64) = (51.25, 51.72, -0.55, 0.32);

pub async fn tfl(st: &AppState, b: &Bbox) -> Result<CamOut, String> {
    if !b.intersects(LONDON) {
        return Ok(CamOut::simple(vec![]));
    }
    // Keyless at a low rate; an optional TFL_APP_KEY lifts it (parity with Node tfl.js).
    let url = match &st.cfg.tfl_key {
        Some(k) => format!("https://api.tfl.gov.uk/Place/Type/JamCam?app_key={}", k),
        None => "https://api.tfl.gov.uk/Place/Type/JamCam".to_string(),
    };
    let d = get_json(st, &url, "application/json").await?;
    let arr = match d.as_array() {
        Some(a) => a,
        None => return Ok(CamOut::simple(vec![])),
    };
    let mut out = Vec::new();
    for p in arr {
        let (la, lo) = match (p.get("lat").and_then(num), p.get("lon").and_then(num)) {
            (Some(a), Some(o)) => (a, o),
            _ => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let img = p
            .get("additionalProperties")
            .and_then(|a| a.as_array())
            .and_then(|a| a.iter().find(|x| s_of(x, "key") == "imageUrl"))
            .map(|x| s_of(x, "value"))
            .unwrap_or("");
        if img.is_empty() {
            continue;
        }
        let name = {
            let n = s_of(p, "commonName");
            if n.is_empty() { "JamCam" } else { n }
        };
        if let Some(cam) = make_camera("tfl", s_of(p, "id"), name, la, lo, Some(img), None, true) {
            out.push(cam);
        }
    }
    Ok(CamOut::simple(out))
}
