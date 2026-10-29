use crate::audit::{self, Changes, Target};
use axum::extract::{Multipart, Path};
use axum::{
    Json, Router,
    extract::State,
    response::IntoResponse,
    routing::{patch, post},
};
use axum_extra::extract::CookieJar;
use futures_util::TryFutureExt;
use serde::Deserialize;
use serde_json::json;

use crate::auth::token::verify_token;
use crate::error::{AppError, FieldError};
use crate::models::{Channel, Emoji, Guild, User};
use crate::state::SharedState;
use byteorm_client::ChannelType;
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CreateGuildRequest {
    name: String,
    brief: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct CreateGuildChannelRequest {
    name: String,
    rate_limit_per_user: Option<i32>,
    #[serde(rename = "type")]
    channel_type: Option<String>,
}

#[derive(serde::Serialize, utoipa::ToSchema)]
pub struct CreateGuildResponse {
    guild: Guild,
    channels: Vec<Channel>,
    users: Vec<User>,
}

pub(crate) fn generate_snowflake() -> String {
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

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/", post(create_guild))
        .route("/{id}", patch(update_guild).delete(delete_guild))
        .route("/{id}/channels", post(create_guild_channel))
        .route("/{id}/emojis", post(create_emoji))
        .route(
            "/{id}/emojis/{emoji_id}",
            patch(update_emoji).delete(delete_emoji),
        )
        .merge(super::roles::router())
        .merge(super::audit::router())
}

pub(crate) async fn get_current_user(
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

#[utoipa::path(
    post,
    path = "/guilds",
    tag = "Guilds",
    summary = "Create a server",
    request_body = CreateGuildRequest,
    responses(
    (status = 200, description = "Created server with its first channel and owner", body = CreateGuildResponse),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Server limit reached", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_guild(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<CreateGuildRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    let mut errors = Vec::new();

    if body.name.len() < 2 {
        errors.push(FieldError {
            code: "modals.serverCreate.nameMinChars".to_string(),
            path: "name".to_string(),
        });
    }
    if body.name.len() > 64 {
        errors.push(FieldError {
            code: "modals.serverCreate.nameMaxChars".to_string(),
            path: "name".to_string(),
        });
    }

    if let Some(brief) = &body.brief {
        if brief.len() < 2 {
            errors.push(FieldError {
                code: "modals.serverCreate.briefMinChars".to_string(),
                path: "brief".to_string(),
            });
        }
        if brief.len() > 36 {
            errors.push(FieldError {
                code: "modals.serverCreate.briefMaxChars".to_string(),
                path: "brief".to_string(),
            });
        }
    }

    if !errors.is_empty() {
        return Err(AppError::ValidationFailed(errors));
    }

    let member_count = state
        .db
        .guild_members
        .count(|q| q.where_user_id(account.id.clone()))
        .await?;

    if member_count >= state.config.user_guild_limit as i64 {
        return Err(AppError::Forbidden(
            "app.modals.serverCreate.serverLimitExceeded".to_string(),
        ));
    }

    let guild_id = generate_snowflake();
    let channel_id = generate_snowflake();

    state
        .db
        .guilds
        .create(|c| {
            c.set_id(guild_id.clone())
                .set_name(body.name)
                .set_brief(body.brief)
                .set_owner_id(account.id.clone())
        })
        .await?;

    state
        .db
        .guild_members
        .create(|c| {
            c.set_guild_id(guild_id.clone())
                .set_user_id(account.id.clone())
        })
        .await?;
    crate::permissions::init_guild(&state, &guild_id).await?;

    state
        .db
        .channels
        .create(|c| {
            c.set_id(channel_id.clone())
                .set_guild_id(guild_id.clone())
                .set_name("General".to_string())
                .set_rate_limit_per_user(0)
                .set_channel_type(ChannelType::TEXT)
        })
        .await?;

    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.clone()))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to create guild".to_string(),
        ))?;

    let channel = state
        .db
        .channels
        .find_first(|q| q.where_id(channel_id))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to create channel".to_string(),
        ))?;

    let owner = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::InternalServerError(
            "Owner user not found".to_string(),
        ))?;

    let mut guild: Guild = guild.into();
    guild.roles = Some(crate::permissions::load_roles(&state, &guild_id).await?);

    Ok(Json(CreateGuildResponse {
        guild,
        channels: vec![channel.into()],
        users: vec![User::from(owner)],
    }))
}

#[utoipa::path(
    post,
    path = "/guilds/{id}/channels",
    tag = "Guilds",
    summary = "Create a channel",
    description = "Needs MANAGE_CHANNELS. Broadcasts CHANNEL_CREATE.",
    params(("id" = String, Path, description = "Guild id")),
    request_body = CreateGuildChannelRequest,
    responses(
    (status = 200, description = "Created channel", body = crate::models::Channel),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Guild not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_guild_channel(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Json(body): Json<CreateGuildChannelRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.clone()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;

    let _ = guild;
    crate::permissions::require(
        &state,
        &guild_id,
        &account.id,
        crate::permissions::MANAGE_CHANNELS,
    )
    .await?;

    let mut errors = Vec::new();

    let name = body.name.trim().to_string();
    if name.len() < 1 {
        errors.push(FieldError {
            code: "modals.channelCreate.nameMinChars".to_string(),
            path: "name".to_string(),
        });
    }
    if name.len() > 100 {
        errors.push(FieldError {
            code: "modals.channelCreate.nameMaxChars".to_string(),
            path: "name".to_string(),
        });
    }

    let channel_type = parse_channel_type(body.channel_type.as_deref())?;

    let rate_limit = if channel_type == ChannelType::VOICE {
        0
    } else {
        let rate_limit = body.rate_limit_per_user.unwrap_or(0);
        if !(0..=21600).contains(&rate_limit) {
            errors.push(FieldError {
                code: "modals.channelCreate.rateLimitRange".to_string(),
                path: "rate_limit_per_user".to_string(),
            });
        }
        rate_limit
    };

    if !errors.is_empty() {
        return Err(AppError::ValidationFailed(errors));
    }

    let channel_id = generate_snowflake();

    let channel = state
        .db
        .channels
        .create(|c| {
            c.set_id(channel_id.clone())
                .set_guild_id(guild_id.clone())
                .set_name(name)
                .set_rate_limit_per_user(rate_limit)
                .set_channel_type(channel_type)
        })
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let response: Channel = channel.into();

    let broadcast = json!({
        "op": 0,
        "t": "CHANNEL_CREATE",
        "d": response,
    });
    state.broadcast_to_room(&guild_id, broadcast.to_string());
    audit::record(
        &state,
        &guild_id,
        &account.id,
        "channel.create",
        Some(Target {
            kind: "channel",
            id: &response.id,
            name: &response.name,
        }),
        Changes::new().value("name", &response.name),
    )
    .await;

    Ok(Json(response))
}

fn parse_channel_type(value: Option<&str>) -> Result<ChannelType, AppError> {
    match value.unwrap_or("TEXT").to_ascii_uppercase().as_str() {
        "TEXT" => Ok(ChannelType::TEXT),
        "VOICE" => Ok(ChannelType::VOICE),
        _ => Err(AppError::BadRequest(
            "channels.errors.invalidType".to_string(),
        )),
    }
}

async fn managed_guild(
    state: &SharedState,
    account_id: &str,
    guild_id: &str,
    perm: i32,
) -> Result<byteorm_client::Guilds, AppError> {
    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.to_string()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;
    crate::permissions::require(state, guild_id, account_id, perm).await?;
    Ok(guild)
}

async fn owned_guild(
    state: &SharedState,
    account_id: &str,
    guild_id: &str,
) -> Result<byteorm_client::Guilds, AppError> {
    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.to_string()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;
    if guild.owner_id != account_id {
        return Err(AppError::Forbidden("servers.notOwner".to_string()));
    }
    Ok(guild)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UpdateGuildRequest {
    name: Option<String>,
    /// `null` clears the description.
    #[serde(default, deserialize_with = "double_option")]
    #[schema(value_type = Option<String>)]
    brief: Option<Option<String>>,
}

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[utoipa::path(
    patch,
    path = "/guilds/{id}",
    tag = "Guilds",
    summary = "Edit a server",
    description = "Needs MANAGE_GUILD. Broadcasts GUILD_UPDATE.",
    params(("id" = String, Path, description = "Guild id")),
    request_body = UpdateGuildRequest,
    responses(
    (status = 200, description = "Updated server", body = Guild),
    (status = 400, description = "Validation failed", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Guild not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_guild(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Json(body): Json<UpdateGuildRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    managed_guild(
        &state,
        &account.id,
        &guild_id,
        crate::permissions::MANAGE_GUILD,
    )
    .await?;

    let mut errors = Vec::new();
    let name = body.name.as_ref().map(|n| n.trim().to_string());
    if let Some(name) = &name {
        if name.chars().count() < 2 {
            errors.push(FieldError {
                code: "modals.serverCreate.nameMinChars".to_string(),
                path: "name".to_string(),
            });
        }
        if name.chars().count() > 64 {
            errors.push(FieldError {
                code: "modals.serverCreate.nameMaxChars".to_string(),
                path: "name".to_string(),
            });
        }
    }
    let brief = body
        .brief
        .map(|b| b.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()));
    if let Some(Some(brief)) = &brief {
        if brief.chars().count() < 2 {
            errors.push(FieldError {
                code: "modals.serverCreate.briefMinChars".to_string(),
                path: "brief".to_string(),
            });
        }
        if brief.chars().count() > 36 {
            errors.push(FieldError {
                code: "modals.serverCreate.briefMaxChars".to_string(),
                path: "brief".to_string(),
            });
        }
    }
    if !errors.is_empty() {
        return Err(AppError::ValidationFailed(errors));
    }

    let before = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.clone()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;
    let mut changes = Changes::new();
    if let Some(name) = &name {
        changes = changes.field("name", &before.name, name);
    }
    if let Some(brief) = &brief {
        changes = changes.field("description", &before.brief, brief);
    }

    state
        .db
        .guilds
        .update(|u| {
            let mut u = u.where_id(guild_id.clone());
            if let Some(name) = name {
                u = u.set_name(name);
            }
            if let Some(brief) = brief {
                u = u.set_brief(brief);
            }
            u
        })
        .await?;

    let guild: Guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.clone()))
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?
        .into();

    state.broadcast_to_room(
        &guild_id,
        json!({ "op": 0, "t": "GUILD_UPDATE", "d": guild }).to_string(),
    );
    audit::record_update(
        &state,
        &guild_id,
        &account.id,
        "guild.update",
        Some(Target {
            kind: "guild",
            id: &guild_id,
            name: &guild.name,
        }),
        changes,
    )
    .await;
    Ok(Json(guild))
}

#[utoipa::path(
    delete,
    path = "/guilds/{id}",
    tag = "Guilds",
    summary = "Delete a server",
    description = "Owner only. Removes its channels, messages and emoji for good. Broadcasts GUILD_DELETE.",
    params(("id" = String, Path, description = "Guild id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Guild not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_guild(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    owned_guild(&state, &account.id, &guild_id).await?;

    let emojis = state
        .db
        .guild_emojis
        .find_many(|q| q.where_guild_id(guild_id.clone()))
        .await?;

    state
        .db
        .guilds
        .delete(|d| d.where_id(guild_id.clone()))
        .await?;

    for e in emojis {
        remove_emoji_file(&e.id, &e.extension).await;
    }

    state.broadcast_to_room(
        &guild_id,
        json!({ "op": 0, "t": "GUILD_DELETE", "d": { "id": guild_id } }).to_string(),
    );
    Ok(axum::http::StatusCode::NO_CONTENT)
}

const MAX_EMOJIS_PER_GUILD: i64 = 50;
const MAX_EMOJI_BYTES: usize = 256 * 1024;
const MAX_EMOJI_PIXELS: i32 = 1024;

/// All custom emoji of a guild, oldest first.
pub(crate) async fn load_emojis(
    state: &SharedState,
    guild_id: &str,
) -> Result<Vec<Emoji>, AppError> {
    Ok(state
        .db
        .guild_emojis
        .find_many(|q| {
            q.where_guild_id(guild_id.to_string())
                .order_by_created_at_asc()
        })
        .await?
        .into_iter()
        .map(Emoji::from)
        .collect())
}

async fn broadcast_emojis(state: &SharedState, guild_id: &str) -> Result<(), AppError> {
    let emojis = load_emojis(state, guild_id).await?;
    state.broadcast_to_room(
        guild_id,
        json!({
            "op": 0,
            "t": "GUILD_EMOJIS_UPDATE",
            "d": { "guildId": guild_id, "emojis": emojis },
        })
        .to_string(),
    );
    Ok(())
}

async fn remove_emoji_file(id: &str, extension: &str) {
    let _ = tokio::fs::remove_file(format!("./cdn/emojis/{id}.{extension}")).await;
}

/// Letters, digits and underscores, so `:name:` is unambiguous in text.
fn valid_emoji_name(name: &str) -> bool {
    (2..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

async fn name_taken(
    state: &SharedState,
    guild_id: &str,
    name: &str,
    except: Option<&str>,
) -> Result<bool, AppError> {
    let lower = name.to_ascii_lowercase();
    Ok(load_emojis(state, guild_id)
        .await?
        .iter()
        .any(|e| e.name.to_ascii_lowercase() == lower && Some(e.id.as_str()) != except))
}

#[utoipa::path(
    post,
    path = "/guilds/{id}/emojis",
    tag = "Guilds",
    summary = "Add a custom emoji",
    description = "Needs MANAGE_EMOJIS. Multipart with a `name` field (2-32 letters, digits or underscores, unique in the server) and an image `file` (PNG, JPEG, GIF or WebP, up to 256 KB and 1024 px). At most 50 per server. Broadcasts GUILD_EMOJIS_UPDATE.",
    params(("id" = String, Path, description = "Guild id")),
    request_body(content = crate::openapi::ImageUpload, content_type = "multipart/form-data"),
    responses(
    (status = 200, description = "Created emoji", body = Emoji),
    (status = 400, description = "Invalid name or image (emoji.errors.*)", body = crate::openapi::ErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Guild not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_emoji(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    managed_guild(
        &state,
        &account.id,
        &guild_id,
        crate::permissions::MANAGE_EMOJIS,
    )
    .await?;

    let mut name = None;
    let mut bytes = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        match field.name() {
            Some("name") => {
                name = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| AppError::BadRequest(e.to_string()))?,
                );
            }
            Some("file") | Some("image") => {
                let data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?;
                if data.len() > MAX_EMOJI_BYTES {
                    return Err(AppError::BadRequest("emoji.errors.tooLarge".to_string()));
                }
                bytes = Some(data.to_vec());
            }
            _ => {}
        }
    }
    let name = name.unwrap_or_default().trim().to_string();
    if !valid_emoji_name(&name) {
        return Err(AppError::BadRequest("emoji.errors.badName".to_string()));
    }
    let bytes = bytes
        .filter(|b| !b.is_empty())
        .ok_or_else(|| AppError::BadRequest("emoji.errors.missing".to_string()))?;

    let sniffed = tokio::task::spawn_blocking(move || {
        let s = crate::attachments::sniff(&bytes);
        (s.content_type, s.width, s.height, bytes)
    })
    .await
    .map_err(|e| AppError::InternalServerError(e.to_string()))?;
    let (content_type, width, height, bytes) = sniffed;
    let extension = match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => return Err(AppError::BadRequest("emoji.errors.badImage".to_string())),
    };
    if width.unwrap_or(0) > MAX_EMOJI_PIXELS || height.unwrap_or(0) > MAX_EMOJI_PIXELS {
        return Err(AppError::BadRequest("emoji.errors.tooBig".to_string()));
    }

    let count = state
        .db
        .guild_emojis
        .count(|q| q.where_guild_id(guild_id.clone()))
        .await?;
    if count >= MAX_EMOJIS_PER_GUILD {
        return Err(AppError::BadRequest("emoji.errors.limit".to_string()));
    }
    if name_taken(&state, &guild_id, &name, None).await? {
        return Err(AppError::BadRequest("emoji.errors.nameTaken".to_string()));
    }

    let id = generate_snowflake();
    tokio::fs::create_dir_all("./cdn/emojis")
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;
    tokio::fs::write(format!("./cdn/emojis/{id}.{extension}"), &bytes)
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let row = state
        .db
        .guild_emojis
        .create(|c| {
            c.set_id(id.clone())
                .set_guild_id(guild_id.clone())
                .set_name(name)
                .set_creator_id(account.id.clone())
                .set_extension(extension.to_string())
                .set_animated(extension == "gif")
        })
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    broadcast_emojis(&state, &guild_id).await?;
    audit::record(
        &state,
        &guild_id,
        &account.id,
        "emoji.create",
        Some(Target {
            kind: "emoji",
            id: &row.id,
            name: &row.name,
        }),
        Changes::new(),
    )
    .await;
    Ok(Json(Emoji::from(row)))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UpdateEmojiRequest {
    name: String,
}

#[utoipa::path(
    patch,
    path = "/guilds/{id}/emojis/{emoji_id}",
    tag = "Guilds",
    summary = "Rename a custom emoji",
    description = "Needs MANAGE_EMOJIS. Broadcasts GUILD_EMOJIS_UPDATE.",
    params(
        ("id" = String, Path, description = "Guild id"),
        ("emoji_id" = String, Path, description = "Emoji id"),
    ),
    request_body = UpdateEmojiRequest,
    responses(
    (status = 200, description = "Updated emoji", body = Emoji),
    (status = 400, description = "Invalid name (emoji.errors.*)", body = crate::openapi::ErrorBody),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_emoji(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, emoji_id)): Path<(String, String)>,
    Json(body): Json<UpdateEmojiRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    managed_guild(
        &state,
        &account.id,
        &guild_id,
        crate::permissions::MANAGE_EMOJIS,
    )
    .await?;

    let name = body.name.trim().to_string();
    if !valid_emoji_name(&name) {
        return Err(AppError::BadRequest("emoji.errors.badName".to_string()));
    }
    let existing = state
        .db
        .guild_emojis
        .find_first(|q| {
            q.where_id(emoji_id.clone())
                .where_guild_id(guild_id.clone())
        })
        .await?
        .ok_or(AppError::NotFound("emoji.errors.notFound".to_string()))?;
    if name_taken(&state, &guild_id, &name, Some(&existing.id)).await? {
        return Err(AppError::BadRequest("emoji.errors.nameTaken".to_string()));
    }

    state
        .db
        .guild_emojis
        .update(|u| u.where_id(emoji_id.clone()).set_name(name.clone()))
        .await?;

    broadcast_emojis(&state, &guild_id).await?;
    audit::record_update(
        &state,
        &guild_id,
        &account.id,
        "emoji.update",
        Some(Target {
            kind: "emoji",
            id: &existing.id,
            name: &name,
        }),
        Changes::new().field("name", &existing.name, &name),
    )
    .await;
    Ok(Json(Emoji::from(byteorm_client::GuildEmojis {
        name,
        ..existing
    })))
}

#[utoipa::path(
    delete,
    path = "/guilds/{id}/emojis/{emoji_id}",
    tag = "Guilds",
    summary = "Delete a custom emoji",
    description = "Needs MANAGE_EMOJIS. Messages that used it show `:name:` instead. Broadcasts GUILD_EMOJIS_UPDATE.",
    params(
        ("id" = String, Path, description = "Guild id"),
        ("emoji_id" = String, Path, description = "Emoji id"),
    ),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 404, description = "Not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_emoji(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, emoji_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    managed_guild(
        &state,
        &account.id,
        &guild_id,
        crate::permissions::MANAGE_EMOJIS,
    )
    .await?;

    let existing = state
        .db
        .guild_emojis
        .find_first(|q| {
            q.where_id(emoji_id.clone())
                .where_guild_id(guild_id.clone())
        })
        .await?
        .ok_or(AppError::NotFound("emoji.errors.notFound".to_string()))?;
    state
        .db
        .guild_emojis
        .delete(|d| d.where_id(emoji_id.clone()))
        .await?;
    remove_emoji_file(&existing.id, &existing.extension).await;

    broadcast_emojis(&state, &guild_id).await?;
    audit::record(
        &state,
        &guild_id,
        &account.id,
        "emoji.delete",
        Some(Target {
            kind: "emoji",
            id: &existing.id,
            name: &existing.name,
        }),
        Changes::new(),
    )
    .await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::valid_emoji_name;

    #[test]
    fn emoji_names_are_plain_words() {
        assert!(valid_emoji_name("party_parrot"));
        assert!(valid_emoji_name("a1"));
        assert!(!valid_emoji_name("x"));
        assert!(!valid_emoji_name("has space"));
        assert!(!valid_emoji_name("emoji:colon"));
        assert!(!valid_emoji_name("zażółć"));
        assert!(!valid_emoji_name(&"a".repeat(33)));
    }
}
