use axum::{
    Json, Router,
    extract::{Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use url::Url;

use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::state::SharedState;
use crate::unfurl;

const MAX_URL_LEN: usize = 2048;

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct UrlQuery {
    url: String,
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/", get(link_preview))
        .route("/image", get(image))
}

/// Link previews are for signed-in users only, so the endpoint is not an open fetcher.
async fn require_user(state: &SharedState, jar: &CookieJar) -> Result<(), AppError> {
    let is_production = std::env::var("NODE_ENV").unwrap_or_default() == "production";
    let cookie_name = if is_production {
        "__Host-Token"
    } else {
        "token"
    };

    let token = jar
        .get(cookie_name)
        .map(|c| c.value().to_string())
        .ok_or(AppError::Unauthorized)?;
    verify_token(&token, &state.config.token_secret).ok_or(AppError::Unauthorized)?;
    state
        .db
        .accounts
        .find_first(|q| q.where_token(token))
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(())
}

fn parse(raw: &str) -> Result<Url, AppError> {
    if raw.len() > MAX_URL_LEN {
        return Err(AppError::BadRequest("url too long".to_string()));
    }
    Url::parse(raw).map_err(|_| AppError::BadRequest("invalid url".to_string()))
}

#[utoipa::path(
    get,
    path = "/unfurl",
    tag = "Media",
    summary = "Fetch a link preview",
    params(UrlQuery),
    responses(
    (status = 200, description = "Preview", body = crate::unfurl::Preview),
    (status = 404, description = "Nothing to preview (NO_PREVIEW)", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn link_preview(
    State(state): State<SharedState>,
    jar: CookieJar,
    Query(q): Query<UrlQuery>,
) -> Result<Response, AppError> {
    if !state.config.link_previews {
        return Err(AppError::NotFound("NO_PREVIEW".to_string()));
    }
    require_user(&state, &jar).await?;
    let url = parse(&q.url)?;

    // Every failure looks the same from outside: nothing to preview.
    match unfurl::preview(url).await {
        Ok(Some(preview)) => Ok(Json(preview).into_response()),
        _ => Err(AppError::NotFound("NO_PREVIEW".to_string())),
    }
}

#[utoipa::path(
    get,
    path = "/unfurl/image",
    tag = "Media",
    summary = "Proxy a preview image",
    params(UrlQuery),
    responses(
    (status = 200, description = "The image bytes"),
    (status = 404, description = "No image (NO_IMAGE)", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn image(
    State(state): State<SharedState>,
    jar: CookieJar,
    Query(q): Query<UrlQuery>,
) -> Result<Response, AppError> {
    if !state.config.link_previews {
        return Err(AppError::NotFound("NO_IMAGE".to_string()));
    }
    require_user(&state, &jar).await?;
    let url = parse(&q.url)?;

    let fetched = unfurl::fetch_image(url)
        .await
        .map_err(|_| AppError::NotFound("NO_IMAGE".to_string()))?;

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, fetched.content_type),
            (header::CACHE_CONTROL, "private, max-age=86400".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'".to_string(),
            ),
        ],
        fetched.body,
    )
        .into_response())
}
