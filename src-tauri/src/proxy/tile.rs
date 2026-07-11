// GET /api/tile/:style/:z/:x/:y  — proxies + caches one XYZ slippy-map tile (Web Mercator)
// from Esri's public ArcGIS imagery/topo services. Capacity-bounded moka cache (TinyLFU),
// 7-day TTL. Note the provider path order is z/y/x.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use reqwest::header::USER_AGENT;

use crate::server::{AppState, CachedTile};

const TILE_UA: &str = "Vantage/0.1 (tactical radar basemap; github.com/ReconGrunt/vantage)";

fn provider_url(style: &str, z: i32, x: i32, y: i32) -> Option<String> {
    let service = match style {
        "sat" => "World_Imagery",
        "terrain" => "World_Topo_Map",
        _ => return None,
    };
    Some(format!(
        "https://server.arcgisonline.com/ArcGIS/rest/services/{}/MapServer/tile/{}/{}/{}",
        service, z, y, x
    ))
}

pub async fn handler(
    State(st): State<AppState>,
    Path((style, z, x, y)): Path<(String, i32, i32, i32)>,
) -> Response {
    let url = match provider_url(&style, z, x, y) {
        Some(u) if (0..=19).contains(&z) && x >= 0 && y >= 0 => u,
        _ => return StatusCode::BAD_REQUEST.into_response(),
    };

    let key = format!("{}/{}/{}/{}", style, z, x, y);
    if let Some(t) = st.tiles.get(&key).await {
        return tile_response(t.content_type, t.bytes);
    }

    match st.http.get(&url).header(USER_AGENT, TILE_UA).send().await {
        Ok(r) if r.status().is_success() => {
            let content_type = r
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("image/png")
                .to_string();
            match r.bytes().await {
                Ok(bytes) => {
                    st.tiles
                        .insert(key, CachedTile { bytes: bytes.clone(), content_type: content_type.clone() })
                        .await;
                    tile_response(content_type, bytes)
                }
                Err(_) => StatusCode::BAD_GATEWAY.into_response(),
            }
        }
        Ok(r) => StatusCode::from_u16(r.status().as_u16())
            .unwrap_or(StatusCode::BAD_GATEWAY)
            .into_response(),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

fn tile_response(content_type: String, bytes: bytes::Bytes) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "public, max-age=604800")
        .body(Body::from(bytes))
        .unwrap()
}
