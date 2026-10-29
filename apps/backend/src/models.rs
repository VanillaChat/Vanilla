use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub tag: String,
    #[serde(with = "chrono::serde::ts_milliseconds")]
    #[schema(value_type = i64, example = 1767225600000_i64)]
    pub created_at: DateTime<Utc>,
    pub bot: bool,
    pub flags: i32,
    pub bio: Option<String>,
    pub avatar: Option<String>,
    pub banner: Option<String>,
    /// Always present so clearing it reaches clients that merge updates.
    pub custom_status: Option<CustomStatus>,
    /// Badge ids shown on the profile, e.g. `staff` or `early_adopter`.
    pub badges: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CustomStatus {
    pub text: Option<String>,
    pub emoji: Option<String>,
    /// Unix milliseconds when it clears itself.
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub email_verified: bool,
    pub locale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccountSettings {
    pub theme: String,
    pub compact_mode: Option<bool>,
    pub compact_show_avatars: Option<bool>,
    pub pending_deletion: Option<bool>,
    pub delete_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Guild {
    pub id: String,
    pub name: String,
    pub brief: Option<String>,
    pub icon: Option<String>,
    pub owner_id: String,
    #[serde(with = "chrono::serde::ts_milliseconds_option")]
    #[schema(value_type = Option<i64>)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<Vec<Channel>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<GuildMember>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emojis: Option<Vec<Emoji>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<Role>>,
}

/// A server role: a name and colour for members, and the permissions it grants. The role whose
/// id equals the guild id is `@everyone`, held by every member.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    /// `0xRRGGBB`, or 0 for no colour.
    pub color: i32,
    /// Members with this role are listed in their own group, ranked by role.
    pub hoist: bool,
    /// Higher is more powerful; `@everyone` is 0.
    pub position: i32,
    /// Bitmask, see `docs/permissions.md`.
    pub permissions: i32,
}

impl From<byteorm_client::GuildRoles> for Role {
    fn from(r: byteorm_client::GuildRoles) -> Self {
        Self {
            id: r.id,
            guild_id: r.guild_id,
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            position: r.position,
            permissions: r.permissions,
        }
    }
}

/// A custom emoji of a server. In message text it is written `<:name:id>`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Emoji {
    pub id: String,
    pub guild_id: String,
    pub name: String,
    pub animated: bool,
    pub creator_id: String,
    /// Public path of the image, e.g. `/cdn/emojis/<id>.png`.
    pub url: String,
}

impl From<byteorm_client::GuildEmojis> for Emoji {
    fn from(e: byteorm_client::GuildEmojis) -> Self {
        let url = format!("/cdn/emojis/{}.{}", e.id, e.extension);
        Self {
            id: e.id,
            guild_id: e.guild_id,
            name: e.name,
            animated: e.animated,
            creator_id: e.creator_id,
            url,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuildMember {
    pub id: i32,
    pub guild_id: String,
    pub user_id: String,
    pub nickname: Option<String>,
    #[serde(with = "chrono::serde::ts_milliseconds")]
    #[schema(value_type = i64, example = 1767225600000_i64)]
    pub joined_at: DateTime<Utc>,
    /// Ids of the roles the member holds, besides `@everyone`.
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub guild_id: String,
    #[serde(with = "chrono::serde::ts_milliseconds_option")]
    #[schema(value_type = Option<i64>)]
    pub created_at: Option<DateTime<Utc>>,
    pub rate_limit_per_user: i32,
    #[serde(rename = "type")]
    pub channel_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guild_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub author_id: String,
    pub channel_id: String,
    pub guild_id: String,
    pub content: Option<String>,
    #[serde(with = "chrono::serde::ts_milliseconds_option")]
    #[schema(value_type = Option<i64>)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(with = "chrono::serde::ts_milliseconds_option")]
    #[schema(value_type = Option<i64>)]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(rename = "type")]
    pub message_type: String,
    pub nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<User>,
    #[serde(skip)]
    pub reference_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_reference: Option<MessageReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[schema(no_recursion)]
    pub referenced_message: Option<Box<Message>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<crate::attachments::Attachment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub id: String,
    pub guild_id: String,
    pub code: String,
    pub uses: i32,
    pub max_uses: i32,
    pub creator_id: Option<String>,
    pub channel_id: String,
    pub vanity: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteResponse {
    #[serde(rename = "type")]
    pub invite_type: i32,
    pub code: String,
    pub inviter: Option<User>,
    pub guild: InviteGuild,
    pub guild_id: String,
    pub channel: InviteChannel,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct InviteGuild {
    pub id: String,
    pub name: String,
    pub brief: Option<String>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct InviteChannel {
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: i32,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Presence {
    pub id: String,
    pub status: String,
    /// Unix milliseconds when a temporary status ends; only sent to the user it belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
}

pub struct UserFlags;

pub const MANUAL_BADGES: [(&str, i32); 4] = [
    ("early_adopter", 1 << 0),
    ("contributor", 1 << 1),
    ("supporter", 1 << 2),
    ("bug_hunter", 1 << 3),
];

pub fn badge_bit(id: &str) -> Option<i32> {
    MANUAL_BADGES
        .iter()
        .find(|(n, _)| *n == id)
        .map(|(_, b)| *b)
}

pub fn badges_for(flags: i32, bits: i32) -> Vec<String> {
    let mut out = Vec::new();
    if flags & UserFlags::ADMIN != 0 {
        out.push("staff".to_string());
    }
    out.extend(
        MANUAL_BADGES
            .iter()
            .filter(|(_, bit)| bits & bit != 0)
            .map(|(name, _)| name.to_string()),
    );
    out
}

impl UserFlags {
    pub const ADMIN: i32 = 1 << 0;
}

impl From<byteorm_client::Users> for User {
    fn from(u: byteorm_client::Users) -> Self {
        let avatar = image_url("avatars", &u.id, u.avatar);
        let banner = image_url("banners", &u.id, u.banner);
        Self {
            id: u.id,
            username: u.username,
            tag: u.tag,
            created_at: u.created_at,
            bot: u.bot,
            flags: u.flags,
            bio: u.bio,
            badges: badges_for(u.flags, u.badges),
            custom_status: (u.custom_status.is_some() || u.custom_emoji.is_some()).then(|| {
                CustomStatus {
                    text: u.custom_status.clone(),
                    emoji: u.custom_emoji.clone(),
                    expires_at: u.custom_status_until.map(|t| t.timestamp_millis()),
                }
            }),
            avatar,
            banner,
        }
    }
}

/// Uploads are stored as a bare image id; a link someone pasted is kept as it is.
fn image_url(dir: &str, user_id: &str, value: Option<String>) -> Option<String> {
    value.map(|v| {
        if v.contains(':') || v.starts_with('/') {
            v
        } else {
            format!("/cdn/{dir}/{user_id}/{v}.webp")
        }
    })
}

impl From<byteorm_client::Guilds> for Guild {
    fn from(g: byteorm_client::Guilds) -> Self {
        Self {
            id: g.id,
            name: g.name,
            brief: g.brief,
            icon: g.icon,
            owner_id: g.owner_id,
            created_at: Some(g.created_at),
            channels: None,
            members: None,
            emojis: None,
            roles: None,
        }
    }
}

impl From<byteorm_client::Channels> for Channel {
    fn from(c: byteorm_client::Channels) -> Self {
        Self {
            id: c.id,
            name: c.name,
            guild_id: c.guild_id,
            created_at: Some(c.created_at),
            rate_limit_per_user: c.rate_limit_per_user,
            channel_type: c.channel_type.to_string(),
        }
    }
}

impl From<byteorm_client::GuildMembers> for GuildMember {
    fn from(m: byteorm_client::GuildMembers) -> Self {
        Self {
            id: m.id,
            guild_id: m.guild_id,
            user_id: m.user_id,
            nickname: m.nickname,
            joined_at: m.joined_at,
            roles: Vec::new(),
        }
    }
}

impl From<byteorm_client::Messages> for Message {
    fn from(m: byteorm_client::Messages) -> Self {
        let message_reference = m.reference_id.as_ref().map(|mid| MessageReference {
            message_id: Some(mid.clone()),
            channel_id: Some(m.channel_id.clone()),
            guild_id: Some(m.guild_id.clone()),
        });
        Self {
            id: m.id,
            author_id: m.author_id,
            channel_id: m.channel_id,
            guild_id: m.guild_id,
            content: m.content,
            created_at: Some(m.created_at),
            updated_at: m.updated_at,
            message_type: m.message_type.to_string(),
            nonce: Some(m.nonce),
            author: None,
            reference_id: m.reference_id,
            message_reference,
            referenced_message: None,
            attachments: Vec::new(),
        }
    }
}
