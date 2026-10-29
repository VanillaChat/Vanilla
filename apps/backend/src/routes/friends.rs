//! Friend requests, friendships and blocks.
//!
//! A pair of users has at most one `Friendships` row (keyed by the sorted ids), so a
//! request and its reverse can never exist side by side: sending a request to someone
//! who already asked you simply accepts theirs.
//!
//! Clients learn about changes through `RELATIONSHIP_ADD` / `RELATIONSHIP_REMOVE`.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use axum_extra::extract::CookieJar;
use byteorm_client::{FriendStatus, Friendships};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::dms::{current_user_id, db_err, dispatch, user_by_id};
use crate::error::{ApiError, AppError};
use crate::middleware::rate_limit;
use crate::models::User;
use crate::state::SharedState;

const REQUESTS_PER_MINUTE: i64 = 10;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/", get(list))
        .route("/requests", post(send_request))
        .route("/blocks/{id}", put(block).delete(unblock))
        .route("/{id}", delete(remove))
        .route("/{id}/accept", post(accept))
}

fn pair_key(a: &str, b: &str) -> String {
    let mut pair = [a, b];
    pair.sort();
    pair.join(":")
}

fn conflict(code: &str) -> AppError {
    AppError::Conflict(ApiError {
        code: code.to_string(),
        path: None,
        message: None,
    })
}

async fn friendship(
    state: &SharedState,
    a: &str,
    b: &str,
) -> Result<Option<Friendships>, AppError> {
    Ok(state
        .db
        .friendships
        .find_first(|q| q.where_pair_key(pair_key(a, b)))
        .await?)
}

pub(super) async fn are_friends(state: &SharedState, a: &str, b: &str) -> Result<bool, AppError> {
    Ok(friendship(state, a, b)
        .await?
        .is_some_and(|f| matches!(f.status, FriendStatus::ACCEPTED)))
}

async fn has_blocked(state: &SharedState, blocker: &str, blocked: &str) -> Result<bool, AppError> {
    Ok(state
        .db
        .user_blocks
        .find_first(|q| q.where_block_key(format!("{blocker}:{blocked}")))
        .await?
        .is_some())
}

pub(super) async fn blocked_between(
    state: &SharedState,
    a: &str,
    b: &str,
) -> Result<bool, AppError> {
    Ok(has_blocked(state, a, b).await? || has_blocked(state, b, a).await?)
}

fn relationship(user: &User, kind: &str, since: DateTime<Utc>) -> Value {
    json!({ "user": user, "kind": kind, "since": since.timestamp_millis() })
}

fn kind_for(f: &Friendships, me: &str) -> &'static str {
    match f.status {
        FriendStatus::ACCEPTED => "FRIEND",
        FriendStatus::PENDING if f.requester_id == me => "OUTGOING",
        FriendStatus::PENDING => "INCOMING",
    }
}

fn push_add(state: &SharedState, to: &str, user: &User, kind: &str, since: DateTime<Utc>) {
    state.send_to_user(
        to,
        dispatch("RELATIONSHIP_ADD", relationship(user, kind, since)),
    );
}

fn push_remove(state: &SharedState, to: &str, user_id: &str) {
    state.send_to_user(
        to,
        dispatch("RELATIONSHIP_REMOVE", json!({ "userId": user_id })),
    );
}

async fn announce(state: &SharedState, f: &Friendships) -> Result<(), AppError> {
    let (Some(requester), Some(addressee)) = (
        user_by_id(state, &f.requester_id).await?,
        user_by_id(state, &f.addressee_id).await?,
    ) else {
        return Ok(());
    };
    push_add(
        state,
        &f.requester_id,
        &addressee,
        kind_for(f, &f.requester_id),
        f.created_at,
    );
    push_add(
        state,
        &f.addressee_id,
        &requester,
        kind_for(f, &f.addressee_id),
        f.created_at,
    );
    Ok(())
}

#[utoipa::path(
    get,
    path = "/friends",
    tag = "Friends",
    summary = "List friends, pending requests and blocks",
    description = "`kind` is FRIEND, INCOMING, OUTGOING or BLOCKED.",
    responses(
    (status = 200, description = "Relationships", body = Vec<crate::openapi::Relationship>),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn list(
    State(state): State<SharedState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let mut out = Vec::new();

    let mut rows = state
        .db
        .friendships
        .find_many(|q| q.where_requester_id(me.clone()))
        .await?;
    rows.extend(
        state
            .db
            .friendships
            .find_many(|q| q.where_addressee_id(me.clone()))
            .await?,
    );
    for f in rows {
        let other = if f.requester_id == me {
            &f.addressee_id
        } else {
            &f.requester_id
        };
        if let Some(user) = user_by_id(&state, other).await? {
            out.push(relationship(&user, kind_for(&f, &me), f.created_at));
        }
    }

    for b in state
        .db
        .user_blocks
        .find_many(|q| q.where_blocker_id(me.clone()))
        .await?
    {
        if let Some(user) = user_by_id(&state, &b.blocked_id).await? {
            out.push(relationship(&user, "BLOCKED", b.created_at));
        }
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = FriendRequestCreate)]
pub(crate) struct RequestBody {
    user_id: Option<String>,
    username: Option<String>,
    tag: Option<String>,
}

#[utoipa::path(
    post,
    path = "/friends/requests",
    tag = "Friends",
    summary = "Send a friend request",
    description = "By `userId`, or by `username` plus `tag`. Asking someone who already asked you accepts their request. 10 per minute.",
    request_body = RequestBody,
    responses(
    (status = 200, description = "The resulting relationship", body = crate::openapi::Relationship),
    (status = 400, description = "Invalid target", body = crate::openapi::ErrorBody),
    (status = 403, description = "You blocked them", body = crate::openapi::ErrorBody),
    (status = 404, description = "User not found", body = crate::openapi::ErrorBody),
    (status = 409, description = "Already friends or already pending", body = crate::openapi::ErrorBody),
    (status = 429, description = "Rate limited", body = crate::openapi::RateLimitBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn send_request(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<RequestBody>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;

    let mut redis = state.redis.clone();
    let limited = rate_limit(&mut redis, &me, REQUESTS_PER_MINUTE, 60_000, "friend:req").await?;
    if limited.limited {
        return Err(AppError::TooManyRequests {
            message: "friends.errors.rateLimited".to_string(),
            retry_after: limited.retry_after,
        });
    }

    let target = match (body.user_id, body.username, body.tag) {
        (Some(id), _, _) => user_by_id(&state, &id).await?,
        (None, Some(username), Some(tag)) => state
            .db
            .users
            .find_first(|q| {
                q.where_username(username.trim().to_string())
                    .where_tag(tag.trim().to_string())
            })
            .await?
            .map(User::from),
        _ => {
            return Err(AppError::BadRequest(
                "messages.errors.validationFailed".to_string(),
            ));
        }
    }
    .ok_or_else(|| AppError::NotFound("friends.errors.userNotFound".to_string()))?;

    if target.id == me {
        return Err(AppError::BadRequest("friends.errors.self".to_string()));
    }
    // Someone who blocked you looks exactly like someone who does not exist.
    if has_blocked(&state, &target.id, &me).await? {
        return Err(AppError::NotFound(
            "friends.errors.userNotFound".to_string(),
        ));
    }
    if has_blocked(&state, &me, &target.id).await? {
        return Err(AppError::Forbidden("friends.errors.blocked".to_string()));
    }

    let existing = friendship(&state, &me, &target.id).await?;
    let row = match existing {
        Some(f) if matches!(f.status, FriendStatus::ACCEPTED) => {
            return Err(conflict("friends.errors.alreadyFriends"));
        }
        Some(f) if f.requester_id == me => return Err(conflict("friends.errors.alreadyPending")),
        // They already asked you: asking back means yes.
        Some(f) => {
            state
                .db
                .friendships
                .update(|u| u.where_id(f.id).set_status(FriendStatus::ACCEPTED))
                .await
                .map_err(db_err)?;
            Friendships {
                status: FriendStatus::ACCEPTED,
                ..f
            }
        }
        None => match state
            .db
            .friendships
            .create(|c| {
                c.set_pair_key(pair_key(&me, &target.id))
                    .set_requester_id(me.clone())
                    .set_addressee_id(target.id.clone())
            })
            .await
        {
            Ok(f) => f,
            // Both sides asked at the same moment: the other request won.
            Err(_) if friendship(&state, &me, &target.id).await?.is_some() => {
                return Err(conflict("friends.errors.alreadyPending"));
            }
            Err(e) => return Err(db_err(e)),
        },
    };

    announce(&state, &row).await?;
    Ok(Json(relationship(
        &target,
        kind_for(&row, &me),
        row.created_at,
    )))
}

#[utoipa::path(
    post,
    path = "/friends/{id}/accept",
    tag = "Friends",
    summary = "Accept an incoming request",
    params(("id" = String, Path, description = "Requester user id")),
    responses(
    (status = 200, description = "The new friendship", body = crate::openapi::Relationship),
    (status = 404, description = "No such request", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn accept(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(other): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let no_request = || AppError::NotFound("friends.errors.noRequest".to_string());

    let f = friendship(&state, &me, &other)
        .await?
        .filter(|f| f.requester_id == other)
        .ok_or_else(no_request)?;
    let row = if matches!(f.status, FriendStatus::ACCEPTED) {
        f
    } else {
        state
            .db
            .friendships
            .update(|u| u.where_id(f.id).set_status(FriendStatus::ACCEPTED))
            .await
            .map_err(db_err)?;
        let row = Friendships {
            status: FriendStatus::ACCEPTED,
            ..f
        };
        announce(&state, &row).await?;
        row
    };
    let user = user_by_id(&state, &other).await?.ok_or_else(no_request)?;
    Ok(Json(relationship(
        &user,
        kind_for(&row, &me),
        row.created_at,
    )))
}

#[utoipa::path(
    delete,
    path = "/friends/{id}",
    tag = "Friends",
    summary = "Unfriend, decline or cancel a request",
    description = "Idempotent.",
    params(("id" = String, Path, description = "Other user id")),
    responses(
    (status = 204, description = "Removed"),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn remove(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(other): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    if let Some(f) = friendship(&state, &me, &other).await? {
        state
            .db
            .friendships
            .delete(|d| d.where_id(f.id))
            .await
            .map_err(db_err)?;
        push_remove(&state, &me, &other);
        push_remove(&state, &other, &me);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    put,
    path = "/friends/blocks/{id}",
    tag = "Friends",
    summary = "Block a user",
    description = "Also removes any friendship or request.",
    params(("id" = String, Path, description = "User id")),
    responses(
    (status = 200, description = "The block", body = crate::openapi::Relationship),
    (status = 400, description = "Cannot block yourself", body = crate::openapi::ErrorBody),
    (status = 404, description = "User not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn block(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(other): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    if other == me {
        return Err(AppError::BadRequest("friends.errors.self".to_string()));
    }
    let user = user_by_id(&state, &other)
        .await?
        .ok_or_else(|| AppError::NotFound("friends.errors.userNotFound".to_string()))?;

    if let Some(f) = friendship(&state, &me, &other).await? {
        state
            .db
            .friendships
            .delete(|d| d.where_id(f.id))
            .await
            .map_err(db_err)?;
        push_remove(&state, &other, &me);
    }

    let key = format!("{me}:{other}");
    let since = match state
        .db
        .user_blocks
        .find_first(|q| q.where_block_key(key.clone()))
        .await?
    {
        Some(b) => b.created_at,
        None => {
            state
                .db
                .user_blocks
                .create(|c| {
                    c.set_block_key(key.clone())
                        .set_blocker_id(me.clone())
                        .set_blocked_id(other.clone())
                })
                .await
                .map_err(db_err)?
                .created_at
        }
    };

    push_add(&state, &me, &user, "BLOCKED", since);
    Ok(Json(relationship(&user, "BLOCKED", since)))
}

#[utoipa::path(
    delete,
    path = "/friends/blocks/{id}",
    tag = "Friends",
    summary = "Unblock a user",
    params(("id" = String, Path, description = "User id")),
    responses(
    (status = 204, description = "Unblocked"),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn unblock(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(other): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    state
        .db
        .user_blocks
        .delete(|d| d.where_block_key(format!("{me}:{other}")))
        .await
        .map_err(db_err)?;
    push_remove(&state, &me, &other);
    Ok(StatusCode::NO_CONTENT)
}
