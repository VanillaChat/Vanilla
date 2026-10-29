use axum::{
    Json, Router,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use axum_extra::extract::CookieJar;
use serde_json::json;
use std::net::SocketAddr;

use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::models::{User, UserFlags, badge_bit};
use crate::state::SharedState;

fn generate_snowflake() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let epoch = 1420070400000u64;
    let timestamp = now - epoch;

    use rand::Rng;
    let random: u64 = rand::thread_rng().gen_range(0..4096);

    let id = (timestamp << 22) | random;
    id.to_string()
}

fn generate_code() -> String {
    use rand::Rng;
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        .chars()
        .collect();
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| chars[rng.gen_range(0..chars.len())])
        .collect()
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/gateway-metrics", get(gateway_metrics))
        .route("/invite-codes", post(create_invite_code))
        .route("/invite-codes/{id}", delete(delete_invite_code))
        .route(
            "/users/{id}/badges/{badge}",
            put(grant_badge).delete(revoke_badge),
        )
}

#[utoipa::path(
    get,
    path = "/admin/gateway-metrics",
    tag = "Admin",
    summary = "Gateway metrics snapshot",
    description = "Local only: refused when the request did not come straight from this machine, or came through a proxy (forwarding headers present). Used by the monitor.",
    responses(
    (status = 200, description = "Counters and recent events", body = serde_json::Value),
    (status = 403, description = "Not a local request", body = crate::openapi::ErrorBody)
),
)]
pub(crate) async fn gateway_metrics(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, AppError> {
    if !is_direct_local(peer, &headers) {
        return Err(AppError::Forbidden("admin.localOnly".to_string()));
    }
    Ok(Json(
        state.gateway_metrics.snapshot(state.connected_users.len()),
    ))
}

/// A reverse proxy on the same machine also connects from loopback, so the headers it adds
/// are what tells its traffic apart from the monitor's.
fn is_direct_local(peer: SocketAddr, headers: &HeaderMap) -> bool {
    const PROXY_HEADERS: [&str; 5] = [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    ];
    peer.ip().is_loopback() && !PROXY_HEADERS.iter().any(|h| headers.contains_key(*h))
}

async fn get_admin_user(
    state: &SharedState,
    jar: &CookieJar,
) -> Result<(byteorm_client::Accounts, byteorm_client::Users), AppError> {
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

    let _token_data =
        verify_token(&token, &state.config.token_secret).ok_or(AppError::Unauthorized)?;

    let account = state
        .db
        .accounts
        .find_first(|q| q.where_token(token))
        .await?
        .ok_or(AppError::Unauthorized)?;

    let user = state
        .db
        .users
        .find_first(|q| q.where_id(account.user_id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    if (user.flags & UserFlags::ADMIN) != UserFlags::ADMIN {
        return Err(AppError::Forbidden("Admin access required".to_string()));
    }

    Ok((account, user))
}

#[utoipa::path(
    post,
    path = "/admin/invite-codes",
    tag = "Admin",
    summary = "Create a registration invite code",
    description = "Admin only.",
    responses(
    (status = 200, description = "Created code", body = crate::openapi::AdminInviteCode),
    (status = 403, description = "Not an admin", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_invite_code(
    State(state): State<SharedState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    let (account, _user) = get_admin_user(&state, &jar).await?;

    let id = generate_snowflake();
    let code = generate_code();

    let invite = state
        .db
        .invite_codes
        .create(|c| {
            c.set_id(id.clone())
                .set_code(code.clone())
                .set_created_by(account.id.clone())
                .set_used(false)
        })
        .await?;

    Ok(Json(json!({
        "id": invite.id,
        "code": invite.code,
        "createdBy": invite.created_by,
        "used": invite.used,
    })))
}

#[utoipa::path(
    delete,
    path = "/admin/invite-codes/{id}",
    tag = "Admin",
    summary = "Delete a registration invite code",
    description = "Admin only. Broadcasts INVITE_CODE_DELETE to admins.",
    params(("id" = String, Path, description = "Invite code id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Not an admin", body = crate::openapi::ErrorBody),
    (status = 404, description = "Not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_invite_code(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let (account, _user) = get_admin_user(&state, &jar).await?;

    let invite = state
        .db
        .invite_codes
        .find_first(|q| q.where_id(id.clone()))
        .await?
        .ok_or(AppError::NotFound("Invite code not found".to_string()))?;

    if invite.used {
        return Err(AppError::Forbidden(
            "Cannot delete used invite code".to_string(),
        ));
    }

    state
        .db
        .invite_codes
        .delete(|d| d.where_id(id.clone()))
        .await?;

    let broadcast = json!({
        "op": 0,
        "t": "INVITE_CODE_DELETE",
        "d": {
            "executor": account.id,
            "id": id
        }
    });
    state.broadcast_to_room("admins", broadcast.to_string());

    Ok(StatusCode::NO_CONTENT)
}

async fn change_badge(
    state: &SharedState,
    jar: &CookieJar,
    user_id: &str,
    badge: &str,
    grant: bool,
) -> Result<User, AppError> {
    get_admin_user(state, jar).await?;
    let bit = badge_bit(badge)
        .ok_or_else(|| AppError::NotFound("admin.errors.unknownBadge".to_string()))?;
    let target = state
        .db
        .users
        .find_first(|q| q.where_id(user_id.to_string()))
        .await?
        .ok_or_else(|| AppError::NotFound("admin.errors.userNotFound".to_string()))?;
    let bits = if grant {
        target.badges | bit
    } else {
        target.badges & !bit
    };
    state
        .db
        .users
        .update(|u| u.where_id(user_id.to_string()).set_badges(bits))
        .await?;
    let user = User::from(byteorm_client::Users {
        badges: bits,
        ..target
    });
    crate::status::broadcast_user(state, &user).await;
    Ok(user)
}

#[utoipa::path(
    put,
    path = "/admin/users/{id}/badges/{badge}",
    tag = "Admin",
    summary = "Give a user a badge",
    description = "Admin only. Badges: early_adopter, contributor, supporter, bug_hunter. `staff` follows the admin flag. Broadcasts USER_UPDATE.",
    params(
        ("id" = String, Path, description = "User id"),
        ("badge" = String, Path, description = "Badge id")
    ),
    responses(
        (status = 200, description = "The user with the badge", body = crate::models::User),
        (status = 403, description = "Not an admin", body = crate::openapi::ErrorBody),
        (status = 404, description = "Unknown user or badge", body = crate::openapi::ErrorBody),
        (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
    ),
    security(("cookie" = [])),
)]
pub(crate) async fn grant_badge(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((id, badge)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(change_badge(&state, &jar, &id, &badge, true).await?))
}

#[utoipa::path(
    delete,
    path = "/admin/users/{id}/badges/{badge}",
    tag = "Admin",
    summary = "Take a badge from a user",
    description = "Admin only. Idempotent. Broadcasts USER_UPDATE.",
    params(
        ("id" = String, Path, description = "User id"),
        ("badge" = String, Path, description = "Badge id")
    ),
    responses(
        (status = 200, description = "The user without the badge", body = crate::models::User),
        (status = 403, description = "Not an admin", body = crate::openapi::ErrorBody),
        (status = 404, description = "Unknown user or badge", body = crate::openapi::ErrorBody),
        (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
    ),
    security(("cookie" = [])),
)]
pub(crate) async fn revoke_badge(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((id, badge)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(change_badge(&state, &jar, &id, &badge, false).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> SocketAddr {
        "127.0.0.1:50000".parse().unwrap()
    }

    #[test]
    fn plain_local_request_is_allowed() {
        assert!(is_direct_local(local(), &HeaderMap::new()));
    }

    #[test]
    fn remote_peer_is_refused() {
        assert!(!is_direct_local(
            "203.0.113.5:443".parse().unwrap(),
            &HeaderMap::new()
        ));
    }

    #[test]
    fn proxied_request_is_refused_even_from_loopback() {
        for name in [
            "x-forwarded-for",
            "forwarded",
            "x-real-ip",
            "x-forwarded-proto",
        ] {
            let mut h = HeaderMap::new();
            h.insert(name, "1.2.3.4".parse().unwrap());
            assert!(!is_direct_local(local(), &h), "{name}");
        }
    }
}
