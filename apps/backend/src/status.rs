//! Temporary presence statuses, custom statuses and how changes reach other users.

use std::collections::HashSet;
use std::time::Duration;

use byteorm_client::UserStatus;
use chrono::{DateTime, Utc};
use serde_json::json;

use crate::error::AppError;
use crate::gateway::Payload;
use crate::models::User;
use crate::state::SharedState;

const MIN_DURATION_MS: i64 = 60_000;
const MAX_DURATION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_STATUS_CHARS: usize = 60;
const MAX_EMOJI_CHARS: usize = 8;
const SWEEP_EVERY: Duration = Duration::from_secs(15);

/// When a status asked to last `ms` milliseconds ends. Nothing for "no limit" or nonsense.
pub fn until_from(ms: Option<i64>, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let ms = ms.filter(|ms| *ms > 0)?;
    Some(now + chrono::Duration::milliseconds(ms.clamp(MIN_DURATION_MS, MAX_DURATION_MS)))
}

fn bad(code: &str) -> AppError {
    AppError::BadRequest(code.to_string())
}

/// A single Unicode emoji, or a custom one written `<:name:id>`.
fn valid_emoji(e: &str) -> bool {
    if let Some(inner) = e.strip_prefix("<:").and_then(|r| r.strip_suffix('>')) {
        return inner.split_once(':').is_some_and(|(name, id)| {
            (2..=32).contains(&name.len())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && (1..=20).contains(&id.len())
                && id.chars().all(|c| c.is_ascii_digit())
        });
    }
    e.chars().count() <= MAX_EMOJI_CHARS && !e.chars().any(char::is_whitespace)
}

pub fn clean_custom(
    text: Option<String>,
    emoji: Option<String>,
) -> Result<(Option<String>, Option<String>), AppError> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let emoji = emoji
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    if text
        .as_ref()
        .is_some_and(|t| t.chars().count() > MAX_STATUS_CHARS)
    {
        return Err(bad("status.errors.textTooLong"));
    }
    if emoji.as_ref().is_some_and(|e| !valid_emoji(e)) {
        return Err(bad("status.errors.badEmoji"));
    }
    Ok((text, emoji))
}

pub async fn peers(state: &SharedState, user_id: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(mine) = state
        .db
        .guild_members
        .find_many(|q| q.where_user_id(user_id.to_string()))
        .await
    else {
        return out;
    };
    for m in mine {
        if let Ok(members) = state
            .db
            .guild_members
            .find_many(|q| q.where_guild_id(m.guild_id.clone()))
            .await
        {
            out.extend(members.into_iter().map(|g| g.user_id));
        }
    }
    out.remove(user_id);
    out
}

pub async fn broadcast_presence(
    state: &SharedState,
    user_id: &str,
    status: UserStatus,
    until: Option<DateTime<Utc>>,
) {
    let status = status.to_string();
    let public = Payload::dispatch(
        "PRESENCE_UPDATE",
        json!({ "userId": user_id, "status": status }),
    );
    if let Ok(text) = serde_json::to_string(&public) {
        for peer in peers(state, user_id).await {
            state.send_to_user(&peer, text.clone());
        }
    }
    let own = Payload::dispatch(
        "PRESENCE_UPDATE",
        json!({
            "userId": user_id,
            "status": status,
            "until": until.map(|t| t.timestamp_millis()),
        }),
    );
    if let Ok(text) = serde_json::to_string(&own) {
        state.send_to_user(user_id, text);
    }
}

pub async fn broadcast_user(state: &SharedState, user: &User) {
    let Ok(memberships) = state
        .db
        .guild_members
        .find_many(|q| q.where_user_id(user.id.clone()))
        .await
    else {
        return;
    };
    for m in memberships {
        let event = Payload::dispatch(
            "USER_UPDATE",
            json!({ "guildId": m.guild_id, "user": user }),
        );
        if let Ok(text) = serde_json::to_string(&event) {
            state.broadcast_to_room(&m.guild_id, text);
        }
    }
    let own = Payload::dispatch("USER_UPDATE", json!({ "guildId": null, "user": user }));
    if let Ok(text) = serde_json::to_string(&own) {
        state.send_to_user(&user.id, text);
    }
}

async fn expire(state: &SharedState) -> Result<(), AppError> {
    let now = Utc::now();

    let timed = state
        .db
        .users
        .find_many(|q| q.where_status_until_is_not_null())
        .await?;
    for u in timed
        .into_iter()
        .filter(|u| u.status_until.is_some_and(|t| t <= now))
    {
        state
            .db
            .users
            .update(|w| {
                w.where_id(u.id.clone())
                    .set_status(UserStatus::ONLINE)
                    .set_status_until(None)
            })
            .await?;
        broadcast_presence(state, &u.id, UserStatus::ONLINE, None).await;
    }

    let custom = state
        .db
        .users
        .find_many(|q| q.where_custom_status_until_is_not_null())
        .await?;
    for u in custom
        .into_iter()
        .filter(|u| u.custom_status_until.is_some_and(|t| t <= now))
    {
        state
            .db
            .users
            .update(|w| {
                w.where_id(u.id.clone())
                    .set_custom_status(None)
                    .set_custom_emoji(None)
                    .set_custom_status_until(None)
            })
            .await?;
        if let Some(fresh) = state
            .db
            .users
            .find_first(|q| q.where_id(u.id.clone()))
            .await?
        {
            broadcast_user(state, &User::from(fresh)).await;
        }
    }
    Ok(())
}

pub fn spawn_sweeper(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        loop {
            tick.tick().await;
            if let Err(e) = expire(&state).await {
                tracing::warn!("status sweep failed: {e:?}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_emoji_may_be_custom() {
        assert!(valid_emoji("😀"));
        assert!(valid_emoji("<:salceson_akrobatyczny:1565376747027824651>"));
        assert!(!valid_emoji("<:a:1>"));
        assert!(!valid_emoji("<:name:abc>"));
        assert!(!valid_emoji("<:name:1> x"));
        assert!(!valid_emoji("not an emoji"));
    }

    #[test]
    fn durations_are_clamped_and_optional() {
        let now = Utc::now();
        assert_eq!(until_from(None, now), None);
        assert_eq!(until_from(Some(0), now), None);
        assert_eq!(until_from(Some(-5), now), None);
        assert_eq!(
            until_from(Some(1), now),
            Some(now + chrono::Duration::milliseconds(MIN_DURATION_MS))
        );
        assert_eq!(
            until_from(Some(i64::MAX), now),
            Some(now + chrono::Duration::milliseconds(MAX_DURATION_MS))
        );
        assert_eq!(
            until_from(Some(3_600_000), now),
            Some(now + chrono::Duration::hours(1))
        );
    }

    #[test]
    fn custom_status_is_trimmed_and_limited() {
        let ok = clean_custom(Some("  busy  ".into()), Some("🔥".into())).unwrap();
        assert_eq!(ok, (Some("busy".into()), Some("🔥".into())));
        assert_eq!(
            clean_custom(Some("  ".into()), Some("".into())).unwrap(),
            (None, None)
        );
        assert!(clean_custom(Some("x".repeat(61)), None).is_err());
        assert!(clean_custom(Some("x".repeat(60)), None).is_ok());
        assert!(clean_custom(None, Some("a b".into())).is_err());
        assert!(clean_custom(None, Some("123456789".into())).is_err());
    }

    #[test]
    fn badges_follow_flags_and_bits() {
        use crate::models::{UserFlags, badge_bit, badges_for};
        assert!(badges_for(0, 0).is_empty());
        assert_eq!(badges_for(UserFlags::ADMIN, 0), vec!["staff"]);
        let bits = badge_bit("supporter").unwrap() | badge_bit("early_adopter").unwrap();
        assert_eq!(badges_for(0, bits), vec!["early_adopter", "supporter"]);
        assert!(badge_bit("nope").is_none());
    }
}
