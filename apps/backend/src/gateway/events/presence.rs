use std::collections::HashSet;

use serde_json::json;

use byteorm_client::UserStatus;

use crate::gateway::Payload;
use crate::state::SharedState;

pub async fn handle(
    state: &SharedState,
    user_id: &str,
    rooms: &[String],
    data: Option<serde_json::Value>,
) {
    tracing::info!("PRESENCE HANDLE: user_id={}, data={:?}", user_id, data);

    let new_status = data
        .as_ref()
        .and_then(|d| d.get("status").cloned())
        .and_then(|s| s.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "ONLINE".to_string());
    let duration_ms = data
        .as_ref()
        .and_then(|d| d.get("durationMs"))
        .and_then(|v| v.as_i64());

    tracing::info!("PRESENCE: new_status={}", new_status);

    let new_status = match new_status.parse::<UserStatus>() {
        Ok(status) => status,
        Err(e) => {
            tracing::warn!("Invalid presence status '{}': {}", new_status, e);
            return;
        }
    };

    let user = match state
        .db
        .users
        .find_first(|q| q.where_id(user_id.to_string()))
        .await
    {
        Ok(Some(u)) => u,
        _ => return,
    };

    // Only a status you step away into can be temporary; going online ends any timer.
    let until = match new_status {
        UserStatus::ONLINE | UserStatus::UNAVAILABLE => None,
        _ => crate::status::until_from(duration_ms, chrono::Utc::now()),
    };

    if user.status == new_status && until.is_none() && user.status_until.is_none() {
        return;
    }

    let result = state
        .db
        .users
        .update(|u| {
            u.where_id(user_id.to_string())
                .set_status(new_status)
                .set_status_until(until)
        })
        .await
        .map(|_| 1);

    if let Err(e) = result {
        tracing::error!("Failed to update presence in DB: {:?}", e);
    } else {
        tracing::info!("Presence updated in DB for user {}", user_id);
    }

    let presence = Payload::dispatch(
        "PRESENCE_UPDATE",
        json!({
            "userId": user_id,
            "status": new_status.to_string()
        }),
    );
    let serialized = match serde_json::to_string(&presence) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("Failed to serialize presence: {:?}", e);
            return;
        }
    };

    let mut recipients: HashSet<String> = HashSet::new();
    for room in rooms {
        if room == "admins" {
            continue;
        }
        let members = match state
            .db
            .guild_members
            .find_many(|q| q.where_guild_id(room.clone()))
            .await
        {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("Failed to fetch guild_members for {}: {:?}", room, e);
                continue;
            }
        };
        for member in members {
            if member.user_id == user_id {
                continue;
            }
            recipients.insert(member.user_id);
        }
    }

    for rid in recipients {
        state.send_to_user(&rid, serialized.clone());
    }

    let own = Payload::dispatch(
        "PRESENCE_UPDATE",
        json!({
            "userId": user_id,
            "status": new_status.to_string(),
            "until": until.map(|t| t.timestamp_millis()),
        }),
    );
    if let Ok(text) = serde_json::to_string(&own) {
        state.send_to_user(user_id, text);
    }
}
