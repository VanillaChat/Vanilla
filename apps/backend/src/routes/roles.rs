use axum::extract::{Path, State};
use axum::{
    Json, Router,
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;

use super::guilds::{generate_snowflake, get_current_user};
use crate::audit::{self, Changes, Target};
use crate::error::{AppError, FieldError};
use crate::models::{Role, User};
use crate::permissions::{self, MANAGE_ROLES, Standing};
use crate::state::SharedState;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route("/{id}/roles", get(list_roles).post(create_role))
        .route("/{id}/roles/reorder", post(reorder_roles))
        .route(
            "/{id}/roles/{role_id}",
            axum::routing::patch(update_role).delete(delete_role),
        )
        .route(
            "/{id}/members/{user_id}/roles/{role_id}",
            put(add_member_role).delete(remove_member_role),
        )
        .route("/{id}/members/{user_id}", delete(kick_member))
}

const MAX_NAME: usize = 32;

fn name_error(code: &str) -> AppError {
    AppError::ValidationFailed(vec![FieldError {
        code: code.to_string(),
        path: "name".to_string(),
    }])
}

fn clean_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(name_error("roles.errors.nameRequired"));
    }
    if name.chars().count() > MAX_NAME {
        return Err(name_error("roles.errors.nameTooLong"));
    }
    Ok(name.to_string())
}

/// A role may be touched only by someone ranking above it; the owner outranks everything.
fn ensure_above(actor: &Standing, role: &Role) -> Result<(), AppError> {
    if role.id == role.guild_id || actor.rank <= role.position {
        return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
    }
    Ok(())
}

/// Nobody can hand out a permission they do not hold themselves.
fn ensure_grantable(actor: &Standing, permissions: i32) -> Result<(), AppError> {
    if actor.is_owner || permissions & !actor.permissions == 0 {
        Ok(())
    } else {
        Err(AppError::Forbidden("roles.errors.escalation".to_string()))
    }
}

async fn find_role(state: &SharedState, guild_id: &str, role_id: &str) -> Result<Role, AppError> {
    permissions::load_roles(state, guild_id)
        .await?
        .into_iter()
        .find(|r| r.id == role_id)
        .ok_or(AppError::NotFound("roles.notFound".to_string()))
}

async fn broadcast_roles(state: &SharedState, guild_id: &str) -> Result<(), AppError> {
    let roles = permissions::load_roles(state, guild_id).await?;
    state.broadcast_to_room(
        guild_id,
        json!({
            "op": 0,
            "t": "GUILD_ROLES_UPDATE",
            "d": { "guildId": guild_id, "roles": roles },
        })
        .to_string(),
    );
    Ok(())
}

async fn broadcast_member_roles(
    state: &SharedState,
    guild_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    let roles = permissions::role_ids_of(state, guild_id, user_id).await?;
    state.broadcast_to_room(
        guild_id,
        json!({
            "op": 0,
            "t": "GUILD_MEMBER_UPDATE",
            "d": { "guildId": guild_id, "userId": user_id, "roles": roles },
        })
        .to_string(),
    );
    Ok(())
}

#[utoipa::path(
    get,
    path = "/guilds/{id}/roles",
    tag = "Roles",
    summary = "List a server's roles",
    description = "Members only. Lowest rank first; `@everyone` (the role whose id is the guild id) leads.",
    params(("id" = String, Path, description = "Guild id")),
    responses(
    (status = 200, description = "Roles", body = Vec<Role>),
    (status = 403, description = "Not a member", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn list_roles(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    permissions::standing(&state, &guild_id, &account.user_id).await?;
    Ok(Json(permissions::load_roles(&state, &guild_id).await?))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoleRequest {
    name: String,
    /// `0xRRGGBB`; 0 or omitted for none.
    color: Option<i32>,
    /// List members with this role in their own group.
    hoist: Option<bool>,
    /// Bitmask; omitted for none.
    permissions: Option<i32>,
}

#[utoipa::path(
    post,
    path = "/guilds/{id}/roles",
    tag = "Roles",
    summary = "Create a role",
    description = "Needs MANAGE_ROLES and a role of your own (or ownership). The new role ranks just above `@everyone`. At most 50 per server. You cannot grant permissions you do not hold. Broadcasts GUILD_ROLES_UPDATE.",
    params(("id" = String, Path, description = "Guild id")),
    request_body = CreateRoleRequest,
    responses(
    (status = 200, description = "Created role", body = Role),
    (status = 400, description = "Validation failed (roles.errors.*)", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn create_role(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Json(body): Json<CreateRoleRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let actor = permissions::require(&state, &guild_id, &account.user_id, MANAGE_ROLES).await?;
    // A role made at the bottom must still rank below its maker.
    if !actor.is_owner && actor.rank < 1 {
        return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
    }
    let name = clean_name(&body.name)?;
    let color = body.color.unwrap_or(0).clamp(0, 0xFF_FFFF);
    let perms = body.permissions.unwrap_or(0) & permissions::ALL;
    ensure_grantable(&actor, perms)?;

    let existing = permissions::load_roles(&state, &guild_id).await?;
    if existing.len() >= permissions::max_roles() {
        return Err(AppError::BadRequest("roles.errors.limit".to_string()));
    }
    for role in existing.iter().filter(|r| r.position >= 1) {
        state
            .db
            .guild_roles
            .update(|u| u.set_position(role.position + 1).where_id(role.id.clone()))
            .await?;
    }

    let id = generate_snowflake();
    state
        .db
        .guild_roles
        .create(|c| {
            c.set_id(id.clone())
                .set_guild_id(guild_id.clone())
                .set_name(name.clone())
                .set_color(color)
                .set_hoist(body.hoist.unwrap_or(false))
                .set_position(1)
                .set_permissions(perms)
        })
        .await?;
    broadcast_roles(&state, &guild_id).await?;
    audit::record(
        &state,
        &guild_id,
        &account.user_id,
        "role.create",
        Some(Target {
            kind: "role",
            id: &id,
            name: &name,
        }),
        Changes::new(),
    )
    .await;
    Ok(Json(find_role(&state, &guild_id, &id).await?))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoleRequest {
    name: Option<String>,
    color: Option<i32>,
    hoist: Option<bool>,
    permissions: Option<i32>,
}

#[utoipa::path(
    patch,
    path = "/guilds/{id}/roles/{role_id}",
    tag = "Roles",
    summary = "Edit a role",
    description = "Needs MANAGE_ROLES and a higher rank than the role. `@everyone` can change only its permissions. You cannot grant permissions you do not hold. Broadcasts GUILD_ROLES_UPDATE.",
    params(("id" = String, Path, description = "Guild id"), ("role_id" = String, Path, description = "Role id")),
    request_body = UpdateRoleRequest,
    responses(
    (status = 200, description = "Updated role", body = Role),
    (status = 400, description = "Validation failed (roles.errors.*)", body = crate::openapi::ValidationErrorBody),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 404, description = "Role not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_role(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, role_id)): Path<(String, String)>,
    Json(body): Json<UpdateRoleRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let actor = permissions::require(&state, &guild_id, &account.user_id, MANAGE_ROLES).await?;
    let role = find_role(&state, &guild_id, &role_id).await?;
    let everyone = role.id == role.guild_id;
    if !everyone {
        ensure_above(&actor, &role)?;
    }

    let name = match &body.name {
        Some(_) if everyone => {
            return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
        }
        Some(n) => clean_name(n)?,
        None => role.name.clone(),
    };
    let color = match body.color {
        Some(_) if everyone => {
            return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
        }
        Some(c) => c.clamp(0, 0xFF_FFFF),
        None => role.color,
    };
    let hoist = match body.hoist {
        Some(_) if everyone => {
            return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
        }
        Some(h) => h,
        None => role.hoist,
    };
    let perms = match body.permissions {
        Some(p) => {
            let p = p & permissions::ALL;
            ensure_grantable(&actor, p & !role.permissions)?;
            p
        }
        None => role.permissions,
    };

    state
        .db
        .guild_roles
        .update(|u| {
            u.set_name(name.clone())
                .set_color(color)
                .set_hoist(hoist)
                .set_permissions(perms)
                .where_id(role_id.clone())
        })
        .await?;
    broadcast_roles(&state, &guild_id).await?;
    audit::record_update(
        &state,
        &guild_id,
        &account.user_id,
        "role.update",
        Some(Target {
            kind: "role",
            id: &role_id,
            name: &name,
        }),
        Changes::new()
            .field("name", &role.name, &name)
            .field("color", &role.color, &color)
            .field("hoist", &role.hoist, &hoist)
            .field("permissions", &role.permissions, &perms),
    )
    .await;
    Ok(Json(find_role(&state, &guild_id, &role_id).await?))
}

#[utoipa::path(
    delete,
    path = "/guilds/{id}/roles/{role_id}",
    tag = "Roles",
    summary = "Delete a role",
    description = "Needs MANAGE_ROLES and a higher rank than the role. Members lose it. Broadcasts GUILD_ROLES_UPDATE.",
    params(("id" = String, Path, description = "Guild id"), ("role_id" = String, Path, description = "Role id")),
    responses(
    (status = 204, description = "Deleted"),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 404, description = "Role not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn delete_role(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, role_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let actor = permissions::require(&state, &guild_id, &account.user_id, MANAGE_ROLES).await?;
    let role = find_role(&state, &guild_id, &role_id).await?;
    ensure_above(&actor, &role)?;

    let holders = state
        .db
        .guild_member_roles
        .find_many(|q| q.where_role_id(role_id.clone()))
        .await?;
    state
        .db
        .guild_roles
        .delete(|d| d.where_id(role_id.clone()))
        .await?;
    broadcast_roles(&state, &guild_id).await?;
    for holder in holders {
        broadcast_member_roles(&state, &guild_id, &holder.user_id).await?;
    }
    audit::record(
        &state,
        &guild_id,
        &account.user_id,
        "role.delete",
        Some(Target {
            kind: "role",
            id: &role.id,
            name: &role.name,
        }),
        Changes::new(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReorderRolesRequest {
    /// Every role except `@everyone`, lowest rank first.
    role_ids: Vec<String>,
}

#[utoipa::path(
    post,
    path = "/guilds/{id}/roles/reorder",
    tag = "Roles",
    summary = "Reorder roles",
    description = "Needs MANAGE_ROLES. Send every role except `@everyone`, lowest first. Roles at or above your own rank must stay where they are. Broadcasts GUILD_ROLES_UPDATE.",
    params(("id" = String, Path, description = "Guild id")),
    request_body = ReorderRolesRequest,
    responses(
    (status = 200, description = "Roles in their new order", body = Vec<Role>),
    (status = 400, description = "The list is not every role exactly once", body = crate::openapi::ErrorBody),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn reorder_roles(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(guild_id): Path<String>,
    Json(body): Json<ReorderRolesRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let actor = permissions::require(&state, &guild_id, &account.user_id, MANAGE_ROLES).await?;
    let roles = permissions::load_roles(&state, &guild_id).await?;
    let custom: Vec<&Role> = roles.iter().filter(|r| r.id != guild_id).collect();

    let mut wanted = body.role_ids.clone();
    wanted.sort();
    wanted.dedup();
    let mut have: Vec<&str> = custom.iter().map(|r| r.id.as_str()).collect();
    have.sort();
    if wanted.len() != body.role_ids.len() || wanted.iter().map(String::as_str).ne(have) {
        return Err(AppError::BadRequest("roles.errors.reorder".to_string()));
    }

    for (i, id) in body.role_ids.iter().enumerate() {
        let new_pos = i as i32 + 1;
        let old = custom.iter().find(|r| &r.id == id).map(|r| r.position);
        if old == Some(new_pos) {
            continue;
        }
        let old = old.unwrap_or(0);
        if !actor.is_owner && (old >= actor.rank || new_pos >= actor.rank) {
            return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
        }
    }
    for (i, id) in body.role_ids.iter().enumerate() {
        state
            .db
            .guild_roles
            .update(|u| u.set_position(i as i32 + 1).where_id(id.clone()))
            .await?;
    }
    broadcast_roles(&state, &guild_id).await?;
    let order: Vec<&str> = body.role_ids.iter().map(String::as_str).collect();
    let before: Vec<&str> = {
        let mut r: Vec<&&Role> = custom.iter().collect();
        r.sort_by_key(|r| r.position);
        r.iter().map(|r| r.id.as_str()).collect()
    };
    audit::record_update(
        &state,
        &guild_id,
        &account.user_id,
        "role.reorder",
        None,
        Changes::new().field("order", &before, &order),
    )
    .await;
    Ok(Json(permissions::load_roles(&state, &guild_id).await?))
}

async fn change_member_role(
    state: &SharedState,
    jar: &CookieJar,
    guild_id: &str,
    user_id: &str,
    role_id: &str,
    give: bool,
) -> Result<(), AppError> {
    let account = get_current_user(state, jar).await?;
    let actor = permissions::require(state, guild_id, &account.user_id, MANAGE_ROLES).await?;
    let role = find_role(state, guild_id, role_id).await?;
    ensure_above(&actor, &role)?;
    if give {
        // What a role grants is capped by what you hold, so a role cannot be a back door.
        ensure_grantable(&actor, role.permissions)?;
    }

    let target_is_member = state
        .db
        .guild_members
        .find_first(|q| {
            q.where_guild_id(guild_id.to_string())
                .where_user_id(user_id.to_string())
        })
        .await?
        .is_some();
    if !target_is_member {
        return Err(AppError::NotFound("servers.notMember".to_string()));
    }

    let held = permissions::role_ids_of(state, guild_id, user_id).await?;
    let has = held.iter().any(|r| r == role_id);
    if give && !has {
        state
            .db
            .guild_member_roles
            .create(|c| {
                c.set_guild_id(guild_id.to_string())
                    .set_user_id(user_id.to_string())
                    .set_role_id(role_id.to_string())
            })
            .await?;
    } else if !give && has {
        state
            .db
            .guild_member_roles
            .delete(|d| {
                d.where_guild_id(guild_id.to_string())
                    .where_user_id(user_id.to_string())
                    .where_role_id(role_id.to_string())
            })
            .await?;
    }
    if give != has {
        let member = audit::username(state, user_id).await;
        audit::record(
            state,
            guild_id,
            &account.user_id,
            if give {
                "member.role_add"
            } else {
                "member.role_remove"
            },
            Some(Target {
                kind: "member",
                id: user_id,
                name: &member,
            }),
            Changes::new().value("role", &role.name),
        )
        .await;
    }
    broadcast_member_roles(state, guild_id, user_id).await
}

#[utoipa::path(
    put,
    path = "/guilds/{id}/members/{user_id}/roles/{role_id}",
    tag = "Roles",
    summary = "Give a role to a member",
    description = "Needs MANAGE_ROLES and a higher rank than the role, and you must hold every permission it grants. Broadcasts GUILD_MEMBER_UPDATE.",
    params(
        ("id" = String, Path, description = "Guild id"),
        ("user_id" = String, Path, description = "Member user id"),
        ("role_id" = String, Path, description = "Role id")
    ),
    responses(
    (status = 204, description = "Done"),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 404, description = "Role or member not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn add_member_role(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, user_id, role_id)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    change_member_role(&state, &jar, &guild_id, &user_id, &role_id, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/guilds/{id}/members/{user_id}/roles/{role_id}",
    tag = "Roles",
    summary = "Take a role from a member",
    description = "Needs MANAGE_ROLES and a higher rank than the role. Broadcasts GUILD_MEMBER_UPDATE.",
    params(
        ("id" = String, Path, description = "Guild id"),
        ("user_id" = String, Path, description = "Member user id"),
        ("role_id" = String, Path, description = "Role id")
    ),
    responses(
    (status = 204, description = "Done"),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 404, description = "Role or member not found", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn remove_member_role(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, user_id, role_id)): Path<(String, String, String)>,
) -> Result<impl IntoResponse, AppError> {
    change_member_role(&state, &jar, &guild_id, &user_id, &role_id, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/guilds/{id}/members/{user_id}",
    tag = "Roles",
    summary = "Remove a member from the server",
    description = "Needs KICK_MEMBERS and a higher rank than the member. The owner cannot be removed. The member can rejoin with an invite. Broadcasts GUILD_MEMBER_REMOVE.",
    params(
        ("id" = String, Path, description = "Guild id"),
        ("user_id" = String, Path, description = "Member user id")
    ),
    responses(
    (status = 204, description = "Removed"),
    (status = 403, description = "Missing permission or hierarchy", body = crate::openapi::ErrorBody),
    (status = 404, description = "Not a member", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn kick_member(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path((guild_id, user_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let actor = permissions::require(
        &state,
        &guild_id,
        &account.user_id,
        permissions::KICK_MEMBERS,
    )
    .await?;
    if user_id == account.user_id {
        return Err(AppError::BadRequest("roles.errors.kickSelf".to_string()));
    }
    let target = permissions::standing(&state, &guild_id, &user_id)
        .await
        .map_err(|_| AppError::NotFound("servers.notMember".to_string()))?;
    if target.is_owner || (!actor.is_owner && actor.rank <= target.rank) {
        return Err(AppError::Forbidden("roles.errors.hierarchy".to_string()));
    }

    let user = state
        .db
        .users
        .find_first(|q| q.where_id(user_id.clone()))
        .await?
        .ok_or(AppError::NotFound("servers.notMember".to_string()))?;
    permissions::remove_member(&state, &guild_id, &user_id).await?;
    state.broadcast_to_room(
        &guild_id,
        json!({
            "op": 0,
            "t": "GUILD_MEMBER_REMOVE",
            "d": { "guildId": guild_id, "user": User::from(user.clone()) },
        })
        .to_string(),
    );
    audit::record(
        &state,
        &guild_id,
        &account.user_id,
        "member.kick",
        Some(Target {
            kind: "member",
            id: &user_id,
            name: &user.username,
        }),
        Changes::new(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
