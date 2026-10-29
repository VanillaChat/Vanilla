use axum::{
    Json, Router,
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, patch, post, put},
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;
use std::{io::Cursor, path::PathBuf};

use byteorm_client::{DmPrivacy, Theme};

use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::models::User;
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/@me", patch(update_user))
        .route("/@me/avatar", post(upload_avatar))
        .route("/@me/banner", post(upload_banner))
        .route("/@me/user-settings", patch(update_settings))
        .route("/@me/custom-status", put(set_custom_status))
        .route("/@me/read-pings", post(read_pings))
        .route("/@me/guilds/{guild_id}", delete(leave_guild))
        .route("/@me/request-deletion", post(request_deletion))
        .route("/@me/cancel-deletion", post(cancel_deletion))
}

#[derive(Clone, Copy)]
enum UserImageKind {
    Avatar,
    Banner,
}

impl UserImageKind {
    fn field_name(self) -> &'static str {
        match self {
            Self::Avatar => "avatar",
            Self::Banner => "banner",
        }
    }

    fn directory(self) -> &'static str {
        match self {
            Self::Avatar => "avatars",
            Self::Banner => "banners",
        }
    }

    fn max_size(self, state: &SharedState) -> usize {
        match self {
            Self::Avatar => state.config.max_avatar_size,
            Self::Banner => state.config.max_banner_size,
        }
    }
}

fn generate_snowflake() -> String {
    use rand::Rng;
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let epoch = 1420070400000u64;
    let timestamp = now - epoch;
    let random: u64 = rand::thread_rng().gen_range(0..4096);

    ((timestamp << 22) | random).to_string()
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

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct UpdateUserRequest {
    username: Option<String>,
    tag: Option<String>,
    bio: Option<String>,
    #[schema(value_type = Option<String>, nullable)]
    avatar: Option<Option<String>>,
    #[schema(value_type = Option<String>, nullable)]
    banner: Option<Option<String>>,
    password: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/users/@me",
    tag = "Users",
    summary = "Update your profile",
    description = "Broadcasts USER_UPDATE to your servers.",
    request_body = UpdateUserRequest,
    responses(
    (status = 200, description = "Updated user", body = crate::models::User),
    (status = 400, description = "Invalid change", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_user(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<UpdateUserRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    let current_user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    if body.username.is_none()
        && body.tag.is_none()
        && body.bio.is_none()
        && body.avatar.is_none()
        && body.banner.is_none()
    {
        return Err(AppError::BadRequest(
            "At least one field is required".to_string(),
        ));
    }

    let old_avatar = current_user.avatar.clone();
    let old_banner = current_user.banner.clone();

    let mut update_builder = state.db.users.update(|u| {
        let mut u = u.where_id(account.id.clone());
        if let Some(username) = &body.username {
            u = u.set_username(username.clone());
        }
        if let Some(tag) = &body.tag {
            u = u.set_tag(tag.clone());
        }
        if let Some(bio) = &body.bio {
            u = u.set_bio(Some(bio.clone()));
        }
        if let Some(avatar) = &body.avatar {
            u = u.set_avatar(avatar.clone());
        }
        if let Some(banner) = &body.banner {
            u = u.set_banner(banner.clone());
        }
        u
    });
    update_builder.await?;

    if matches!(body.avatar, Some(None)) {
        remove_user_image(UserImageKind::Avatar, &account.id, old_avatar).await;
    }

    if matches!(body.banner, Some(None)) {
        remove_user_image(UserImageKind::Banner, &account.id, old_banner).await;
    }

    let updated_user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to update user".to_string(),
        ))?;

    let user_response: User = updated_user.into();
    broadcast_user_update(&state, &account.id, &user_response).await?;

    Ok(Json(user_response))
}

#[utoipa::path(
    post,
    path = "/users/@me/avatar",
    tag = "Users",
    summary = "Upload an avatar",
    request_body(content = crate::openapi::ImageUpload, content_type = "multipart/form-data"),
    responses(
    (status = 200, description = "Updated user", body = crate::models::User),
    (status = 400, description = "Invalid image", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn upload_avatar(
    State(state): State<SharedState>,
    jar: CookieJar,
    multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    upload_user_image(state, jar, multipart, UserImageKind::Avatar).await
}

#[utoipa::path(
    post,
    path = "/users/@me/banner",
    tag = "Users",
    summary = "Upload a profile banner",
    request_body(content = crate::openapi::ImageUpload, content_type = "multipart/form-data"),
    responses(
    (status = 200, description = "Updated user", body = crate::models::User),
    (status = 400, description = "Invalid image", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn upload_banner(
    State(state): State<SharedState>,
    jar: CookieJar,
    multipart: Multipart,
) -> Result<impl IntoResponse, AppError> {
    upload_user_image(state, jar, multipart, UserImageKind::Banner).await
}

async fn upload_user_image(
    state: SharedState,
    jar: CookieJar,
    mut multipart: Multipart,
    kind: UserImageKind,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    let current_user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?;

    let mut image_bytes = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(e.to_string()))?
    {
        let field_name = field.name().unwrap_or_default();
        if field_name != "image" && field_name != "file" {
            continue;
        }

        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(e.to_string()))?;
        image_bytes = Some(bytes.to_vec());
        break;
    }

    let image_bytes = image_bytes.ok_or(AppError::BadRequest(format!(
        "Missing {} file",
        kind.field_name()
    )))?;

    if image_bytes.len() > kind.max_size(&state) {
        return Err(AppError::BadRequest(format!(
            "{} is too large",
            kind.field_name()
        )));
    }

    let converted = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let image = image::load_from_memory(&image_bytes).map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        image
            .write_to(&mut Cursor::new(&mut output), image::ImageFormat::WebP)
            .map_err(|e| e.to_string())?;
        Ok(output)
    })
    .await
    .map_err(|e| AppError::InternalServerError(e.to_string()))?
    .map_err(AppError::BadRequest)?;

    let image_id = generate_snowflake();
    let image_dir = PathBuf::from("./cdn")
        .join(kind.directory())
        .join(&account.id);
    tokio::fs::create_dir_all(&image_dir)
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let image_path = image_dir.join(format!("{image_id}.webp"));
    tokio::fs::write(&image_path, converted)
        .await
        .map_err(|e| AppError::InternalServerError(e.to_string()))?;

    let old_image = match kind {
        UserImageKind::Avatar => current_user.avatar,
        UserImageKind::Banner => current_user.banner,
    };

    let mut update = state.db.users.update(|u| {
        let mut u = u.where_id(account.id.clone());
        match kind {
            UserImageKind::Avatar => {
                u = u.set_avatar(Some(image_id.clone()));
            }
            UserImageKind::Banner => {
                u = u.set_banner(Some(image_id.clone()));
            }
        }
        u
    });
    update.await?;

    remove_user_image(kind, &account.id, old_image).await;

    let updated_user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?
        .ok_or(AppError::InternalServerError(
            "Failed to update user".to_string(),
        ))?;

    let user = User::from(updated_user);
    broadcast_user_update(&state, &account.id, &user).await?;
    Ok(Json(user))
}

async fn broadcast_user_update(
    state: &SharedState,
    user_id: &str,
    user: &User,
) -> Result<(), AppError> {
    let members = state
        .db
        .guild_members
        .find_many(|q| q.where_user_id(user_id.to_string()))
        .await?;
    for member in members {
        let broadcast = json!({
            "op": 0,
            "t": "USER_UPDATE",
            "d": { "guildId": member.guild_id, "user": user }
        });
        state.broadcast_to_room(&member.guild_id, broadcast.to_string());
    }
    Ok(())
}

async fn remove_user_image(kind: UserImageKind, user_id: &str, image_id: Option<String>) {
    let Some(image_id) = image_id else {
        return;
    };

    if image_id.starts_with("data:")
        || image_id.starts_with("http://")
        || image_id.starts_with("https://")
        || image_id.starts_with("blob:")
    {
        return;
    }

    let image_path = PathBuf::from("./cdn")
        .join(kind.directory())
        .join(user_id)
        .join(format!("{image_id}.webp"));
    let _ = tokio::fs::remove_file(image_path).await;
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsRequest {
    theme: Option<String>,
    compact_mode: Option<bool>,
    compact_show_avatars: Option<bool>,
    dm_privacy: Option<String>,
}

#[utoipa::path(
    patch,
    path = "/users/@me/user-settings",
    tag = "Users",
    summary = "Update your settings",
    description = "At least one field is required. `dmPrivacy` is EVERYONE, SHARED_SERVERS or FRIENDS.",
    request_body = UpdateSettingsRequest,
    responses(
    (status = 204, description = "Saved"),
    (status = 400, description = "Invalid settings", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_settings(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<UpdateSettingsRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    if body.theme.is_none()
        && body.compact_mode.is_none()
        && body.compact_show_avatars.is_none()
        && body.dm_privacy.is_none()
    {
        return Err(AppError::BadRequest(
            "At least one field is required".to_string(),
        ));
    }

    let theme = body
        .theme
        .as_deref()
        .map(str::parse::<Theme>)
        .transpose()
        .map_err(AppError::BadRequest)?;

    let dm_privacy = body
        .dm_privacy
        .as_deref()
        .map(str::parse::<DmPrivacy>)
        .transpose()
        .map_err(AppError::BadRequest)?;

    let mut update_needed = false;
    let update_future = state.db.account_settings.update(|u| {
        let mut u = u.where_account_id(account.id.clone());

        if let Some(theme) = theme {
            u = u.set_theme(theme);
            update_needed = true;
        }

        if let Some(compact_mode) = body.compact_mode {
            u = u.set_compact_mode(compact_mode);
            update_needed = true;
        }

        if let Some(compact_show_avatars) = body.compact_show_avatars {
            u = u.set_compact_show_avatars(compact_show_avatars);
            update_needed = true;
        }

        if let Some(dm_privacy) = dm_privacy {
            u = u.set_dm_privacy(dm_privacy);
            update_needed = true;
        }
        u
    });

    if update_needed {
        update_future
            .await
            .map_err(|e| AppError::InternalServerError(e.to_string()))?;
    }

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/users/@me/guilds/{guild_id}",
    tag = "Users",
    summary = "Leave a server",
    description = "Broadcasts GUILD_MEMBER_REMOVE.",
    params(("guild_id" = String, Path, description = "Guild id")),
    responses(
    (status = 204, description = "Left"),
    (status = 403, description = "Owners cannot leave", body = crate::openapi::ErrorBody),
    (status = 404, description = "Guild not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn leave_guild(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    state
        .db
        .guild_members
        .find_first(|q| {
            q.where_user_id(account.id.clone())
                .where_guild_id(guild_id.clone())
        })
        .await?
        .ok_or(AppError::NotFound(
            "You are not a member of this guild.".to_string(),
        ))?;

    let guild = state
        .db
        .guilds
        .find_first(|q| q.where_id(guild_id.clone()))
        .await?
        .ok_or(AppError::NotFound("Guild not found".to_string()))?;

    if guild.owner_id == account.id {
        return Err(AppError::Forbidden(
            "You can't leave the server as its owner. Please transfer ownership or delete the server first.".to_string()
        ));
    }

    let user = state
        .db
        .users
        .find_first(|q| q.where_id(account.id.clone()))
        .await?;

    crate::permissions::remove_member(&state, &guild_id, &account.id).await?;

    if let Some(user) = user {
        let broadcast = json!({
            "op": 0,
            "t": "GUILD_MEMBER_REMOVE",
            "d": {
                "guildId": guild_id,
                "user": User::from(user)
            }
        });
        state.broadcast_to_room(&guild_id, broadcast.to_string());
    }

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestDeletionRequest {
    password: String,
    delete_messages: bool,
}

#[utoipa::path(
    post,
    path = "/users/@me/request-deletion",
    tag = "Users",
    summary = "Schedule account deletion",
    request_body = RequestDeletionRequest,
    responses(
    (status = 200, description = "Scheduled", body = crate::openapi::DeletionResponse),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn request_deletion(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<RequestDeletionRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    use argon2::{Argon2, PasswordHash, PasswordVerifier};

    let parsed_hash = PasswordHash::new(&account.password)
        .map_err(|_| AppError::InternalServerError("Invalid password hash".to_string()))?;

    if Argon2::default()
        .verify_password(body.password.as_bytes(), &parsed_hash)
        .is_err()
    {
        return Err(AppError::Unauthorized);
    }

    let delete_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 7 * 24 * 60 * 60 * 1000;

    Ok(Json(json!({
        "deleteAt": delete_at
    })))
}

#[utoipa::path(
    post,
    path = "/users/@me/cancel-deletion",
    tag = "Users",
    summary = "Cancel scheduled deletion",
    responses(
    (status = 204, description = "Cancelled"),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn cancel_deletion(
    State(state): State<SharedState>,
    jar: CookieJar,
) -> Result<impl IntoResponse, AppError> {
    let _account = get_current_user(&state, &jar).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomStatusRequest {
    /// Up to 60 characters. Leave out both `text` and `emoji` to clear the status.
    text: Option<String>,
    /// One emoji, up to 8 characters and no spaces, or a custom one as `<:name:id>`.
    emoji: Option<String>,
    /// Milliseconds until the status clears itself (1 minute to 7 days). Omit to keep it.
    duration_ms: Option<i64>,
}

#[utoipa::path(
    put,
    path = "/users/@me/custom-status",
    tag = "Users",
    summary = "Set or clear your custom status",
    description = "Broadcasts USER_UPDATE. Sending neither `text` nor `emoji` clears it.",
    request_body = CustomStatusRequest,
    responses(
        (status = 200, description = "Updated user", body = crate::models::User),
        (status = 400, description = "Too long or invalid (status.errors.*)", body = crate::openapi::ErrorBody),
        (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
    ),
    security(("cookie" = [])),
)]
pub(crate) async fn set_custom_status(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<CustomStatusRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (text, emoji) = crate::status::clean_custom(body.text, body.emoji)?;
    let until = if text.is_some() || emoji.is_some() {
        crate::status::until_from(body.duration_ms, chrono::Utc::now())
    } else {
        None
    };

    state
        .db
        .users
        .update(|u| {
            u.where_id(account.user_id.clone())
                .set_custom_status(text.clone())
                .set_custom_emoji(emoji.clone())
                .set_custom_status_until(until)
        })
        .await?;

    let user: User = state
        .db
        .users
        .find_first(|q| q.where_id(account.user_id.clone()))
        .await?
        .ok_or(AppError::Unauthorized)?
        .into();
    crate::status::broadcast_user(&state, &user).await;
    Ok(Json(user))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadPingsRequest {
    /// Channels whose pings were read, at most 100. Omit to mark every ping read.
    channel_ids: Option<Vec<String>>,
}

#[utoipa::path(
    post,
    path = "/users/@me/read-pings",
    tag = "Users",
    summary = "Tell your other sessions that pings were read",
    description = "Pings are kept by each client; this relays PINGS_READ to all your connected sessions so they clear the same pings.",
    request_body = ReadPingsRequest,
    responses(
        (status = 204, description = "Relayed"),
        (status = 400, description = "Too many channels", body = crate::openapi::ErrorBody),
        (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
    ),
    security(("cookie" = [])),
)]
pub(crate) async fn read_pings(
    State(state): State<SharedState>,
    jar: CookieJar,
    Json(body): Json<ReadPingsRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    if body.channel_ids.as_ref().is_some_and(|c| c.len() > 100) {
        return Err(AppError::BadRequest("BAD_REQUEST".to_string()));
    }
    state.send_to_user(
        &account.user_id,
        json!({
            "op": 0,
            "t": "PINGS_READ",
            "d": { "channelIds": body.channel_ids },
        })
        .to_string(),
    );
    Ok(StatusCode::NO_CONTENT)
}
