// The /api/* proxy routes, one module per resource — faithful native ports of the
// matching Express handlers in server/index.js (same upstreams, units, cache windows,
// and response shapes).

pub mod aircraft;
pub mod atc;
pub mod cameras;
pub mod flightinfo;
pub mod health;
pub mod incidents;
pub mod sources;
pub mod tile;
pub mod tle;
pub mod weather;

use serde_json::Value;

/// JS `x || null` for JSON values: falsy (missing / null / empty string) -> Null,
/// otherwise the value verbatim.
pub fn falsy_or_null(obj: &Value, key: &str) -> Value {
    match obj.get(key) {
        Some(v) if !v.is_null() && v.as_str() != Some("") => v.clone(),
        _ => Value::Null,
    }
}

/// JS `a ?? default` on a struct field: present-and-non-null -> value, else default.
pub fn coalesce(obj: &Value, key: &str, default: Value) -> Value {
    match obj.get(key) {
        Some(v) if !v.is_null() => v.clone(),
        _ => default,
    }
}

/// Number coercion matching JS `Number(x)`: accepts numbers or numeric strings.
pub fn to_num(v: &Value) -> Option<f64> {
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
