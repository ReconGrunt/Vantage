// Public-camera feeds — native mirror of server/sources/{caltrans,nyctmc,tfl}.js.
// All keyless and officially published for public viewing. No private/unsecured cameras.

use serde_json::Value;

use super::{get_json, make_camera, num, s_of, Bbox};
use crate::server::AppState;

// Caltrans CWWP2: the district dir is un-padded (d4) but the filename is zero-padded (D04).
const CALTRANS_DISTRICTS: &[(u32, (f64, f64, f64, f64))] = &[
    (3, (38.2, 39.6, -122.1, -119.9)),   // Sacramento
    (4, (36.9, 38.6, -123.2, -121.2)),   // Bay Area
    (7, (33.6, 34.9, -119.7, -117.6)),   // LA / Ventura
    (8, (33.4, 35.5, -117.8, -114.4)),   // San Bernardino / Riverside
    (11, (32.5, 33.5, -117.7, -114.5)),  // San Diego / Imperial
    (12, (33.4, 33.98, -118.2, -117.4)), // Orange
];

pub async fn caltrans(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
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
    Ok(out)
}

// --- NYC DOT (nyctmc) ---------------------------------------------------------------
const NYC: (f64, f64, f64, f64) = (40.48, 40.93, -74.27, -73.68);

pub async fn nyctmc(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(NYC) {
        return Ok(vec![]);
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
    Ok(out)
}

// --- Transport for London JamCams (keyless at a low rate) -----------------------------
const LONDON: (f64, f64, f64, f64) = (51.25, 51.72, -0.55, 0.32);

pub async fn tfl(st: &AppState, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(LONDON) {
        return Ok(vec![]);
    }
    let d = get_json(st, "https://api.tfl.gov.uk/Place/Type/JamCam", "application/json").await?;
    let arr = match d.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
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
    Ok(out)
}
