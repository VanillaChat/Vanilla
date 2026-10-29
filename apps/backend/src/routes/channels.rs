use crate::audit::{self, Changes, Target};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;

use byteorm_client::MessageType;

use crate::auth::token::verify_token;
use crate::error::{AppError, FieldError};
use crate::middleware::rate_limit;
use crate::models::{Invite, Message, User};
use crate::state::SharedState;

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
struct MessageReferenceRequest {
    #[serde(alias = "messageId")]
    message_id: Option<String>,
    #[serde(default, alias = "channelId")]
    channel_id: Option<String>,
    #[serde(default, alias = "guildId")]
    guild_id: Option<String>,
    #[serde(default = "default_true", alias = "failIfNotExists")]
    fail_if_not_exists: bool,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct MessageCreateRequest {
    content: String,
    nonce: Option<String>,
    #[serde(default, alias = "messageReference")]
    message_reference: Option<MessageReferenceRequest>,
    /// Ids from `POST /attachments`, at most 10. Lets `content` be empty.
    #[serde(default, rename = "attachmentIds", alias = "attachment_ids")]
    attachment_ids: Vec<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct MessageUpdateRequest {
    content: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MessagesQuery {
    before: Option<String>,
    after: Option<String>,
    limit: Option<i64>,
    around: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct InviteCreateRequest {
    max_uses: Option<i32>,
    max_age: Option<i32>,
}

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
    (0..6)
        .map(|_| chars[rng.gen_range(0..chars.len())])
        .collect()
}

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/{id}", patch(update_channel).delete(delete_channel))
        .route("/{id}/messages", get(get_messages))
        .route("/{id}/messages", post(create_message))
        .route("/{id}/messages/{message_id}", patch(update_message))
        .route("/{id}/messages/{message_id}", delete(delete_message))
        .route("/{id}/typing", post(typing_start))
        .route("/{id}/invites", post(create_invite))
}

async fn get_current_user(
    state: &SharedState,
    jar: &CookieJar,
) -> Result<byteorm_client::Accounts, AppError> {
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

    state
        .db
        .accounts
        .find_first(|q| q.where_token(token))
        .await?
        .ok_or(AppError::Unauthorized)
}

async fn get_channel_and_member(
    state: &SharedState,
    channel_id: &str,
    user_id: &str,
) -> Result<(byteorm_client::Channels, byteorm_client::GuildMembers), AppError> {
    let channel = state
        .db
        .channels
        .find_first(|q| q.where_id(channel_id.to_string()))
        .await?
        .ok_or(AppError::NotFound(
            "messages.errors.channelNotFound".to_string(),
        ))?;

    let member = state
        .db
        .guild_members
        .find_first(|q| {
            q.where_user_id(user_id.to_string())
                .where_guild_id(channel.guild_id.clone())
        })
        .await?
        .ok_or(AppError::Unauthorized)?;

    Ok((channel, member))
}

#[utoipa::path(
    get,
    path = "/channels/{id}/messages",
    tag = "Messages",
    summary = "List channel messages",
    description = "Newest first. `around` returns a page centred on that message. `limit` is 1-100, default 50.",
    params(("id" = String, Path, description = "Channel id"), MessagesQuery),
    responses(
    (status = 200, description = "Messages", body = Vec<crate::models::Message>),
    (status = 404, description = "Channel not found or not a member", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn get_messages(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;

    let limit = query.limit.unwrap_or(50).min(100).max(1) as usize;

    let db_err =
        |e: Box<dyn std::error::Error + Send + Sync>| AppError::InternalServerError(e.to_string());
    let base = || {
        state
            .db
            .messages
            .query()
            .where_channel_id(channel_id.clone())
            .include_users()
    };

    let messages_json = if let Some(around) = &query.around {
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
        if let Some(before) = &query.before {
            builder = builder.where_id_lt(before.clone());
        } else if let Some(after) = &query.after {
            builder = builder.where_id_gt(after.clone());
        }
        builder.find_many_json().await.map_err(db_err)?
    };

    let mut messages: Vec<Message> = messages_json
        .into_iter()
        .map(|value| {
            let msg_model: byteorm_client::Messages =
                serde_json::from_value(value.clone()).expect("Failed to deserialize message");

            let user_json = value.get("users").expect("Missing users join");
            let user_model: byteorm_client::Users =
                serde_json::from_value(user_json.clone()).expect("Failed to deserialize user");

            let mut msg: Message = msg_model.into();
            let user: User = user_model.into();

            msg.author = Some(user);

            msg
        })
        .collect();

    let ref_ids: Vec<String> = {
        let mut ids: Vec<String> = messages
            .iter()
            .filter_map(|m| m.reference_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    };

    if !ref_ids.is_empty() {
        let ref_msgs = state
            .db
            .messages
            .query()
            .where_id_in(ref_ids.clone())
            .include_users()
            .find_many_json()
            .await
            .map_err(|e| AppError::InternalServerError(e.to_string()))?;

        let ref_map: std::collections::HashMap<String, Message> = ref_msgs
            .into_iter()
            .map(|value| {
                let msg_model: byteorm_client::Messages = serde_json::from_value(value.clone())
                    .expect("Failed to deserialize referenced message");
                let user_json = value.get("users").expect("Missing users join");
                let user_model: byteorm_client::Users = serde_json::from_value(user_json.clone())
                    .expect("Failed to deserialize referenced user");
                let mut msg: Message = msg_model.into();
                msg.author = Some(user_model.into());
                (msg.id.clone(), msg)
            })
            .collect();

        for msg in messages.iter_mut() {
            if let Some(rid) = msg.reference_id.as_ref() {
                if let Some(ref_msg) = ref_map.get(rid) {
                    msg.referenced_message = Some(Box::new(ref_msg.clone()));
                }
            }
        }
    }

    messages.reverse();
    crate::attachments::fill(&state, &mut messages).await?;

    Ok(Json(messages))
}

#[utoipa::path(
    post,
    path = "/channels/{id}/messages",
    tag = "Messages",
    summary = "Send a message",
    description = "Content is 1-2000 characters. Broadcasts MESSAGE_CREATE. Needs SEND_MESSAGES. Honours the channel slowmode, unless you have MANAGE_MESSAGES or MANAGE_CHANNELS.",
    params(("id" = String, Path, description = "Channel id")),
    request_body = MessageCreateRequest,
    responses(
    (status = 200, description = "Created message", body = crate::models::Message),
    (status = 400, description = "Invalid content or reference", body = crate::openapi::ErrorBody),
    (status = 404, description = "Channel or referenced message not found", body = crate::openapi::ErrorBody),
    (status = 429, description = "Rate limited", body = crate::openapi::RateLimitBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_message(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, AppError> {
    let body: MessageCreateRequest = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("Invalid JSON".to_string()))?;
    let account = get_current_user(&state, &jar).await?;
    let (channel, member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    crate::permissions::require(
        &state,
        &member.guild_id,
        &account.id,
        crate::permissions::SEND_MESSAGES,
    )
    .await?;
    let user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    if (body.content.is_empty() && body.attachment_ids.is_empty()) || body.content.len() > 2000 {
        return Err(AppError::BadRequest(
            "messages.errors.validationFailed".to_string(),
        ));
    }
    let claimed = crate::attachments::claim(&state, &account.id, &body.attachment_ids).await?;

    let mut reference_id: Option<String> = None;
    let mut referenced_msg: Option<byteorm_client::Messages> = None;

    if let Some(ref_req) = body.message_reference.as_ref() {
        let target_id = ref_req.message_id.as_deref();
        let fail = ref_req.fail_if_not_exists;

        let target = match target_id {
            Some(id) => {
                state
                    .db
                    .messages
                    .find_first(|q| q.where_id(id.to_string()))
                    .await?
            }
            None => None,
        };

        match target {
            Some(msg) => {
                let channel_mismatch = msg.channel_id != channel_id
                    || ref_req
                        .channel_id
                        .as_deref()
                        .is_some_and(|c| c != msg.channel_id)
                    || ref_req
                        .guild_id
                        .as_deref()
                        .is_some_and(|g| g != msg.guild_id);

                if channel_mismatch {
                    if fail {
                        return Err(AppError::BadRequest(
                            "messages.errors.invalidReference".to_string(),
                        ));
                    }
                } else {
                    reference_id = Some(msg.id.clone());
                    referenced_msg = Some(msg);
                }
            }
            None => {
                if fail {
                    return Err(AppError::NotFound(
                        "messages.errors.referencedMessageNotFound".to_string(),
                    ));
                }
            }
        }
    }

    if channel.rate_limit_per_user > 0 {
        let standing = crate::permissions::standing(&state, &member.guild_id, &account.id).await?;
        let bypass = standing.can(crate::permissions::MANAGE_MESSAGES)
            || standing.can(crate::permissions::MANAGE_CHANNELS);

        if !bypass {
            let mut redis = state.redis.clone();
            let key = format!("channel:{}:msg", channel_id);
            let result = rate_limit(
                &mut redis,
                &account.id,
                1,
                (channel.rate_limit_per_user as i64) * 1000,
                &key,
            )
            .await?;
            if result.limited {
                return Err(AppError::TooManyRequests {
                    message: "messages.errors.rateLimited".to_string(),
                    retry_after: result.retry_after,
                });
            }
        }
    }

    let message_id = generate_snowflake();
    let nonce = body.nonce.clone().unwrap_or_else(|| "0".to_string());
    let msg_type = if reference_id.is_some() {
        MessageType::REPLY
    } else {
        MessageType::DEFAULT
    };
    let ref_id_for_create = reference_id.clone();

    let new_msg = state
        .db
        .messages
        .create(|c| {
            let builder = c
                .set_id(message_id.clone())
                .set_author_id(account.id.clone())
                .set_channel_id(channel_id.clone())
                .set_guild_id(member.guild_id.clone())
                .set_content(Some(body.content.clone()))
                .set_message_type(msg_type)
                .set_nonce(nonce.clone());
            match ref_id_for_create.clone() {
                Some(rid) => builder.set_reference_id(Some(rid)),
                None => builder,
            }
        })
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let mut response: Message = new_msg.into();
    response.author = Some(User::from(user));
    response.attachments = crate::attachments::bind(&state, claimed, &message_id).await?;

    if let Some(ref_msg) = referenced_msg {
        let ref_author = state
            .db
            .users
            .find_first(|q| q.where_id(ref_msg.author_id.clone()))
            .await?;
        let mut ref_response: Message = ref_msg.into();
        ref_response.author = ref_author.map(User::from);
        response.referenced_message = Some(Box::new(ref_response));
    }

    let broadcast_message = json!({
        "op": 0,
        "t": "MESSAGE_CREATE",
        "d": response
    });

    state.broadcast_to_room(&member.guild_id, broadcast_message.to_string());

    Ok(Json(response))
}

#[utoipa::path(
    patch,
    path = "/channels/{id}/messages/{message_id}",
    tag = "Messages",
    summary = "Edit a message",
    description = "Author only. Broadcasts MESSAGE_UPDATE.",
    params(("id" = String, Path, description = "Channel id"), ("message_id" = String, Path, description = "Message id")),
    request_body = MessageUpdateRequest,
    responses(
    (status = 200, description = "Updated message", body = crate::models::Message),
    (status = 400, description = "Invalid content", body = crate::openapi::ErrorBody),
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
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, AppError> {
    let body: MessageUpdateRequest = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("Invalid JSON".to_string()))?;
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;

    let message = state
        .db
        .messages
        .find_first(|q| q.where_id(message_id.clone()))
        .await?
        .ok_or(AppError::NotFound(
            "messages.errors.messageNotFound".to_string(),
        ))?;

    if message.channel_id != channel_id {
        return Err(AppError::NotFound(
            "messages.errors.messageNotFound".to_string(),
        ));
    }

    if message.author_id != account.id {
        return Err(AppError::Forbidden(
            "messages.errors.notYourMessage".to_string(),
        ));
    }

    if let Some(content) = &body.content {
        if content.is_empty() || content.len() > 2000 {
            return Err(AppError::BadRequest(
                "messages.errors.validationFailed".to_string(),
            ));
        }

        if message.content.as_ref() == Some(content) {
            let response: Message = message.into();
            return Ok(Json(response));
        }

        state
            .db
            .messages
            .update(|u| {
                u.set_content(Some(content.clone()))
                    .set_updated_at(Some(chrono::Utc::now()))
                    .where_id(message_id.clone())
            })
            .await?;
    }

    let updated = state
        .db
        .messages
        .find_first(|q| q.where_id(message_id))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to update message".to_string(),
        ))?;

    let author = state
        .db
        .users
        .find_first(|q| q.where_id(updated.author_id.clone()))
        .await?;

    let mut response: Message = updated.clone().into();
    response.author = author.map(User::from);
    crate::attachments::fill(&state, std::slice::from_mut(&mut response)).await?;

    let broadcast_message = json!({
        "op": 0,
        "t": "MESSAGE_UPDATE",
        "d": response
    });

    state.broadcast_to_room(&updated.guild_id, broadcast_message.to_string());

    Ok(Json(response))
}

#[utoipa::path(
    delete,
    path = "/channels/{id}/messages/{message_id}",
    tag = "Messages",
    summary = "Delete a message",
    description = "Broadcasts MESSAGE_DELETE.",
    params(("id" = String, Path, description = "Channel id"), ("message_id" = String, Path, description = "Message id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Not allowed", body = crate::openapi::ErrorBody),
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
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;

    let message = state
        .db
        .messages
        .find_first(|q| q.where_id(message_id.clone()))
        .await?
        .ok_or(AppError::NotFound(
            "messages.errors.messageNotFound".to_string(),
        ))?;

    if message.channel_id != channel_id {
        return Err(AppError::NotFound(
            "messages.errors.messageNotFound".to_string(),
        ));
    }

    if message.author_id != account.id {
        crate::permissions::require(
            &state,
            &message.guild_id,
            &account.id,
            crate::permissions::MANAGE_MESSAGES,
        )
        .await
        .map_err(|_| AppError::Forbidden("messages.errors.forbidden".to_string()))?;
    }

    state
        .db
        .messages
        .delete(|d| d.where_id(message_id.clone()))
        .await?;
    crate::attachments::remove_for_messages(&state, vec![message_id.clone()]).await;

    let broadcast_message = json!({
        "op": 0,
        "t": "MESSAGE_DELETE",
        "d": {
            "id": message.id,
            "channelId": message.channel_id,
            "guildId": message.guild_id
        }
    });

    state.broadcast_to_room(&message.guild_id, broadcast_message.to_string());

    if message.author_id != account.id {
        let author = audit::username(&state, &message.author_id).await;
        audit::record(
            &state,
            &message.guild_id,
            &account.id,
            "message.delete",
            Some(Target {
                kind: "message",
                id: &message.id,
                name: &author,
            }),
            Changes::new().value("channel", &channel.name),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/channels/{id}/typing",
    tag = "Messages",
    summary = "Signal that you are typing",
    description = "Broadcasts TYPING_START; the indicator expires after 10 seconds.",
    params(("id" = String, Path, description = "Channel id")),
    responses(
    (status = 200, description = "Sent", body = crate::openapi::SuccessBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn typing_start(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    let user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let broadcast_message = json!({
        "op": 0,
        "t": "TYPING_START",
        "d": {
            "channelId": channel_id,
            "userId": account.id,
            "user": {
                "id": user.id,
                "username": user.username,
                "tag": user.tag,
                "avatar": user.avatar,
                "member": {
                    "nickname": member.nickname
                }
            },
            "timestamp": now,
            "expiresAt": now + 10000
        }
    });

    state.broadcast_to_room(&member.guild_id, broadcast_message.to_string());

    Ok(Json(json!({"success": true})))
}

#[utoipa::path(
    post,
    path = "/channels/{id}/invites",
    tag = "Invites",
    summary = "Create an invite link",
    params(("id" = String, Path, description = "Channel id")),
    request_body = InviteCreateRequest,
    responses(
    (status = 200, description = "Created invite", body = crate::models::Invite),
    (status = 404, description = "Channel not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_invite(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, AppError> {
    let body: InviteCreateRequest = serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("Invalid JSON".to_string()))?;
    let account = get_current_user(&state, &jar).await?;
    let (_channel, member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    crate::permissions::require(
        &state,
        &member.guild_id,
        &account.id,
        crate::permissions::CREATE_INVITE,
    )
    .await?;

    let code = generate_code();
    let invite_id = generate_snowflake();
    let max_uses = body.max_uses.unwrap_or(0);

    state
        .db
        .guild_invites
        .create(|c| {
            c.set_id(invite_id.clone())
                .set_guild_id(member.guild_id.clone())
                .set_code(code.clone())
                .set_uses(0)
                .set_max_uses(max_uses)
                .set_creator_id(account.id.clone())
                .set_channel_id(channel_id.clone())
                .set_vanity(false)
        })
        .await?;

    let invite = state
        .db
        .guild_invites
        .find_first(|q| q.where_id(invite_id))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to create invite".to_string(),
        ))?;

    audit::record(
        &state,
        &member.guild_id,
        &account.id,
        "invite.create",
        Some(Target {
            kind: "invite",
            id: &invite.id,
            name: &invite.code,
        }),
        Changes::new().value("maxUses", &invite.max_uses),
    )
    .await;

    Ok(Json(Invite {
        id: invite.id,
        guild_id: invite.guild_id,
        code: invite.code,
        uses: invite.uses,
        max_uses: invite.max_uses,
        creator_id: Some(invite.creator_id),
        channel_id: invite.channel_id,
        vanity: invite.vanity,
    }))
}

async fn owned_channel(
    state: &SharedState,
    account_id: &str,
    channel_id: &str,
) -> Result<byteorm_client::Channels, AppError> {
    let channel = state
        .db
        .channels
        .find_first(|q| q.where_id(channel_id.to_string()))
        .await?
        .ok_or(AppError::NotFound("channels.notFound".to_string()))?;
    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(channel.guild_id.clone()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;
    let _ = guild;
    crate::permissions::require(
        state,
        &channel.guild_id,
        account_id,
        crate::permissions::MANAGE_CHANNELS,
    )
    .await?;
    Ok(channel)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannelRequest {
    name: Option<String>,
    /// Slowmode in seconds, 0 to 21600. Ignored for voice channels.
    rate_limit_per_user: Option<i32>,
}

#[utoipa::path(
    patch,
    path = "/channels/{id}",
    tag = "Guilds",
    summary = "Edit a channel",
    description = "Needs MANAGE_CHANNELS. Broadcasts CHANNEL_UPDATE.",
    params(("id" = String, Path, description = "Channel id")),
    request_body = UpdateChannelRequest,
    responses(
    (status = 200, description = "Updated channel", body = crate::models::Channel),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Channel not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_channel(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<UpdateChannelRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let channel = owned_channel(&state, &account.id, &channel_id).await?;

    let mut errors = Vec::new();
    let name = body.name.map(|n| n.trim().to_string());
    if let Some(name) = &name {
        if name.is_empty() {
            errors.push(FieldError {
                code: "modals.channelCreate.nameMinChars".to_string(),
                path: "name".to_string(),
            });
        }
        if name.chars().count() > 100 {
            errors.push(FieldError {
                code: "modals.channelCreate.nameMaxChars".to_string(),
                path: "name".to_string(),
            });
        }
    }
    let is_voice = channel.channel_type == byteorm_client::ChannelType::VOICE;
    let rate_limit = body.rate_limit_per_user.filter(|_| !is_voice);
    if let Some(r) = rate_limit {
        if !(0..=21600).contains(&r) {
            errors.push(FieldError {
                code: "modals.channelCreate.rateLimitRange".to_string(),
                path: "rate_limit_per_user".to_string(),
            });
        }
    }
    if !errors.is_empty() {
        return Err(AppError::ValidationFailed(errors));
    }

    let mut changes = Changes::new();
    if let Some(name) = &name {
        changes = changes.field("name", &channel.name, name);
    }
    if let Some(r) = &rate_limit {
        changes = changes.field("slowmode", &channel.rate_limit_per_user, r);
    }

    state
        .db
        .channels
        .update(|u| {
            let mut u = u.where_id(channel_id.clone());
            if let Some(name) = name {
                u = u.set_name(name);
            }
            if let Some(r) = rate_limit {
                u = u.set_rate_limit_per_user(r);
            }
            u
        })
        .await?;

    let updated: crate::models::Channel = state
        .db
        .channels
        .find_first(|q| q.where_id(channel_id.clone()))
        .await?
        .ok_or(AppError::NotFound("channels.notFound".to_string()))?
        .into();

    state.broadcast_to_room(
        &channel.guild_id,
        json!({ "op": 0, "t": "CHANNEL_UPDATE", "d": updated }).to_string(),
    );
    audit::record_update(
        &state,
        &channel.guild_id,
        &account.id,
        "channel.update",
        Some(Target {
            kind: "channel",
            id: &channel_id,
            name: &updated.name,
        }),
        changes,
    )
    .await;
    Ok(Json(updated))
}

#[utoipa::path(
    delete,
    path = "/channels/{id}",
    tag = "Guilds",
    summary = "Delete a channel",
    description = "Needs MANAGE_CHANNELS, and never the last channel. Its messages go with it. Broadcasts CHANNEL_DELETE.",
    params(("id" = String, Path, description = "Channel id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 400, description = "Last channel of the server (channels.errors.lastChannel)", body = crate::openapi::ErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Channel not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_channel(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let channel = owned_channel(&state, &account.id, &channel_id).await?;

    let siblings = state
        .db
        .channels
        .count(|q| q.where_guild_id(channel.guild_id.clone()))
        .await?;
    if siblings <= 1 {
        return Err(AppError::BadRequest(
            "channels.errors.lastChannel".to_string(),
        ));
    }

    state
        .db
        .channels
        .delete(|d| d.where_id(channel_id.clone()))
        .await?;

    state.broadcast_to_room(
        &channel.guild_id,
        json!({
            "op": 0,
            "t": "CHANNEL_DELETE",
            "d": { "id": channel_id, "guildId": channel.guild_id },
        })
        .to_string(),
    );
    audit::record(
        &state,
        &channel.guild_id,
        &account.id,
        "channel.delete",
        Some(Target {
            kind: "channel",
            id: &channel_id,
            name: &channel.name,
        }),
        Changes::new(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
