//! Server roles and what they allow.
//!
//! A member's permissions are `@everyone` plus every role they hold. The owner and anyone with
//! `ADMINISTRATOR` can do everything. Roles are ranked by `position`: you may only change roles
//! and members that rank below your own highest role (the owner outranks all).

use crate::error::AppError;
use crate::models::Role;
use crate::state::SharedState;

pub const ADMINISTRATOR: i32 = 1 << 0;
pub const MANAGE_GUILD: i32 = 1 << 1;
pub const MANAGE_ROLES: i32 = 1 << 2;
pub const MANAGE_CHANNELS: i32 = 1 << 3;
pub const MANAGE_EMOJIS: i32 = 1 << 4;
pub const MANAGE_MESSAGES: i32 = 1 << 5;
pub const CREATE_INVITE: i32 = 1 << 6;
pub const KICK_MEMBERS: i32 = 1 << 7;
pub const SEND_MESSAGES: i32 = 1 << 8;
pub const VIEW_AUDIT_LOG: i32 = 1 << 9;

pub const ALL: i32 = (1 << 10) - 1;
pub const DEFAULT_EVERYONE: i32 = SEND_MESSAGES | CREATE_INVITE;

pub const OWNER_RANK: i32 = i32::MAX;
const MAX_ROLES: usize = 50;

pub fn compose(is_owner: bool, everyone: i32, roles: &[i32]) -> i32 {
    if is_owner {
        return ALL;
    }
    let all = roles.iter().fold(everyone, |acc, p| acc | p);
    if all & ADMINISTRATOR != 0 {
        ALL
    } else {
        all & ALL
    }
}

pub fn has(perms: i32, wanted: i32) -> bool {
    perms & wanted == wanted
}

pub struct Standing {
    pub permissions: i32,
    pub rank: i32,
    pub is_owner: bool,
}

impl Standing {
    pub fn can(&self, wanted: i32) -> bool {
        has(self.permissions, wanted)
    }
}

/// The `@everyone` role, created on first use for servers that predate roles.
async fn ensure_everyone(state: &SharedState, guild_id: &str) -> Result<(), AppError> {
    let exists = state
        .db
        .guild_roles
        .find_first(|q| q.where_id(guild_id.to_string()))
        .await?
        .is_some();
    if !exists {
        state
            .db
            .guild_roles
            .create(|c| {
                c.set_id(guild_id.to_string())
                    .set_guild_id(guild_id.to_string())
                    .set_name("@everyone".to_string())
                    .set_color(0)
                    .set_position(0)
                    .set_permissions(DEFAULT_EVERYONE)
            })
            .await?;
    }
    Ok(())
}

pub async fn init_guild(state: &SharedState, guild_id: &str) -> Result<(), AppError> {
    ensure_everyone(state, guild_id).await
}

pub async fn load_roles(state: &SharedState, guild_id: &str) -> Result<Vec<Role>, AppError> {
    ensure_everyone(state, guild_id).await?;
    let mut roles: Vec<Role> = state
        .db
        .guild_roles
        .find_many(|q| q.where_guild_id(guild_id.to_string()))
        .await?
        .into_iter()
        .map(Role::from)
        .collect();
    roles.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
    Ok(roles)
}

pub async fn load_member_roles(
    state: &SharedState,
    guild_id: &str,
) -> Result<std::collections::HashMap<String, Vec<String>>, AppError> {
    let mut by_user: std::collections::HashMap<String, Vec<String>> = Default::default();
    for row in state
        .db
        .guild_member_roles
        .find_many(|q| q.where_guild_id(guild_id.to_string()))
        .await?
    {
        by_user.entry(row.user_id).or_default().push(row.role_id);
    }
    Ok(by_user)
}

pub async fn role_ids_of(
    state: &SharedState,
    guild_id: &str,
    user_id: &str,
) -> Result<Vec<String>, AppError> {
    Ok(state
        .db
        .guild_member_roles
        .find_many(|q| {
            q.where_guild_id(guild_id.to_string())
                .where_user_id(user_id.to_string())
        })
        .await?
        .into_iter()
        .map(|r| r.role_id)
        .collect())
}

pub async fn standing(
    state: &SharedState,
    guild_id: &str,
    user_id: &str,
) -> Result<Standing, AppError> {
    let owner = state
        .guild_owner(guild_id)
        .await?
        .ok_or(AppError::NotFound("servers.notFound".to_string()))?;
    let is_owner = owner == user_id;

    let is_member = state
        .db
        .guild_members
        .find_first(|q| {
            q.where_guild_id(guild_id.to_string())
                .where_user_id(user_id.to_string())
        })
        .await?
        .is_some();
    if !is_member && !is_owner {
        return Err(AppError::Forbidden("servers.notMember".to_string()));
    }

    let roles = load_roles(state, guild_id).await?;
    let held = role_ids_of(state, guild_id, user_id).await?;
    let everyone = roles
        .iter()
        .find(|r| r.id == guild_id)
        .map_or(DEFAULT_EVERYONE, |r| r.permissions);
    let held_roles: Vec<&Role> = roles.iter().filter(|r| held.contains(&r.id)).collect();
    let permissions = compose(
        is_owner,
        everyone,
        &held_roles.iter().map(|r| r.permissions).collect::<Vec<_>>(),
    );
    let rank = if is_owner {
        OWNER_RANK
    } else {
        held_roles.iter().map(|r| r.position).max().unwrap_or(0)
    };
    Ok(Standing {
        permissions,
        rank,
        is_owner,
    })
}

pub async fn require(
    state: &SharedState,
    guild_id: &str,
    user_id: &str,
    wanted: i32,
) -> Result<Standing, AppError> {
    let s = standing(state, guild_id, user_id).await?;
    if !s.can(wanted) {
        return Err(AppError::Forbidden("servers.noPermission".to_string()));
    }
    Ok(s)
}

pub async fn remove_member(
    state: &SharedState,
    guild_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    state
        .db
        .guild_member_roles
        .delete(|d| {
            d.where_guild_id(guild_id.to_string())
                .where_user_id(user_id.to_string())
        })
        .await?;
    state
        .db
        .guild_members
        .delete(|d| {
            d.where_guild_id(guild_id.to_string())
                .where_user_id(user_id.to_string())
        })
        .await?;
    Ok(())
}

pub const fn max_roles() -> usize {
    MAX_ROLES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_has_everything() {
        assert_eq!(compose(true, 0, &[]), ALL);
    }

    #[test]
    fn everyone_and_roles_add_up() {
        let p = compose(false, SEND_MESSAGES, &[MANAGE_EMOJIS, KICK_MEMBERS]);
        assert!(has(p, SEND_MESSAGES | MANAGE_EMOJIS | KICK_MEMBERS));
        assert!(!has(p, MANAGE_ROLES));
    }

    #[test]
    fn administrator_is_everything() {
        assert_eq!(compose(false, 0, &[ADMINISTRATOR]), ALL);
    }

    #[test]
    fn unknown_bits_are_dropped() {
        assert_eq!(compose(false, 1 << 20, &[]), 0);
    }
}
