// Serves the embedded `public/` frontend (the same assets the Node server serves).
// In release the whole tree is baked into the binary via rust-embed; in debug it is
// read from disk (fast iteration). Mirrors Express `static` + `Cache-Control: no-store`.

use axum::{
    body::Body,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../public"]
pub struct Assets;

/// Fallback handler: resolve a request path to an embedded file. `/` -> index.html.
pub async fn serve(uri: Uri) -> Response {
    let raw = uri.path().trim_start_matches('/');
    let path = if raw.is_empty() { "index.html" } else { raw };

    match Assets::get(path) {
        Some(file) => {
            let mime = file.metadata.mimetype();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                // no-store so the app always loads the latest embedded build (parity with Node)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
