// Socrata (SODA) municipal open-data family — native mirror of server/sources/socrata.js.
// Adding a city = adding a row to DATASETS. Ordered by the :updated_at system field (present
// on every dataset, so a wrong per-dataset column can't 400 us), then bbox-filtered locally.

use serde_json::Value;

use super::{get_json, kind_from_text, make_event, num, s_of, sev_from_text, ts_or_now, Bbox};
use crate::server::AppState;

pub struct Ds {
    pub id: &'static str,
    pub label: &'static str,
    pub host: &'static str,
    pub dataset: &'static str,
    pub lat_field: &'static str,
    pub lon_field: &'static str,
    pub point_field: &'static str,
    pub type_field: &'static str,
    pub ts_field: &'static str,
    pub id_field: &'static str,
    pub addr_field: &'static str,
    pub kind: &'static str, // "" -> classify from the call-type text
    pub severity: i64,      // <0 -> classify from the call-type text
    pub region: (f64, f64, f64, f64),
}

pub const DATASETS: &[Ds] = &[
    Ds { id: "sea-fire-cad", label: "Seattle Fire/EMS dispatch", host: "data.seattle.gov", dataset: "kzjm-xkqj",
         lat_field: "latitude", lon_field: "longitude", point_field: "", type_field: "type", ts_field: "datetime",
         id_field: "incident_number", addr_field: "address", kind: "", severity: -1,
         region: (47.4, 47.78, -122.46, -122.22) },
    Ds { id: "sf-pd-cad", label: "SF Police dispatch (real-time)", host: "data.sfgov.org", dataset: "gnap-fj3t",
         lat_field: "", lon_field: "", point_field: "intersection_point", type_field: "call_type_final_desc",
         ts_field: "received_datetime", id_field: "cad_number", addr_field: "intersection_name", kind: "police", severity: -1,
         region: (37.70, 37.84, -122.54, -122.34) },
    Ds { id: "sf-fire-cad", label: "SF Fire calls", host: "data.sfgov.org", dataset: "nuek-vuh3",
         lat_field: "", lon_field: "", point_field: "case_location", type_field: "call_type",
         ts_field: "received_dttm", id_field: "call_number", addr_field: "address", kind: "", severity: -1,
         region: (37.70, 37.84, -122.54, -122.34) },
    Ds { id: "chi-311", label: "Chicago 311 service requests", host: "data.cityofchicago.org", dataset: "v6vf-nfxy",
         lat_field: "latitude", lon_field: "longitude", point_field: "", type_field: "sr_type", ts_field: "created_date",
         id_field: "sr_number", addr_field: "street_address", kind: "civic", severity: 0,
         region: (41.62, 42.05, -87.95, -87.52) },
    Ds { id: "chi-crime", label: "Chicago crimes (7-day lag)", host: "data.cityofchicago.org", dataset: "ijzp-q8t2",
         lat_field: "latitude", lon_field: "longitude", point_field: "", type_field: "primary_type", ts_field: "date",
         id_field: "case_number", addr_field: "block", kind: "police", severity: -1,
         region: (41.62, 42.05, -87.95, -87.52) },
    Ds { id: "nyc-311", label: "NYC 311 service requests", host: "data.cityofnewyork.us", dataset: "erm2-nwe9",
         lat_field: "latitude", lon_field: "longitude", point_field: "", type_field: "complaint_type", ts_field: "created_date",
         id_field: "unique_key", addr_field: "incident_address", kind: "civic", severity: 0,
         region: (40.48, 40.93, -74.27, -73.68) },
    Ds { id: "cin-cad", label: "Cincinnati PD dispatch", host: "data.cincinnati-oh.gov", dataset: "gexm-h6bt",
         lat_field: "latitude_x", lon_field: "longitude_x", point_field: "", type_field: "incident_type_desc",
         ts_field: "create_time_incident", id_field: "event_number", addr_field: "address_x", kind: "", severity: -1,
         region: (39.05, 39.32, -84.72, -84.25) },
];

/// Tolerate the three shapes these feeds use: numeric lat/lon columns, a GeoJSON point
/// column, or a Socrata {latitude, longitude} location object.
fn extract_lat_lon(r: &Value, ds: &Ds) -> Option<(f64, f64)> {
    if !ds.lat_field.is_empty() {
        if let (Some(la), Some(lo)) = (r.get(ds.lat_field).and_then(num), r.get(ds.lon_field).and_then(num)) {
            return Some((la, lo));
        }
    }
    for f in [ds.point_field, "point", "location", "report_location", "intersection_point", "geocoded_column", "the_geom"] {
        if f.is_empty() {
            continue;
        }
        if let Some(p) = r.get(f) {
            if let Some(c) = p.get("coordinates").and_then(|c| c.as_array()) {
                if c.len() >= 2 {
                    if let (Some(lo), Some(la)) = (num(&c[0]), num(&c[1])) {
                        return Some((la, lo));
                    }
                }
            }
            if let (Some(la), Some(lo)) = (p.get("latitude").and_then(num), p.get("longitude").and_then(num)) {
                return Some((la, lo));
            }
        }
    }
    None
}

pub async fn fetch(st: &AppState, ds: &Ds, b: &Bbox) -> Result<Vec<Value>, String> {
    if !b.intersects(ds.region) {
        return Ok(vec![]);
    }
    let url = format!(
        "https://{}/resource/{}.json?$limit=400&$order=:updated_at%20DESC",
        ds.host, ds.dataset
    );
    let rows = get_json(st, &url, "application/json").await?;
    let arr = match rows.as_array() {
        Some(a) => a,
        None => return Ok(vec![]),
    };
    let src_url = format!("https://{}/resource/{}", ds.host, ds.dataset);
    let mut out = Vec::new();
    for r in arr {
        let (la, lo) = match extract_lat_lon(r, ds) {
            Some(x) => x,
            None => continue,
        };
        if !b.contains(la, lo) {
            continue;
        }
        let type_text = if ds.type_field.is_empty() { "" } else { s_of(r, ds.type_field) };
        let kind = if ds.kind.is_empty() { kind_from_text(type_text) } else { ds.kind };
        let sev = if ds.severity >= 0 { ds.severity } else { sev_from_text(type_text) };
        let ts = ts_or_now(r.get(ds.ts_field));
        let id_val = s_of(r, ds.id_field);
        let native = if id_val.is_empty() { format!("{:.5},{:.5}", la, lo) } else { id_val.to_string() };
        let title = if type_text.is_empty() { ds.label } else { type_text };
        let desc = s_of(r, ds.addr_field);
        if let Some(ev) = make_event(ds.id, &native, kind, sev, la, lo, title, desc, Value::from(src_url.clone()), ts, Value::Null) {
            out.push(ev);
        }
    }
    Ok(out)
}
