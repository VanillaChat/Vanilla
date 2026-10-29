use crate::auth::token::verify_token;
use crate::error::AppError;
use crate::state::SharedState;
use crate::voice::{
    MediaOut, MediaPeer, MediaSocket, VideoMeta, VoiceParticipant, VoiceQuality, now_ms,
};
use axum::{
    Json, Router,
    extract::{
        Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
    routing::{get, post},
};
use axum_extra::extract::CookieJar;
use byteorm_client::ChannelType;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use vanilla_voice::packet::{
    FLAG_FRAME_START, FLAG_KEYFRAME, HEADER_LEN, Header, KIND_AUDIO, KIND_VIDEO, Tag,
};

const MAX_MEDIA_MESSAGE: usize = 64 * 1024;
const MAX_CONTROL_MESSAGE: usize = 512;

pub fn router() -> Router<SharedState> {
    Router::new()
        .route(
            "/channels/{id}/voice",
            get(get_voice_state).patch(update_voice),
        )
        .route("/channels/{id}/voice/join", post(join_voice))
        .route("/channels/{id}/voice/leave", post(leave_voice))
        .route("/voice/media", get(media_ws))
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVoiceRequest {
    pub client_session_id: Option<String>,
    pub quality: Option<VoiceQuality>,
    pub self_mute: Option<bool>,
    pub self_deaf: Option<bool>,
    pub screen_sharing: Option<bool>,
    pub camera: Option<bool>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct JoinVoiceRequest {
    pub quality: Option<VoiceQuality>,
    pub self_mute: Option<bool>,
    pub self_deaf: Option<bool>,
    pub client_session_id: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LeaveVoiceRequest {
    pub client_session_id: Option<String>,
}

fn require_client_session_id(value: Option<String>) -> Result<String, AppError> {
    let value = value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(|| AppError::BadRequest("voice.errors.clientSessionRequired".to_string()))?;

    Ok(value)
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

async fn get_channel_and_member(
    state: &SharedState,
    channel_id: &str,
    user_id: &str,
) -> Result<(byteorm_client::Channels, byteorm_client::GuildMembers), AppError> {
    let channel = state
        .db
        .channels
        .find_first(|q| q.where_id(channel_id.to_string()))
        .await?
        .ok_or(AppError::NotFound("channels.notFound".to_string()))?;

    let member = state
        .db
        .guild_members
        .find_first(|q| {
            q.where_user_id(user_id.to_string())
                .where_guild_id(channel.guild_id.clone())
        })
        .await?
        .ok_or(AppError::Unauthorized)?;

    Ok((channel, member))
}

fn ensure_voice_channel(channel: &byteorm_client::Channels) -> Result<(), AppError> {
    if channel.channel_type != ChannelType::VOICE {
        return Err(AppError::BadRequest(
            "voice.errors.channelIsNotVoice".to_string(),
        ));
    }

    Ok(())
}

#[utoipa::path(
    get,
    path = "/channels/{id}/voice",
    tag = "Voice",
    summary = "Who is in a voice channel",
    params(("id" = String, Path, description = "Channel id")),
    responses(
    (status = 200, description = "Participants", body = crate::voice::VoiceChannelState),
    (status = 400, description = "Not a voice channel", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn get_voice_state(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    ensure_voice_channel(&channel)?;

    Ok(Json(state.voice.channel_state(
        channel.guild_id.clone(),
        channel.id.clone(),
    )))
}

#[utoipa::path(
    post,
    path = "/channels/{id}/voice/join",
    tag = "Voice",
    summary = "Join a voice channel",
    description = "Moves you out of any channel you were in. Broadcasts VOICE_STATE_UPDATE. Then open `/voice/media`.",
    params(("id" = String, Path, description = "Channel id")),
    request_body = JoinVoiceRequest,
    responses(
    (status = 200, description = "Participants", body = crate::voice::VoiceChannelState),
    (status = 400, description = "Not a voice channel or missing clientSessionId", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn join_voice(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<JoinVoiceRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    ensure_voice_channel(&channel)?;

    let quality = body.quality.unwrap_or_default();

    let client_session_id = require_client_session_id(body.client_session_id)?;

    let participant = VoiceParticipant {
        user_id: account.id.clone(),
        guild_id: channel.guild_id.clone(),
        channel_id: channel.id.clone(),
        client_session_id,
        ssrc: state.voice.alloc_ssrc(),
        quality,
        audio_format: quality.audio_format(),
        self_mute: body.self_mute.unwrap_or(false),
        self_deaf: body.self_deaf.unwrap_or(false),
        screen_sharing: false,
        camera: false,
        joined_at: now_ms(),
    };

    let previous = state.voice.join(participant.clone());

    if let Some(previous) = previous {
        if previous.channel_id != participant.channel_id {
            let leave_event = json!({
                "op": 0,
                "t": "VOICE_STATE_UPDATE",
                "d": {
                    "guildId": previous.guild_id,
                    "channelId": previous.channel_id,
                    "userId": previous.user_id,
                    "voiceState": null
                }
            });

            state.broadcast_to_room(&previous.guild_id, leave_event.to_string());
        }
    }

    let join_event = json!({
        "op": 0,
        "t": "VOICE_STATE_UPDATE",
        "d": {
            "guildId": participant.guild_id,
            "channelId": participant.channel_id,
            "userId": participant.user_id,
            "voiceState": participant
        }
    });

    state.broadcast_to_room(&channel.guild_id, join_event.to_string());

    Ok(Json(state.voice.channel_state(
        channel.guild_id.clone(),
        channel.id.clone(),
    )))
}

#[utoipa::path(
    post,
    path = "/channels/{id}/voice/leave",
    tag = "Voice",
    summary = "Leave a voice channel",
    params(("id" = String, Path, description = "Channel id")),
    request_body = LeaveVoiceRequest,
    responses(
    (status = 200, description = "Participants", body = crate::voice::VoiceChannelState),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn leave_voice(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<LeaveVoiceRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    ensure_voice_channel(&channel)?;

    let client_session_id = require_client_session_id(body.client_session_id)?;

    if let Some(participant) =
        state
            .voice
            .leave_channel_session(&account.id, &channel.id, &client_session_id)
    {
        let leave_event = json!({
            "op": 0,
            "t": "VOICE_STATE_UPDATE",
            "d": {
                "guildId": participant.guild_id,
                "channelId": participant.channel_id,
                "userId": participant.user_id,
                "voiceState": null
            }
        });

        state.broadcast_to_room(&participant.guild_id, leave_event.to_string());
    }

    Ok(Json(state.voice.channel_state(
        channel.guild_id.clone(),
        channel.id.clone(),
    )))
}

#[utoipa::path(
    patch,
    path = "/channels/{id}/voice",
    tag = "Voice",
    summary = "Change your voice state",
    description = "Deafening also mutes. Broadcasts VOICE_STATE_UPDATE.",
    params(("id" = String, Path, description = "Channel id")),
    request_body = UpdateVoiceRequest,
    responses(
    (status = 200, description = "Participants", body = crate::voice::VoiceChannelState),
    (status = 400, description = "Not joined", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn update_voice(
    State(state): State<SharedState>,
    jar: CookieJar,
    Path(channel_id): Path<String>,
    Json(body): Json<UpdateVoiceRequest>,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;
    let (channel, _member) = get_channel_and_member(&state, &channel_id, &account.id).await?;
    ensure_voice_channel(&channel)?;

    let client_session_id = require_client_session_id(body.client_session_id)?;

    let updated = state
        .voice
        .update(&account.id, &channel.id, &client_session_id, |p| {
            if let Some(quality) = body.quality {
                p.quality = quality;
                p.audio_format = quality.audio_format();
            }
            if let Some(v) = body.self_mute {
                p.self_mute = v;
            }
            if let Some(v) = body.self_deaf {
                p.self_deaf = v;
                // Deafening implies muting, like Discord.
                if v {
                    p.self_mute = true;
                }
            }
            if let Some(v) = body.screen_sharing {
                p.screen_sharing = v;
            }
            if let Some(v) = body.camera {
                p.camera = v;
            }
        })
        .ok_or(AppError::BadRequest("voice.errors.notJoined".to_string()))?;

    let event = json!({
        "op": 0,
        "t": "VOICE_STATE_UPDATE",
        "d": {
            "guildId": updated.guild_id,
            "channelId": updated.channel_id,
            "userId": updated.user_id,
            "voiceState": updated
        }
    });
    state.broadcast_to_room(&channel.guild_id, event.to_string());

    Ok(Json(state.voice.channel_state(
        channel.guild_id.clone(),
        channel.id.clone(),
    )))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
#[into_params(parameter_in = Query)]
pub(crate) struct MediaQuery {
    channel_id: String,
    client_session_id: String,
    /// "audio" (default) or "video".
    socket: Option<String>,
}

#[utoipa::path(
    get,
    path = "/voice/media",
    tag = "Voice",
    summary = "Media WebSocket",
    description = "Upgrades to a WebSocket that carries binary audio and video packets plus small JSON control messages. `socket` is `audio` (default) or `video`.",
    params(MediaQuery),
    responses(
    (status = 101, description = "Switching protocols"),
    (status = 401, description = "No matching voice session", body = crate::openapi::ErrorBody),
    (status = 401, description = "Not signed in", body = crate::openapi::ErrorBody)
),
    security(("cookie" = [])),
)]
pub(crate) async fn media_ws(
    State(state): State<SharedState>,
    jar: CookieJar,
    Query(query): Query<MediaQuery>,
    ws: WebSocketUpgrade,
) -> Result<impl IntoResponse, AppError> {
    let account = get_current_user(&state, &jar).await?;

    let participant = state
        .voice
        .participant(&account.id)
        .filter(|p| {
            p.channel_id == query.channel_id && p.client_session_id == query.client_session_id
        })
        .ok_or(AppError::Unauthorized)?;

    let socket = match query.socket.as_deref() {
        None | Some("audio") => MediaSocket::Audio,
        Some("video") => MediaSocket::Video,
        Some(_) => return Err(AppError::BadRequest("voice.errors.badSocket".to_string())),
    };

    Ok(ws
        .max_message_size(MAX_MEDIA_MESSAGE)
        .max_frame_size(MAX_MEDIA_MESSAGE)
        .on_upgrade(move |socket_io| run_media_socket(socket_io, state, participant, socket)))
}

async fn run_media_socket(
    socket: WebSocket,
    state: SharedState,
    me: VoiceParticipant,
    kind: MediaSocket,
) {
    let (peer, mut rx) = state.voice.register_media(&me, kind);
    let weak_peer = Arc::downgrade(&peer);
    // The registry owns the peer; once it is unregistered the queue closes and
    // the writer below ends, which tears the whole socket down.
    drop(peer);

    let (mut sink, mut stream) = socket.split();

    let write = async {
        while let Some(item) = rx.recv().await {
            let msg = match item {
                MediaOut::Binary(bytes) => Message::Binary(bytes),
                MediaOut::Text(text) => Message::Text(text.into()),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    };

    let read = async {
        while let Some(Ok(msg)) = stream.next().await {
            let Some(peer) = weak_peer.upgrade() else {
                break;
            };
            match (kind, msg) {
                (_, Message::Close(_)) => break,
                (MediaSocket::Audio, Message::Binary(data)) => {
                    handle_audio_packet(&state, &me, &peer, data)
                }
                (MediaSocket::Video, Message::Binary(data)) => {
                    handle_video_packet(&state, &me, &peer, data)
                }
                (MediaSocket::Audio, Message::Text(text)) => {
                    handle_audio_control(&state, &me, &peer, text.as_str())
                }
                (MediaSocket::Video, Message::Text(text)) => {
                    handle_video_control(&state, &me, &peer, text.as_str())
                }
                _ => {}
            }
        }
    };

    tokio::select! {
        _ = write => {}
        _ = read => {}
    }

    if let Some(peer) = weak_peer.upgrade() {
        state
            .voice
            .unregister_media_if(&me.channel_id, me.ssrc, &peer);
    }
}

/// Validates the packet header; a client may only send under the ssrc it was
/// given on join.
fn parse_owned_header(me: &VoiceParticipant, data: &[u8], kind: u8) -> Option<Header> {
    if data.len() < HEADER_LEN || data.len() > MAX_MEDIA_MESSAGE {
        return None;
    }
    let header = Header::parse(data).ok()?;
    (header.ssrc == me.ssrc && header.kind == kind).then_some(header)
}

fn handle_audio_packet(
    state: &SharedState,
    me: &VoiceParticipant,
    peer: &Arc<MediaPeer>,
    data: axum::body::Bytes,
) {
    let Some(header) = parse_owned_header(me, &data, KIND_AUDIO) else {
        return;
    };
    // Muted microphones send nothing, but enforce it server side too.
    if header.tag == Tag::Mic && peer.muted.load(Ordering::Relaxed) {
        return;
    }
    state.voice.relay_audio(
        &me.channel_id,
        me.ssrc,
        data,
        header.codec,
        header.layer(),
        now_ms(),
    );
}

fn handle_video_packet(
    state: &SharedState,
    me: &VoiceParticipant,
    peer: &Arc<MediaPeer>,
    data: axum::body::Bytes,
) {
    let Some(header) = parse_owned_header(me, &data, KIND_VIDEO) else {
        return;
    };
    // Only sharing participants may publish video.
    let allowed = match header.tag {
        Tag::ScreenVideo => peer.screen_sharing.load(Ordering::Relaxed),
        Tag::Camera => peer.camera.load(Ordering::Relaxed),
        _ => false,
    };
    if !allowed {
        return;
    }

    let tag = header.tag as usize;
    peer.note_video_layer(tag, header.layer());
    let meta = VideoMeta {
        tag,
        layer: header.layer(),
        key_start: header.flags & FLAG_KEYFRAME != 0 && header.flags & FLAG_FRAME_START != 0,
    };
    let layers = peer.video_layers[tag & 3].load(Ordering::Relaxed);
    let wanted = state
        .voice
        .relay_video(&me.channel_id, me.ssrc, data, meta, layers, now_ms());

    // A viewer moved to another layer: its sender must key that layer.
    for layer in wanted {
        let pli = json!({ "t": "pli", "target": me.ssrc, "layer": layer });
        state
            .voice
            .send_control(&me.channel_id, me.ssrc, pli.to_string());
    }
}

/// Small JSON control channel: latency pings plus receiver feedback
/// (`report`, `pli`) that is relayed to the sender named in `target`, and the
/// `loopback` self-test switch.
fn handle_audio_control(
    state: &SharedState,
    me: &VoiceParticipant,
    peer: &Arc<MediaPeer>,
    text: &str,
) {
    if text.len() > MAX_CONTROL_MESSAGE {
        return;
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    match value.get("t").and_then(|t| t.as_str()) {
        Some("ping") => {
            let pong = json!({ "t": "pong", "n": value.get("n") });
            state
                .voice
                .send_control(&me.channel_id, me.ssrc, pong.to_string());
        }
        Some("loopback") => {
            let on = value.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
            peer.loopback.store(on, Ordering::Relaxed);
        }
        Some("report") | Some("pli") => {
            let Some(target) = target_ssrc(&value) else {
                return;
            };
            value["from"] = json!(me.ssrc);
            state
                .voice
                .send_control(&me.channel_id, target, value.to_string());
        }
        _ => {}
    }
}

/// Video socket control: `watch` starts/stops delivery of a sharer's video and
/// asks the sharer for a fresh keyframe.
fn handle_video_control(
    state: &SharedState,
    me: &VoiceParticipant,
    peer: &Arc<MediaPeer>,
    text: &str,
) {
    if text.len() > MAX_CONTROL_MESSAGE {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    if value.get("t").and_then(|t| t.as_str()) != Some("watch") {
        return;
    }
    let Some(target) = target_ssrc(&value) else {
        return;
    };
    let on = value.get("on").and_then(|v| v.as_bool()).unwrap_or(true);
    let layer = peer.set_watching(target, on);
    if let Some(layer) = layer.filter(|_| on) {
        let pli = json!({ "t": "pli", "from": me.ssrc, "target": target, "layer": layer });
        state
            .voice
            .send_control(&me.channel_id, target, pli.to_string());
    }
}

fn target_ssrc(value: &serde_json::Value) -> Option<u32> {
    value
        .get("target")
        .and_then(|t| t.as_u64())
        .and_then(|t| u32::try_from(t).ok())
}
