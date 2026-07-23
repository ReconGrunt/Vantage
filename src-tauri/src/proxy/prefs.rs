// GET/POST /api/prefs — origin-independent local preference storage (native port of the
// Express handlers in server/index.js).
//
// Why this exists: the UI persisted the observer in localStorage, which is keyed by
// ORIGIN. bind_listener() falls back to an ephemeral loopback port when 47615 is taken, so
// the origin changed between launches and the saved location silently vanished — the app
// reopened at the default location every time.
//
// PRIVACY: written to the user's own config dir, deliberately OUTSIDE the repository, so
// real coordinates can never be committed or pushed.

use std::fs;
use std::path::PathBuf;

use axum::{
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

fn prefs_path() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let mut p = PathBuf::from(appdata);
        p.push("Vantage");
        p.push("prefs.json");
        return p;
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    let mut p = PathBuf::from(home);
    p.push(".vantage");
    p.push("prefs.json");
    p
}

fn read_prefs() -> Value {
    fs::read_to_string(prefs_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

fn write_prefs(v: &Value) -> bool {
    let p = prefs_path();
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match serde_json::to_string(v) {
        Ok(s) => fs::write(&p, s).is_ok(),
        Err(_) => false,
    }
}

pub async fn get_prefs() -> Response {
    Json(json!({ "prefs": read_prefs() })).into_response()
}

/// Shallow-merges the posted object into the stored prefs.
pub async fn set_prefs(Json(patch): Json<Value>) -> Response {
    let mut cur = read_prefs();
    if let (Some(obj), Some(p)) = (cur.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
    let saved = write_prefs(&cur);
    Json(json!({ "prefs": cur, "saved": saved })).into_response()
}
