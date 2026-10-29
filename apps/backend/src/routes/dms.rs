//! Direct messages between two users.
//!
//! Backed by the `DmChannels` / `DmMessages` models in `byteorm/vanilla.bo`.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
};
use axum_extra::extract::CookieJar;
use byteorm_client::DmPrivacy;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

use super::friends::{are_friends, blocked_between};
use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::middleware::rate_limit;
use crate::models::{Message, MessageReference, User};
use crate::state::SharedState;

const MAX_CONTENT: usize = 2000;
const MAX_GROUP: usize = 10;
const MAX_GROUP_NAME: usize = 100;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/", get(list_dms).post(open_dm))
        .route("/groups", post(create_group))
        .route("/{id}/members", post(add_members))
        .route("/{id}/members/@me", delete(leave_group))
        .route("/{id}/messages", get(get_messages).post(create_message))
        .route(
            "/{id}/messages/{message_id}",
            patch(update_message).delete(delete_message),
        )
        .route("/{id}/typing", post(typing))
}

pub(super) fn generate_snowflake() -> String {
    use rand::Rng;
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let timestamp = now - 1420070400000u64;
    let random: u64 = rand::thread_rng().gen_range(0..4096);
    ((timestamp << 22) | random).to_string()
}

pub(super) async fn current_user_id(
    state: &SharedState,
    jar: &CookieJar,
) -> Result<String, AppError> {
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

    let account = state
        .db
        .accounts
        .find_first(|q| q.where_token(token))
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok(account.id)
}

pub(super) fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::InternalServerError(e.to_string())
}

pub(super) async fn user_by_id(state: &SharedState, id: &str) -> Result<Option<User>, AppError> {
    Ok(state
        .db
        .users
        .find_first(|q| q.where_id(id.to_string()))
        .await?
        .map(User::from))
}

async fn member_ids(state: &SharedState, channel_id: &str) -> Result<Vec<String>, AppError> {
    Ok(state
        .db
        .dm_participants
        .find_many(|q| q.where_channel_id(channel_id.to_string()))
        .await?
        .into_iter()
        .map(|p| p.user_id)
        .collect())
}

async fn channel_for(
    state: &SharedState,
    channel_id: &str,
    me: &str,
) -> Result<(byteorm_client::DmChannels, Vec<String>), AppError> {
    let not_found = || AppError::NotFound("dms.errors.notFound".to_string());
    let channel = state
        .db
        .dm_channels
        .find_first(|q| q.where_id(channel_id.to_string()))
        .await?
        .ok_or_else(not_found)?;
    let members = member_ids(state, channel_id).await?;
    // Same answer for "missing" and "not yours" so ids are not probeable.
    if !members.iter().any(|m| m == me) {
        return Err(not_found());
    }
    Ok((channel, members))
}

async fn guild_ids(state: &SharedState, user_id: &str) -> Result<HashSet<String>, AppError> {
    Ok(state
        .db
        .guild_members
        .find_many(|q| q.where_user_id(user_id.to_string()))
        .await?
        .into_iter()
        .map(|m| m.guild_id)
        .collect())
}

/// Checks that every id exists and that the caller may start a conversation with them:
/// not blocked either way, and allowed by the privacy setting of the person being
/// reached (friends always pass, strangers need a shared server unless it is open).
async fn ensure_reachable(state: &SharedState, me: &str, ids: &[String]) -> Result<(), AppError> {
    let mine = guild_ids(state, me).await?;
    for id in ids {
        if id == me {
            continue;
        }
        if user_by_id(state, id).await?.is_none() {
            return Err(AppError::NotFound("dms.errors.userNotFound".to_string()));
        }
        if blocked_between(state, me, id).await? {
            return Err(AppError::Forbidden("dms.errors.blocked".to_string()));
        }
        if are_friends(state, me, id).await? {
            continue;
        }
        let privacy = state
            .db
            .account_settings
            .find_first(|q| q.where_account_id(id.clone()))
            .await?
            .map_or(DmPrivacy::SHARED_SERVERS, |s| s.dm_privacy);
        match privacy {
            DmPrivacy::EVERYONE => {}
            DmPrivacy::FRIENDS => {
                return Err(AppError::Forbidden("dms.errors.friendsOnly".to_string()));
            }
            DmPrivacy::SHARED_SERVERS => {
                if mine.is_disjoint(&guild_ids(state, id).await?) {
                    return Err(AppError::Forbidden("dms.errors.noSharedServer".to_string()));
                }
            }
        }
    }
    Ok(())
}

async fn add_participants(
    state: &SharedState,
    channel_id: &str,
    ids: &[String],
) -> Result<(), AppError> {
    for id in ids {
        state
            .db
            .dm_participants
            .create(|c| {
                c.set_channel_id(channel_id.to_string())
                    .set_user_id(id.clone())
            })
            .await
            .map_err(db_err)?;
    }
    Ok(())
}

async fn channel_json(
    state: &SharedState,
    channel: &byteorm_client::DmChannels,
    members: &[String],
) -> Result<Value, AppError> {
    let mut users = Vec::new();
    for id in members {
        if let Some(u) = user_by_id(state, id).await? {
            users.push(u);
        }
    }
    Ok(json!({
        "id": channel.id,
        "name": channel.name,
        "isGroup": channel.is_group,
        "ownerId": channel.owner_id,
        "members": users,
        "lastMessageAt": channel.last_message_at.timestamp_millis(),
    }))
}

pub(super) fn to_message(m: byteorm_client::DmMessages, author: Option<User>) -> Message {
    let message_reference = m.reference_id.as_ref().map(|mid| MessageReference {
        message_id: Some(mid.clone()),
        channel_id: Some(m.channel_id.clone()),
        guild_id: None,
    });
    Message {
        id: m.id,
        author_id: m.author_id,
        channel_id: m.channel_id,
        guild_id: String::new(),
        content: Some(m.content),
        created_at: Some(m.created_at),
        updated_at: m.updated_at,
        message_type: if m.reference_id.is_some() {
            "REPLY"
        } else {
            "DEFAULT"
        }
        .to_string(),
        nonce: Some(m.nonce),
        author,
        reference_id: m.reference_id,
        message_reference,
        referenced_message: None,
        attachments: Vec::new(),
    }
}

pub(super) fn dispatch(kind: &str, data: impl serde::Serialize) -> String {
    json!({ "op": 0, "t": kind, "d": data }).to_string()
}

fn send_to<'a>(state: &SharedState, ids: impl IntoIterator<Item = &'a String>, event: &str) {
    for id in ids {
        state.send_to_user(id, event.to_string());
    }
}

fn valid_content(content: &str, allow_empty: bool) -> Result<String, AppError> {
    let content = content.trim().to_string();
    if (content.is_empty() && !allow_empty) || content.chars().count() > MAX_CONTENT {
        return Err(AppError::BadRequest(
            "messages.errors.validationFailed".to_string(),
        ));
    }
    Ok(content)
}

fn unique(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

#[utoipa::path(
    get,
    path = "/dms",
    tag = "Direct messages",
    summary = "List your DM conversations",
    description = "Most recently active first, at most 200.",
    responses(
    (status = 200, description = "Conversations", body = Vec<crate::openapi::DmChannel>),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn list_dms(
    State(state): State<SharedState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let mine = state
        .db
        .dm_participants
        .find_many(|q| q.where_user_id(me.clone()))
        .await?;

    let mut channels = Vec::new();
    for p in mine {
        if let Some(c) = state
            .db
            .dm_channels
            .find_first(|q| q.where_id(p.channel_id.clone()))
            .await?
        {
            channels.push(c);
        }
    }
    channels.sort_by(|a, b| b.last_message_at.cmp(&a.last_message_at));

    let mut out = Vec::new();
    for c in channels.iter().take(200) {
        let members = member_ids(&state, &c.id).await?;
        out.push(channel_json(&state, c, &members).await?);
    }
    Ok(Json(out))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenDmRequest {
    user_id: String,
}

#[utoipa::path(
    post,
    path = "/dms",
    tag = "Direct messages",
    summary = "Open (or reuse) a 1:1 conversation",
    description = "Subject to the target's `dmPrivacy` and blocks. Broadcasts DM_CHANNEL_CREATE to the other person on creation.",
    request_body = OpenDmRequest,
    responses(
    (status = 200, description = "The conversation", body = crate::openapi::DmChannel),
    (status = 403, description = "Blocked or not allowed by their privacy setting", body = crate::openapi::ErrorBody),
    (status = 404, description = "User not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn open_dm(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<OpenDmRequest>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    if user_by_id(&state, &body.user_id).await?.is_none() {
        return Err(AppError::NotFound("dms.errors.userNotFound".to_string()));
    }

    // One conversation per pair; talking to yourself is allowed ("saved messages").
    let mut pair = [me.clone(), body.user_id.clone()];
    pair.sort();
    let key = pair.join(":");
    let members = unique(vec![me.clone(), body.user_id.clone()]);

    if let Some(c) = state
        .db
        .dm_channels
        .find_first(|q| q.where_pair_key(Some(key.clone())))
        .await?
    {
        return Ok(Json(channel_json(&state, &c, &members).await?));
    }

    ensure_reachable(&state, &me, &members).await?;

    let channel = state
        .db
        .dm_channels
        .create(|c| {
            c.set_id(generate_snowflake())
                .set_owner_id(me.clone())
                .set_is_group(false)
                .set_pair_key(Some(key.clone()))
        })
        .await
        .map_err(db_err)?;
    add_participants(&state, &channel.id, &members).await?;

    let view = channel_json(&state, &channel, &members).await?;
    send_to(
        &state,
        members.iter().filter(|m| **m != me),
        &dispatch("DM_CHANNEL_CREATE", &view),
    );
    Ok(Json(view))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateGroupRequest {
    user_ids: Vec<String>,
    name: Option<String>,
}

#[utoipa::path(
    post,
    path = "/dms/groups",
    tag = "Direct messages",
    summary = "Create a group conversation",
    description = "2-10 people including you.",
    request_body = CreateGroupRequest,
    responses(
    (status = 200, description = "The conversation", body = crate::openapi::DmChannel),
    (status = 400, description = "Too few or too many members", body = crate::openapi::ErrorBody),
    (status = 403, description = "Not allowed", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_group(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<CreateGroupRequest>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let others: Vec<String> = unique(body.user_ids)
        .into_iter()
        .filter(|id| *id != me)
        .collect();
    if others.len() < 2 {
        return Err(AppError::BadRequest("dms.errors.groupTooSmall".to_string()));
    }
    if others.len() + 1 > MAX_GROUP {
        return Err(AppError::BadRequest("dms.errors.groupTooLarge".to_string()));
    }
    let name = body
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    if name
        .as_ref()
        .is_some_and(|n| n.chars().count() > MAX_GROUP_NAME)
    {
        return Err(AppError::BadRequest(
            "messages.errors.validationFailed".to_string(),
        ));
    }
    ensure_reachable(&state, &me, &others).await?;

    let channel = state
        .db
        .dm_channels
        .create(|c| {
            c.set_id(generate_snowflake())
                .set_owner_id(me.clone())
                .set_is_group(true)
                .set_name(name.clone())
        })
        .await
        .map_err(db_err)?;
    let mut members = vec![me.clone()];
    members.extend(others);
    add_participants(&state, &channel.id, &members).await?;

    let view = channel_json(&state, &channel, &members).await?;
    send_to(
        &state,
        members.iter().filter(|m| **m != me),
        &dispatch("DM_CHANNEL_CREATE", &view),
    );
    Ok(Json(view))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddMembersRequest {
    user_ids: Vec<String>,
}

#[utoipa::path(
    post,
    path = "/dms/{id}/members",
    tag = "Direct messages",
    summary = "Add people to a group",
    params(("id" = String, Path, description = "Conversation id")),
    request_body = AddMembersRequest,
    responses(
    (status = 200, description = "The updated conversation", body = crate::openapi::DmChannel),
    (status = 400, description = "Not a group or too large", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn add_members(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<AddMembersRequest>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (channel, members) = channel_for(&state, &channel_id, &me).await?;
    if !channel.is_group {
        return Err(AppError::BadRequest("dms.errors.notGroup".to_string()));
    }
    let added: Vec<String> = unique(body.user_ids)
        .into_iter()
        .filter(|id| !members.contains(id))
        .collect();
    if added.is_empty() {
        return Err(AppError::BadRequest(
            "messages.errors.validationFailed".to_string(),
        ));
    }
    if members.len() + added.len() > MAX_GROUP {
        return Err(AppError::BadRequest("dms.errors.groupTooLarge".to_string()));
    }
    ensure_reachable(&state, &me, &added).await?;
    add_participants(&state, &channel_id, &added).await?;

    let mut all = members.clone();
    all.extend(added.iter().cloned());
    let view = channel_json(&state, &channel, &all).await?;
    send_to(&state, added.iter(), &dispatch("DM_CHANNEL_CREATE", &view));
    send_to(
        &state,
        members.iter(),
        &dispatch("DM_CHANNEL_UPDATE", &view),
    );
    Ok(Json(view))
}

#[utoipa::path(
    delete,
    path = "/dms/{id}/members/@me",
    tag = "Direct messages",
    summary = "Leave a group",
    params(("id" = String, Path, description = "Conversation id")),
    responses(
    (status = 204, description = "Left"),
    (status = 400, description = "Not a group", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn leave_group(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (channel, members) = channel_for(&state, &channel_id, &me).await?;
    if !channel.is_group {
        return Err(AppError::BadRequest("dms.errors.notGroup".to_string()));
    }
    state
        .db
        .dm_participants
        .delete(|d| {
            d.where_channel_id(channel_id.clone())
                .where_user_id(me.clone())
        })
        .await?;
    state.send_to_user(
        &me,
        dispatch("DM_CHANNEL_DELETE", json!({ "id": channel_id })),
    );

    let remaining: Vec<String> = members.into_iter().filter(|m| *m != me).collect();
    if remaining.is_empty() {
        state
            .db
            .dm_channels
            .delete(|d| d.where_id(channel_id.clone()))
            .await?;
    } else {
        let mut channel = channel;
        if channel.owner_id == me {
            let heir = remaining[0].clone();
            state
                .db
                .dm_channels
                .update(|u| u.set_owner_id(heir.clone()).where_id(channel_id.clone()))
                .await?;
            channel.owner_id = heir;
        }
        let view = channel_json(&state, &channel, &remaining).await?;
        send_to(
            &state,
            remaining.iter(),
            &dispatch("DM_CHANNEL_UPDATE", &view),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct MessagesQuery {
    limit: Option<i64>,
    before: Option<String>,
    after: Option<String>,
    around: Option<String>,
}

#[utoipa::path(
    get,
    path = "/dms/{id}/messages",
    tag = "Direct messages",
    summary = "List DM messages",
    description = "Same paging as channel messages.",
    params(("id" = String, Path, description = "Conversation id"), MessagesQuery),
    responses(
    (status = 200, description = "Messages", body = Vec<crate::models::Message>),
    (status = 404, description = "Conversation not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn get_messages(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (_, members) = channel_for(&state, &channel_id, &me).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100) as usize;

    let base = || {
        state
            .db
            .dm_messages
            .query()
            .where_channel_id(channel_id.clone())
    };
    let found = if let Some(around) = &q.around {
        let half = (limit / 2).max(1);
        let mut newer = base()
            .where_id_gt(around.clone())
            .order_by_created_at_asc()
            .limit(half)
            .find_many_json()
            .await
            .map_err(db_err)?;
        newer.reverse();
        let current = base()
            .where_id(around.clone())
            .find_many_json()
            .await
            .map_err(db_err)?;
        let older = base()
            .where_id_lt(around.clone())
            .order_by_created_at_desc()
            .limit(half)
            .find_many_json()
            .await
            .map_err(db_err)?;
        [newer, current, older].concat()
    } else {
        let mut builder = base().order_by_created_at_desc().limit(limit);
        if let Some(before) = &q.before {
            builder = builder.where_id_lt(before.clone());
        } else if let Some(after) = &q.after {
            builder = builder.where_id_gt(after.clone());
        }
        builder.find_many_json().await.map_err(db_err)?
    };
    let rows: Vec<byteorm_client::DmMessages> = found
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()
        .map_err(db_err)?;

    // Authors may have left the group since, so look up by the messages, not the members.
    let mut authors: Vec<User> = Vec::new();
    let mut ids: Vec<String> = members;
    ids.extend(rows.iter().map(|m| m.author_id.clone()));
    for id in unique(ids) {
        if let Some(u) = user_by_id(&state, &id).await? {
            authors.push(u);
        }
    }
    let mut out: Vec<Message> = rows
        .into_iter()
        .map(|m| {
            let author = authors.iter().find(|u| u.id == m.author_id).cloned();
            to_message(m, author)
        })
        .collect();
    crate::attachments::fill(&state, &mut out).await?;
    Ok(Json(out))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = DmMessageReference)]
pub(crate) struct ReferenceBody {
    message_id: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
#[schema(as = DmMessageCreate)]
pub(crate) struct CreateBody {
    content: String,
    nonce: Option<String>,
    message_reference: Option<ReferenceBody>,
    /// Ids from `POST /attachments`, at most 10. Lets `content` be empty.
    #[serde(default)]
    attachment_ids: Vec<String>,
}

#[utoipa::path(
    post,
    path = "/dms/{id}/messages",
    tag = "Direct messages",
    summary = "Send a DM",
    description = "6 messages per 5 seconds. Content is 1-2000 characters.",
    params(("id" = String, Path, description = "Conversation id")),
    request_body = CreateBody,
    responses(
    (status = 200, description = "Created message", body = crate::models::Message),
    (status = 403, description = "Blocked", body = crate::openapi::ErrorBody),
    (status = 404, description = "Conversation not found", body = crate::openapi::ErrorBody),
    (status = 429, description = "Rate limited", body = crate::openapi::RateLimitBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_message(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<CreateBody>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (channel, members) = channel_for(&state, &channel_id, &me).await?;
    let content = valid_content(&body.content, !body.attachment_ids.is_empty())?;
    let claimed = crate::attachments::claim(&state, &me, &body.attachment_ids).await?;
    if !channel.is_group {
        for other in members.iter().filter(|m| **m != me) {
            if blocked_between(&state, &me, other).await? {
                return Err(AppError::Forbidden("dms.errors.blocked".to_string()));
            }
        }
    }

    let mut redis = state.redis.clone();
    let limited = rate_limit(&mut redis, &me, 6, 5000, "dm:msg").await?;
    if limited.limited {
        return Err(AppError::TooManyRequests {
            message: "messages.errors.rateLimited".to_string(),
            retry_after: limited.retry_after,
        });
    }

    let author = user_by_id(&state, &me)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let nonce = body.nonce.unwrap_or_else(|| "0".to_string());

    // A reply must point at a message of this very conversation.
    let mut referenced: Option<Message> = None;
    if let Some(rid) = body.message_reference.and_then(|r| r.message_id) {
        let found = state
            .db
            .dm_messages
            .find_first(|q| q.where_id(rid.clone()).where_channel_id(channel_id.clone()))
            .await?;
        if let Some(r) = found {
            let ref_author = user_by_id(&state, &r.author_id).await?;
            referenced = Some(to_message(r, ref_author));
        }
    }
    let reference_id = referenced.as_ref().map(|r| r.id.clone());

    let created = state
        .db
        .dm_messages
        .create(|c| {
            let builder = c
                .set_id(generate_snowflake())
                .set_channel_id(channel_id.clone())
                .set_author_id(me.clone())
                .set_content(content.clone())
                .set_nonce(nonce.clone());
            match reference_id.clone() {
                Some(rid) => builder.set_reference_id(Some(rid)),
                None => builder,
            }
        })
        .await
        .map_err(db_err)?;

    state
        .db
        .dm_channels
        .update(|u| {
            u.set_last_message_at(created.created_at)
                .where_id(channel_id.clone())
        })
        .await?;

    let message_id = created.id.clone();
    let mut message = to_message(created, Some(author));
    message.referenced_message = referenced.map(Box::new);
    message.attachments = crate::attachments::bind(&state, claimed, &message_id).await?;
    send_to(
        &state,
        members.iter(),
        &dispatch("MESSAGE_CREATE", &message),
    );
    Ok(Json(message))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[schema(as = DmMessageUpdate)]
pub(crate) struct UpdateBody {
    content: String,
}

#[utoipa::path(
    patch,
    path = "/dms/{id}/messages/{message_id}",
    tag = "Direct messages",
    summary = "Edit a DM",
    params(("id" = String, Path, description = "Conversation id"), ("message_id" = String, Path, description = "Message id")),
    request_body = UpdateBody,
    responses(
    (status = 200, description = "Updated message", body = crate::models::Message),
    (status = 403, description = "Not the author", body = crate::openapi::ErrorBody),
    (status = 404, description = "Message not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_message(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((channel_id, message_id)): Path<(String, String)>,
    Json(body): Json<UpdateBody>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (_, members) = channel_for(&state, &channel_id, &me).await?;
    let content = valid_content(&body.content, false)?;

    let existing = state
        .db
        .dm_messages
        .find_first(|q| {
            q.where_id(message_id.clone())
                .where_channel_id(channel_id.clone())
        })
        .await?
        .ok_or_else(|| AppError::NotFound("messages.errors.messageNotFound".to_string()))?;
    if existing.author_id != me {
        return Err(AppError::Forbidden("messages.errors.notAuthor".to_string()));
    }

    state
        .db
        .dm_messages
        .update(|u| {
            u.set_content(content.clone())
                .set_updated_at(Some(chrono::Utc::now()))
                .where_id(message_id.clone())
        })
        .await?;
    let updated = state
        .db
        .dm_messages
        .find_first(|q| q.where_id(message_id.clone()))
        .await?
        .ok_or_else(|| AppError::InternalServerError("Failed to update message".to_string()))?;

    let author = user_by_id(&state, &me).await?;
    let mut message = to_message(updated, author);
    crate::attachments::fill(&state, std::slice::from_mut(&mut message)).await?;
    send_to(
        &state,
        members.iter(),
        &dispatch("MESSAGE_UPDATE", &message),
    );
    Ok(Json(message))
}

#[utoipa::path(
    delete,
    path = "/dms/{id}/messages/{message_id}",
    tag = "Direct messages",
    summary = "Delete a DM",
    params(("id" = String, Path, description = "Conversation id"), ("message_id" = String, Path, description = "Message id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Not the author", body = crate::openapi::ErrorBody),
    (status = 404, description = "Message not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_message(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((channel_id, message_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (_, members) = channel_for(&state, &channel_id, &me).await?;

    let existing = state
        .db
        .dm_messages
        .find_first(|q| {
            q.where_id(message_id.clone())
                .where_channel_id(channel_id.clone())
        })
        .await?
        .ok_or_else(|| AppError::NotFound("messages.errors.messageNotFound".to_string()))?;
    if existing.author_id != me {
        return Err(AppError::Forbidden("messages.errors.notAuthor".to_string()));
    }

    state
        .db
        .dm_messages
        .delete(|d| d.where_id(message_id.clone()))
        .await?;
    crate::attachments::remove_for_messages(&state, vec![message_id.clone()]).await;

    send_to(
        &state,
        members.iter(),
        &dispatch(
            "MESSAGE_DELETE",
            json!({ "id": message_id, "channelId": channel_id, "guildId": "" }),
        ),
    );
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/dms/{id}/typing",
    tag = "Direct messages",
    summary = "Signal that you are typing",
    params(("id" = String, Path, description = "Conversation id")),
    responses(
    (status = 200, description = "Sent", body = crate::openapi::SuccessBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn typing(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let me = current_user_id(&state, &jar).await?;
    let (_, members) = channel_for(&state, &channel_id, &me).await?;
    let user = user_by_id(&state, &me)
        .await?
        .ok_or(AppError::Unauthorized)?;
    let now = chrono::Utc::now().timestamp_millis();

    let event = dispatch(
        "TYPING_START",
        json!({
            "channelId": channel_id,
            "userId": user.id,
            "user": {
                "id": user.id,
                "username": user.username,
                "tag": user.tag,
                "avatar": user.avatar,
                "member": { "nickname": null }
            },
            "timestamp": now,
            "expiresAt": now + 10000
        }),
    );
    send_to(&state, members.iter().filter(|m| **m != me), &event);
    Ok(Json(json!({ "success": true })))
}
