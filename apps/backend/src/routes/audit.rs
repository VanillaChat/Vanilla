use axum::extract::{Path, Query, State};
use axum::{Json, Router, response::IntoResponse, routing::get};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use super::dms::db_err;
use super::guilds::get_current_user;
use crate::error::AppError;
use crate::models::User;
use crate::permissions::{self, VIEW_AUDIT_LOG};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new().route("/{id}/audit-log", get(list_audit_log))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    /// Entries older than this entry id.
    before: Option<String>,
    /// 1 to 100, default 50.
    limit: Option<i64>,
    /// Only this action, e.g. `role.update`.
    action: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    /// The member who made the change; their account may have been deleted since.
    pub actor_id: String,
    pub actor: Option<User>,
    /// Dotted name such as `channel.create`, `role.update` or `member.kick`.
    pub action: String,
    /// What it was about: `guild`, `channel`, `role`, `member`, `emoji`, `invite` or `message`.
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    /// Name at the time of the change.
    pub target_name: Option<String>,
    /// Changed fields as `{ field: [from, to] }`, or `{ field: [value] }` for one-sided notes.
    #[schema(value_type = Option<Object>)]
    pub changes: Option<Value>,
    /// Unix milliseconds.
    pub created_at: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AuditPage {
    /// Newest first.
    pub entries: Vec<AuditEntry>,
    /// More entries exist before the last one.
    pub has_more: bool,
}

#[utoipa::path(
    get,
    path = "/guilds/{id}/audit-log",
    tag = "Guilds",
    summary = "Read the audit log",
    description = "Needs VIEW_AUDIT_LOG. Newest first; page back with `before`.",
    params(("id" = String, Path, description = "Guild id"), AuditQuery),
    responses(
    (status = 200, description = "Entries", body = AuditPage),
    (status = 403, description = "Missing permission", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn list_audit_log(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Query(query): Query<AuditQuery>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    permissions::require(&state, &guild_id, &account.id, VIEW_AUDIT_LOG).await?;

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let mut rows = state
        .db
        .guild_audit_entries
        .find_many(|q| {
            let mut q = q
                .where_guild_id(guild_id.clone())
                .order_by_id_desc()
                .limit(limit as usize + 1);
            if let Some(before) = &query.before {
                q = q.where_id_lt(before.clone());
            }
            if let Some(action) = &query.action {
                q = q.where_action(action.clone());
            }
            q
        })
        .await
        .map_err(db_err)?;
    let has_more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);

    let mut actor_ids: Vec<String> = rows.iter().map(|r| r.actor_id.clone()).collect();
    actor_ids.sort();
    actor_ids.dedup();
    let actors: std::collections::HashMap<String, User> = if actor_ids.is_empty() {
        Default::default()
    } else {
        state
            .db
            .users
            .find_many(|q| q.where_id_in(actor_ids.clone()))
            .await
            .map_err(db_err)?
            .into_iter()
            .map(|u| (u.id.clone(), User::from(u)))
            .collect()
    };

    let entries = rows
        .into_iter()
        .map(|r| AuditEntry {
            actor: actors.get(&r.actor_id).cloned(),
            changes: r
                .changes
                .as_deref()
                .and_then(|c| serde_json::from_str(c).ok()),
            id: r.id,
            actor_id: r.actor_id,
            action: r.action,
            target_type: r.target_type,
            target_id: r.target_id,
            target_name: r.target_name,
            created_at: r.created_at.timestamp_millis(),
        })
        .collect();
    Ok(Json(AuditPage { entries, has_more }))
}
