//! Upload and download of message attachments. See `crate::attachments` for the model.

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_extra::extract::CookieJar;

use super::dms::{current_user_id, db_err};
use crate::attachments::{Attachment, MAX_PENDING_PER_USER, file_path, sanitize_filename, sniff};
use crate::error::AppError;
use crate::middleware::rate_limit;
use crate::state::SharedState;

const UPLOADS_PER_MINUTE: i64 = 30;
/// Hard ceiling for the request body; the configured limit is enforced while reading.
const BODY_CEILING: usize = 100 * 1024 * 1024;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/attachments",
            post(upload).layer(DefaultBodyLimit::max(BODY_CEILING)),
        )
        .route("/cdn/attachments/{id}/{filename}", get(download))
}

#[utoipa::path(
    post,
    path = "/attachments",
    tag = "Attachments",
    summary = "Upload a file",
    description = "Multipart with one `file` field, up to MAX_ATTACHMENT_SIZE (25 MB by default). Pass the returned `id` in `attachmentIds` when sending a message within an hour, or the upload is discarded. At most 20 unclaimed uploads at a time, 30 uploads per minute.",
    request_body(content = crate::openapi::ImageUpload, content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "Stored file", body = Attachment),
        (status = 400, description = "Missing or too large (attachments.errors.*)", body = crate::openapi::ErrorBody),
        (status = 429, description = "Rate limited", body = crate::openapi::RateLimitBody),
        (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
    ),
    security(("cookie" = [])),
)]
pub(crate) async fn upload(
    State(state): State<SharedState>,
    jar: CookieJar,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;

    let mut redis = state.redis.clone();
    let limited = rate_limit(&mut redis, &me, UPLOADS_PER_MINUTE, 60_000, "attachment:up").await?;
    if limited.limited {
        return Err(AppError::TooManyRequests {
            message: "attachments.errors.rateLimited".to_string(),
            retry_after: limited.retry_after,
        });
    }

    let pending = state
        .db
        .attachments
        .find_many(|q| q.where_uploader_id(me.clone()).where_message_id_is_null())
        .await?
        .len();
    if pending >= MAX_PENDING_PER_USER {
        return Err(AppError::BadRequest(
            "attachments.errors.tooManyPending".to_string(),
        ));
    }

    let max = state.config.max_attachment_size;
    let mut found: Option<(String, Vec<u8>)> = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let name = sanitize_filename(field.file_name().unwrap_or("file"));
        let mut bytes = Vec::new();
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?
        {
            if bytes.len() + chunk.len() > max {
                return Err(AppError::BadRequest(
                    "attachments.errors.tooLarge".to_string(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        found = Some((name, bytes));
        break;
    }
    let (filename, bytes) =
        found.ok_or_else(|| AppError::BadRequest("attachments.errors.missing".to_string()))?;
    if bytes.is_empty() {
        return Err(AppError::BadRequest(
            "attachments.errors.missing".to_string(),
        ));
    }

    let sniffed = tokio::task::spawn_blocking({
        let head = bytes.clone();
        move || sniff(&head)
    })
    .await
    .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let id = super::dms::generate_snowflake();
    let path = file_path(&id);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::InternalServerError(e.to_string()))?;
    }
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let size = bytes.len() as i32;
    let row = state
        .db
        .attachments
        .create(|c| {
            let c = c
                .set_id(id.clone())
                .set_uploader_id(me.clone())
                .set_filename(filename.clone())
                .set_content_type(sniffed.content_type.to_string())
                .set_size(size);
            let c = match sniffed.width {
                Some(w) => c.set_width(Some(w)),
                None => c,
            };
            match sniffed.height {
                Some(h) => c.set_height(Some(h)),
                None => c,
            }
        })
        .await;
    match row {
        Ok(row) => Ok(Json(Attachment::from(row))),
        Err(e) => {
            let _ = tokio::fs::remove_file(&path).await;
            Err(db_err(e))
        }
    }
}

#[utoipa::path(
    get,
    path = "/cdn/attachments/{id}/{filename}",
    tag = "Attachments",
    summary = "Download an attachment",
    description = "Public: anyone with the link can fetch it, the id is unguessable. Only PNG, JPEG, GIF and WebP are served inline; every other type is a forced download.",
    params(
        ("id" = String, Path, description = "Attachment id"),
        ("filename" = String, Path, description = "Original name, used for display only")
    ),
    responses(
        (status = 200, description = "The file"),
        (status = 404, description = "No such attachment")
    ),
)]
pub(crate) async fn download(
    State(state): State<SharedState>,
    Path((id, _filename)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let not_found = || AppError::NotFound("attachments.errors.notFound".to_string());
    let row = state
        .db
        .attachments
        .find_first(|q| q.where_id(id.clone()))
        .await?
        .ok_or_else(not_found)?;
    let bytes = tokio::fs::read(file_path(&row.id))
        .await
        .map_err(|_| not_found())?;

    let inline = row.content_type.starts_with("image/");
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        urlencoding::encode(&row.filename)
    );
    let mut res = Response::new(Body::from(bytes));
    *res.status_mut() = StatusCode::OK;
    let h = res.headers_mut();
    let set = |h: &mut axum::http::HeaderMap, k, v: &str| {
        if let Ok(v) = HeaderValue::from_str(v) {
            h.insert(k, v);
        }
    };
    set(h, header::CONTENT_TYPE, &row.content_type);
    set(h, header::CONTENT_DISPOSITION, &disposition);
    set(h, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(
        h,
        header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox",
    );
    set(
        h,
        header::CACHE_CONTROL,
        "public, max-age=31536000, immutable",
    );
    Ok(res)
}
