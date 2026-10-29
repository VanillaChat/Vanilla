//! The server audit log: who changed what, kept per guild.
//!
//! Handlers call [`record`] after a change went through. Failing to write an entry is logged
//! and never fails the request that caused it.

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::routes::guilds::generate_snowflake;
use crate::state::SharedState;

/// What an entry is about, shown by name even after the thing is gone.
pub struct Target<'a> {
    pub kind: &'a str,
    pub id: &'a str,
    pub name: &'a str,
}

/// Before/after pairs of the fields that changed, written `{ "name": [from, to] }`.
#[derive(Default)]
pub struct Changes(Map<String, Value>);

impl Changes {
    pub fn new() -> Self {
        Self::default()
    }

    /// Notes the field only when the value differs.
    pub fn field<T: Serialize + PartialEq>(mut self, name: &str, from: &T, to: &T) -> Self {
        if from != to {
            self.0.insert(name.to_string(), json!([from, to]));
        }
        self
    }

    /// Notes a field of something new, or about to be gone, with no counterpart.
    pub fn value<T: Serialize>(mut self, name: &str, value: &T) -> Self {
        self.0.insert(name.to_string(), json!([value]));
        self
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub async fn record(
    state: &SharedState,
    guild_id: &str,
    actor_id: &str,
    action: &str,
    target: Option<Target<'_>>,
    changes: Changes,
) {
    let text = (!changes.is_empty()).then(|| Value::Object(changes.0).to_string());
    let result = state
        .db
        .guild_audit_entries
        .create(|c| {
            c.set_id(generate_snowflake())
                .set_guild_id(guild_id.to_string())
                .set_actor_id(actor_id.to_string())
                .set_action(action.to_string())
                .set_target_type(target.as_ref().map(|t| t.kind.to_string()))
                .set_target_id(target.as_ref().map(|t| t.id.to_string()))
                .set_target_name(target.as_ref().map(|t| t.name.to_string()))
                .set_changes(text.clone())
        })
        .await;
    if let Err(e) = result {
        tracing::warn!("audit entry {action} failed: {e:?}");
    }
}

/// For updates: skips the entry when nothing actually changed.
pub async fn record_update(
    state: &SharedState,
    guild_id: &str,
    actor_id: &str,
    action: &str,
    target: Option<Target<'_>>,
    changes: Changes,
) {
    if !changes.is_empty() {
        record(state, guild_id, actor_id, action, target, changes).await;
    }
}

/// Display name for an entry's target; falls back to the id.
pub async fn username(state: &SharedState, user_id: &str) -> String {
    match state
        .db
        .users
        .find_first(|q| q.where_id(user_id.to_string()))
        .await
    {
        Ok(Some(u)) => u.username,
        _ => user_id.to_string(),
    }
}
