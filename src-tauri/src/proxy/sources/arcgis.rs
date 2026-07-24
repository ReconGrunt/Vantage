// Esri ArcGIS REST FeatureServer family — native mirror of server/sources/arcgis.js.
// Queries a layer as GeoJSON with an envelope filter so the server only returns features
// near the observer. Serves both incident layers (DC MPD) and camera layers (FL511).

use serde_json::Value;

use super::{get_json, kind_from_text, make_camera, make_event, num, s_of, sev_from_text, ts_or_now, Bbox};
use crate::server::AppState;

pub struct Layer {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    pub category: &'static str, // "incidents" | "cameras"
    pub type_field: &'static str,
    pub ts_field: &'static str,
    pub id_field: &'static str,
    pub desc_field: &'static str,
    pub name_field: &'static str,  // cameras
    pub still_field: &'static str, // cameras
    pub kind: &'static str,
    pub severity: i64,
    pub region: (f64, f64, f64, f64),
}

pub const LAYERS: &[Layer] = &[
    Layer { id: "dc-mpd", label: "DC Police incidents", category: "incidents",
            url: "https://maps2.dcgis.dc.gov/dcgis/rest/services/FEEDS/MPD/FeatureServer/39",
            type_field: "OFFENSE", ts_field: "REPORT_DAT", id_field: "CCN", desc_field: "BLOCK",
            name_field: "", still_field: "", kind: "police", severity: -1,
            region: (38.79, 39.00, -77.12, -76.90) },
    Layer { id: "fl511-cam", label: "Florida DOT cameras", category: "cameras",
            url: "https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0",
            type_field: "", ts_field: "", id_field: "ID", desc_field: "",
            name_field: "DESCRIPT", still_field: "IMAGE", kind: "", severity: -1,
            region: (24.4, 31.1, -87.7, -79.8) },
];

pub fn centroid(geom: &Value) -> Option<(f64, f64)> {
    let t = geom.get("type")?.as_str()?;
    let c = geom.get("coordinates")?;
    if t == "Point" {
        let a = c.as_array()?;
        return Some((num(a.get(1)?)?, num(a.get(0)?)?));
    }
    let ring: &Vec<Value> = match t {
        "Polygon" => c.as_array()?.first()?.as_array()?,
        "MultiPolygon" => c.as_array()?.first()?.as_array()?.first()?.as_array()?,
        "LineString" => c.as_array()?,
        _ => return None,
    };
    if ring.is_empty() {
        return None;
    }
    let (mut sx, mut sy, mut n) = (0.0f64, 0.0f64, 0.0f64);
    for p in ring {
        if let Some(a) = p.as_array() {
            if let (Some(x), Some(y)) = (a.get(0).and_then(num), a.get(1).and_then(num)) {
                sx += x;
                sy += y;
                n += 1.0;
            }
        }
    }
    if n == 0.0 {
        return None;
    }
    Some((sy / n, sx / n))
}

pub async fn fetch(st: &AppState, ly: &Layer, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(ly.region) {
        return Ok(vec![]);
    }
    let url = format!(
        "{}/query?f=geojson&where=1%3D1&outFields=*&geometry={},{},{},{}\
&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&resultRecordCount=1000",
        ly.url, b.min_lon, b.min_lat, b.max_lon, b.max_lat
    );
    let fc = get_json(st, &url, "application/json").await?;
    let feats = match fc.get("features").and_then(|f| f.as_array()) {
        Some(f) => f,
        None => return Ok(vec![]),
    };
    let mut out = Vec::new();
    for ft in feats {
        let geom = match ft.get("geometry") {
            Some(g) => g,
            None => continue,
        };
        let (la, lo) = match centroid(geom) {
            Some(x) => x,
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let p = match ft.get("properties") {
            Some(p) => p,
            None => continue,
        };
        let id_val = s_of(p, ly.id_field);
        let native = if id_val.is_empty() { format!("{:.5},{:.5}", la, lo) } else { id_val.to_string() };

        if ly.category == "cameras" {
            let name = {
                let n = s_of(p, ly.name_field);
                if n.is_empty() { ly.label } else { n }
            };
            let still = {
                let s = s_of(p, ly.still_field);
                if s.is_empty() { None } else { Some(s) }
            };
            if let Some(cam) = make_camera(ly.id, &native, name, la, lo, still, None, true) {
                out.push(cam);
            }
        } else {
            let type_text = if ly.type_field.is_empty() { "" } else { s_of(p, ly.type_field) };
            let kind = if ly.kind.is_empty() { kind_from_text(type_text) } else { ly.kind };
            let sev = if ly.severity >= 0 { ly.severity } else { sev_from_text(type_text) };
            let ts = ts_or_now(p.get(ly.ts_field));
            let title = if type_text.is_empty() { ly.label } else { type_text };
            let desc = s_of(p, ly.desc_field);
            if let Some(ev) = make_event(ly.id, &native, kind, sev, la, lo, title, desc, Value::from(ly.url), ts, Value::Null) {
                out.push(ev);
            }
        }
    }
    Ok(out)
}
