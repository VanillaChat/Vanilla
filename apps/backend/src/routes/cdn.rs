use axum::{Router, extract::Path, http::StatusCode, response::IntoResponse, routing::get};
use tower_http::services::ServeDir;

use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new().route("/{*path}", get(serve_cdn))
}

/// Only plain relative paths; attachments have their own route with stricter headers.
fn servable(path: &str) -> bool {
    use std::path::Component;
    let p = std::path::Path::new(path);
    p.components().all(|c| matches!(c, Component::Normal(_))) && !path.starts_with("attachments/")
}

#[utoipa::path(
    get,
    path = "/cdn/{path}",
    tag = "Media",
    summary = "Serve an uploaded image",
    params(("path" = String, Path, description = "Path inside the CDN folder")),
    responses(
    (status = 200, description = "The file"),
    (status = 404, description = "No such file")
),
)]
pub(crate) async fn serve_cdn(Path(path): Path<String>) -> impl IntoResponse {
    if !servable(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cdn_path = std::path::PathBuf::from("./cdn").join(&path);

    if cdn_path.exists() && cdn_path.is_file() {
        match tokio::fs::read(&cdn_path).await {
            Ok(contents) => {
                let content_type = if path.ends_with(".webp") {
                    "image/webp"
                } else if path.ends_with(".png") {
                    "image/png"
                } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                    "image/jpeg"
                } else if path.ends_with(".gif") {
                    "image/gif"
                } else {
                    "application/octet-stream"
                };

                (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, content_type)],
                    contents,
                )
                    .into_response()
            }
            Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        }
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::servable;

    #[test]
    fn rejects_traversal_and_attachment_storage() {
        assert!(servable("avatars/1.webp"));
        assert!(!servable("../.env"));
        assert!(!servable("a/../../b"));
        assert!(!servable("/etc/passwd"));
        assert!(!servable("attachments/123"));
    }
}
