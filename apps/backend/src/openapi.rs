//! OpenAPI description of the HTTP API.
//!
//! Handlers carry their own `#[utoipa::path]`; this module lists them, adds the
//! response shapes that handlers build by hand with `json!`, and serves the result at
//! `GET /openapi.json`. `vanilla-backend --print-openapi` prints the same document.

use axum::{Json, Router, routing::get};
use serde::Serialize;
use utoipa::{
    Modify, OpenApi, ToSchema,
    openapi::security::{ApiKey, ApiKeyValue, SecurityScheme},
};

use crate::models::{
    Account, AccountSettings, Channel, Emoji, Guild, GuildMember, Invite, InviteResponse, Message,
    Role, User,
};
use crate::routes::{
    admin, audit, auth, cdn, channels, dms, friends, guilds, invites, roles, search, unfurl, users,
    voice,
};
use crate::state::SharedState;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Vanilla API",
        description = "HTTP API of the Vanilla chat backend.\n\n\
            Authentication is a session cookie set by `/auth/login` and `/auth/register` \
            (`token`, or `__Host-Token` in production). Real-time events are delivered over the \
            WebSocket at `/gateway`; see `docs/gateway.md`.\n\n\
            Errors are JSON with a stable `code`. Validation failures list one `{code, path}` per field.",
        version = "0.1.0",
    ),
    paths(
        auth::login, auth::register, auth::session, auth::logout, auth::clear_db,
        guilds::create_guild, guilds::create_guild_channel, guilds::update_guild, guilds::delete_guild,
        guilds::create_emoji, guilds::update_emoji, guilds::delete_emoji,
        roles::list_roles, roles::create_role, roles::update_role, roles::delete_role, roles::reorder_roles,
        roles::add_member_role, roles::remove_member_role, roles::kick_member,
        channels::update_channel, channels::delete_channel,
        channels::get_messages, channels::create_message, channels::update_message, channels::delete_message,
        channels::typing_start, channels::create_invite,
        invites::get_invite, invites::use_invite,
        users::update_user, audit::list_audit_log, users::set_custom_status, users::read_pings, users::upload_avatar, users::upload_banner, users::update_settings,
        users::leave_guild, users::request_deletion, users::cancel_deletion,
        admin::gateway_metrics, admin::create_invite_code, admin::delete_invite_code, admin::grant_badge, admin::revoke_badge,
        cdn::serve_cdn,
        crate::routes::attachments::upload, crate::routes::attachments::download,
        dms::list_dms, dms::open_dm, dms::create_group, dms::add_members, dms::leave_group,
        dms::get_messages, dms::create_message, dms::update_message, dms::delete_message, dms::typing,
        friends::list, friends::send_request, friends::accept, friends::remove, friends::block, friends::unblock,
        search::search_guild, search::search_dms,
        unfurl::link_preview, unfurl::image,
        voice::get_voice_state, voice::join_voice, voice::leave_voice, voice::update_voice, voice::media_ws,
    ),
    components(schemas(
        User, crate::models::CustomStatus, Account, AccountSettings, crate::attachments::Attachment, Guild, GuildMember, Channel, Message, Invite, InviteResponse,
        ErrorBody, ValidationErrorBody, FieldErrorBody, RateLimitBody, SuccessBody,
        Emoji, Role, audit::AuditEntry, audit::AuditPage, roles::CreateRoleRequest, roles::UpdateRoleRequest, roles::ReorderRolesRequest, Relationship, RelationshipKind, DmChannel, SearchResponse, InviteUseResponse,
        AdminInviteCode, DeletionResponse, ImageUpload,
    )),
    modifiers(&CookieAuth),
    tags(
        (name = "Auth"), (name = "Users"), (name = "Guilds"), (name = "Roles"), (name = "Messages"), (name = "Invites"),
        (name = "Direct messages"), (name = "Friends"), (name = "Search"), (name = "Voice"),
        (name = "Media"), (name = "Attachments"), (name = "Admin"),
    ),
)]
pub struct ApiDoc;

struct CookieAuth;

impl Modify for CookieAuth {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                "token",
                "Session token. Named `__Host-Token` when the server runs in production.",
            ))),
        );
    }
}

pub fn router() -> Router<SharedState> {
    Router::new().route("/openapi.json", get(|| async { Json(ApiDoc::openapi()) }))
}

pub fn print() {
    println!("{}", ApiDoc::openapi().to_pretty_json().unwrap_or_default());
}

/// Error body of most failures.
#[derive(Serialize, ToSchema)]
pub struct ErrorBody {
    /// Stable machine-readable code such as `BAD_REQUEST`, `FORBIDDEN` or `dms.errors.blocked`.
    pub code: String,
    pub message: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct FieldErrorBody {
    pub code: String,
    /// The offending request field.
    pub path: String,
}

#[derive(Serialize, ToSchema)]
pub struct ValidationErrorBody {
    /// Always `VALIDATION_FAILED`.
    pub code: String,
    pub errors: Vec<FieldErrorBody>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitBody {
    /// Error code such as `messages.errors.rateLimited`.
    pub message: String,
    /// Milliseconds until the next attempt is allowed.
    pub retry_after: i64,
}

#[derive(Serialize, ToSchema)]
pub struct SuccessBody {
    pub success: bool,
}

#[allow(dead_code)]
#[derive(Serialize, ToSchema)]
pub enum RelationshipKind {
    #[serde(rename = "FRIEND")]
    Friend,
    #[serde(rename = "INCOMING")]
    Incoming,
    #[serde(rename = "OUTGOING")]
    Outgoing,
    #[serde(rename = "BLOCKED")]
    Blocked,
}

#[derive(Serialize, ToSchema)]
pub struct Relationship {
    pub user: User,
    pub kind: RelationshipKind,
    /// Unix milliseconds.
    pub since: i64,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DmChannel {
    pub id: String,
    pub name: Option<String>,
    pub is_group: bool,
    pub owner_id: String,
    pub members: Vec<User>,
    /// Unix milliseconds.
    pub last_message_at: i64,
}

#[derive(Serialize, ToSchema)]
pub struct SearchResponse {
    /// Total matches, not just this page.
    pub total: i64,
    pub messages: Vec<Message>,
}

#[derive(Serialize, ToSchema)]
pub struct InviteUseResponse {
    pub code: String,
    pub guild: Guild,
    pub users: Vec<User>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminInviteCode {
    pub id: String,
    pub code: String,
    pub created_by: String,
    pub used: bool,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeletionResponse {
    /// Unix milliseconds when the account will be deleted.
    pub delete_at: i64,
}

/// Multipart body with a single image.
#[allow(dead_code)]
#[derive(ToSchema)]
pub struct ImageUpload {
    #[schema(format = Binary)]
    pub file: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_builds_and_has_every_route_prefix() {
        let spec = ApiDoc::openapi();
        let json = serde_json::to_value(&spec).unwrap();
        let paths = json["paths"].as_object().unwrap();
        for p in [
            "/auth/login",
            "/channels/{id}/messages",
            "/dms",
            "/friends/requests",
            "/search/dms",
            "/voice/media",
        ] {
            assert!(paths.contains_key(p), "missing {p}");
        }
    }

    #[test]
    fn committed_spec_is_current() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/openapi.json");
        let committed = std::fs::read_to_string(path).unwrap_or_default();
        let current = ApiDoc::openapi().to_pretty_json().unwrap();
        assert_eq!(
            committed.trim(),
            current.trim(),
            "docs/openapi.json is stale; run scripts/gen-openapi.sh"
        );
    }
}
