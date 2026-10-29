use crate::voice_adapt::{AudioTier, TierState, WatchState};
use axum::body::Bytes;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use vanilla_voice::packet::Codec;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VoiceQuality {
    Auto,
    VoiceLossless,
    StudioLossless,
    MusicLossless,
}

impl Default for VoiceQuality {
    fn default() -> Self {
        Self::VoiceLossless
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceAudioFormat {
    pub sample_rate: u32,
    pub bit_depth: u8,
    pub channels: u8,
    pub estimated_bitrate_bps: u32,
}

impl VoiceQuality {
    pub fn audio_format(self) -> VoiceAudioFormat {
        match self {
            VoiceQuality::Auto => VoiceAudioFormat {
                sample_rate: 48_000,
                bit_depth: 16,
                channels: 1,
                estimated_bitrate_bps: 64_000,
            },
            VoiceQuality::VoiceLossless => VoiceAudioFormat {
                sample_rate: 48_000,
                bit_depth: 16,
                channels: 1,
                estimated_bitrate_bps: 768_000,
            },
            VoiceQuality::StudioLossless => VoiceAudioFormat {
                sample_rate: 48_000,
                bit_depth: 24,
                channels: 1,
                estimated_bitrate_bps: 1_152_000,
            },
            VoiceQuality::MusicLossless => VoiceAudioFormat {
                sample_rate: 48_000,
                bit_depth: 16,
                channels: 2,
                estimated_bitrate_bps: 1_536_000,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceParticipant {
    pub user_id: String,
    pub guild_id: String,
    pub channel_id: String,
    pub client_session_id: String,
    pub ssrc: u32,
    pub quality: VoiceQuality,
    pub audio_format: VoiceAudioFormat,
    pub self_mute: bool,
    pub self_deaf: bool,
    pub screen_sharing: bool,
    pub camera: bool,
    pub joined_at: i64,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChannelState {
    pub guild_id: String,
    pub channel_id: String,
    pub participants: Vec<VoiceParticipant>,
}

pub enum MediaOut {
    Binary(Bytes),
    Text(String),
}

/// Audio and video travel over separate sockets (separate TCP connections) so
/// a large video keyframe can never delay audio. Both queues are bounded:
/// when a receiver is slow, stale packets are dropped instead of piling up as
/// latency.
const AUDIO_QUEUE: usize = 64;
const VIDEO_QUEUE: usize = 256;
const AUDIO_PRESSURE: usize = 16;
const VIDEO_PRESSURE: usize = 64;

#[derive(Debug, Clone, Copy)]
pub struct VideoMeta {
    pub tag: usize,
    pub layer: u8,
    /// First packet of a keyframe: the only place a layer switch is legal.
    pub key_start: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MediaSocket {
    Audio,
    Video,
}

pub struct MediaPeer {
    pub user_id: String,
    pub client_session_id: String,
    pub socket: MediaSocket,
    pub muted: AtomicBool,
    pub deafened: AtomicBool,
    pub screen_sharing: AtomicBool,
    pub camera: AtomicBool,
    pub loopback: AtomicBool,
    pub video_layers: [AtomicU8; 4],
    tier: Mutex<TierState>,
    watching: Mutex<HashMap<u32, WatchState>>,
    tx: mpsc::Sender<MediaOut>,
}

impl MediaPeer {
    pub fn set_watching(&self, ssrc: u32, on: bool) -> Option<u8> {
        let mut watching = self.watching.lock().unwrap();
        if !on {
            watching.remove(&ssrc);
            return None;
        }
        if watching.len() >= 64 && !watching.contains_key(&ssrc) {
            return None;
        }
        let state = WatchState::new();
        let want = state.want();
        watching.insert(ssrc, state);
        Some(want)
    }

    pub fn note_video_layer(&self, tag: usize, layer: u8) {
        self.video_layers[tag & 3].fetch_or(1 << (layer & 3), Ordering::Relaxed);
    }

    pub fn audio_tier(&self) -> AudioTier {
        self.tier.lock().unwrap().tier()
    }
}

fn tier_message(tier: AudioTier) -> MediaOut {
    MediaOut::Text(format!(r#"{{"t":"tier","tier":"{}"}}"#, tier.as_str()))
}

#[derive(Default)]
pub struct VoiceState {
    participants_by_user: DashMap<String, VoiceParticipant>,
    media: DashMap<String, DashMap<(u32, MediaSocket), Arc<MediaPeer>>>,
    next_ssrc: AtomicU32,
}

impl std::fmt::Debug for VoiceState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VoiceState").finish_non_exhaustive()
    }
}

impl VoiceState {
    pub fn alloc_ssrc(&self) -> u32 {
        loop {
            let v = self
                .next_ssrc
                .fetch_add(1, Ordering::Relaxed)
                .wrapping_add(1);
            if v != 0 {
                return v;
            }
        }
    }

    pub fn join(&self, participant: VoiceParticipant) -> Option<VoiceParticipant> {
        let previous = self
            .participants_by_user
            .insert(participant.user_id.clone(), participant);
        if let Some(prev) = &previous {
            self.unregister_media(&prev.channel_id, prev.ssrc);
        }
        previous
    }

    pub fn leave_user(&self, user_id: &str) -> Option<VoiceParticipant> {
        let removed = self
            .participants_by_user
            .remove(user_id)
            .map(|(_, participant)| participant);
        self.drop_media_of(&removed);
        removed
    }

    pub fn leave_session(
        &self,
        user_id: &str,
        client_session_id: &str,
    ) -> Option<VoiceParticipant> {
        let removed = self
            .participants_by_user
            .remove_if(user_id, |_user_id, current| {
                current.client_session_id == client_session_id
            })
            .map(|(_, participant)| participant);
        self.drop_media_of(&removed);
        removed
    }

    pub fn leave_channel_session(
        &self,
        user_id: &str,
        channel_id: &str,
        client_session_id: &str,
    ) -> Option<VoiceParticipant> {
        let removed = self
            .participants_by_user
            .remove_if(user_id, |_user_id, current| {
                current.channel_id == channel_id && current.client_session_id == client_session_id
            })
            .map(|(_, participant)| participant);
        self.drop_media_of(&removed);
        removed
    }

    pub fn leave_channel(&self, user_id: &str, channel_id: &str) -> Option<VoiceParticipant> {
        let removed = self
            .participants_by_user
            .remove_if(user_id, |_user_id, current| {
                current.channel_id == channel_id
            })
            .map(|(_, participant)| participant);
        self.drop_media_of(&removed);
        removed
    }

    fn drop_media_of(&self, participant: &Option<VoiceParticipant>) {
        if let Some(p) = participant {
            self.unregister_media(&p.channel_id, p.ssrc);
        }
    }

    pub fn participant(&self, user_id: &str) -> Option<VoiceParticipant> {
        self.participants_by_user
            .get(user_id)
            .map(|entry| entry.value().clone())
    }

    pub fn update(
        &self,
        user_id: &str,
        channel_id: &str,
        client_session_id: &str,
        f: impl FnOnce(&mut VoiceParticipant),
    ) -> Option<VoiceParticipant> {
        let mut entry = self.participants_by_user.get_mut(user_id)?;
        if entry.channel_id != channel_id || entry.client_session_id != client_session_id {
            return None;
        }
        f(&mut entry);
        let updated = entry.clone();
        drop(entry);

        if let Some(peers) = self.media.get(channel_id) {
            for socket in [MediaSocket::Audio, MediaSocket::Video] {
                if let Some(peer) = peers.get(&(updated.ssrc, socket)) {
                    peer.muted.store(updated.self_mute, Ordering::Relaxed);
                    peer.deafened.store(updated.self_deaf, Ordering::Relaxed);
                    peer.screen_sharing
                        .store(updated.screen_sharing, Ordering::Relaxed);
                    peer.camera.store(updated.camera, Ordering::Relaxed);
                    if !updated.screen_sharing {
                        peer.video_layers[2].store(0, Ordering::Relaxed);
                    }
                    if !updated.camera {
                        peer.video_layers[3].store(0, Ordering::Relaxed);
                    }
                }
            }
        }
        Some(updated)
    }

    pub fn register_media(
        &self,
        participant: &VoiceParticipant,
        socket: MediaSocket,
    ) -> (Arc<MediaPeer>, mpsc::Receiver<MediaOut>) {
        let capacity = match socket {
            MediaSocket::Audio => AUDIO_QUEUE,
            MediaSocket::Video => VIDEO_QUEUE,
        };
        let (tx, rx) = mpsc::channel(capacity);
        let peer = Arc::new(MediaPeer {
            user_id: participant.user_id.clone(),
            client_session_id: participant.client_session_id.clone(),
            socket,
            muted: AtomicBool::new(participant.self_mute),
            deafened: AtomicBool::new(participant.self_deaf),
            screen_sharing: AtomicBool::new(participant.screen_sharing),
            camera: AtomicBool::new(participant.camera),
            loopback: AtomicBool::new(false),
            video_layers: Default::default(),
            tier: Mutex::new(TierState::default()),
            watching: Mutex::new(HashMap::new()),
            tx,
        });
        self.media
            .entry(participant.channel_id.clone())
            .or_default()
            .insert((participant.ssrc, socket), peer.clone());
        (peer, rx)
    }

    pub fn unregister_media(&self, channel_id: &str, ssrc: u32) {
        if let Some(peers) = self.media.get(channel_id) {
            peers.remove(&(ssrc, MediaSocket::Audio));
            peers.remove(&(ssrc, MediaSocket::Video));
        }
        self.media
            .remove_if(channel_id, |_, peers| peers.is_empty());
    }

    /// Only unregister if `peer` is still the registered one (a newer socket
    /// for the same ssrc must not be torn down by an older one closing).
    pub fn unregister_media_if(&self, channel_id: &str, ssrc: u32, peer: &Arc<MediaPeer>) {
        if let Some(peers) = self.media.get(channel_id) {
            peers.remove_if(&(ssrc, peer.socket), |_, current| {
                Arc::ptr_eq(current, peer)
            });
        }
        self.media
            .remove_if(channel_id, |_, peers| peers.is_empty());
    }

    pub fn relay_audio(
        &self,
        channel_id: &str,
        from_ssrc: u32,
        data: Bytes,
        codec: Codec,
        layer: u8,
        now: i64,
    ) {
        let Some(peers) = self.media.get(channel_id) else {
            return;
        };
        for entry in peers.iter() {
            let (ssrc, socket) = *entry.key();
            let peer = entry.value();
            let own = ssrc == from_ssrc;
            if socket != MediaSocket::Audio
                || peer.deafened.load(Ordering::Relaxed)
                || (own && !peer.loopback.load(Ordering::Relaxed))
            {
                continue;
            }

            let mut tier = peer.tier.lock().unwrap();
            let mut changed = tier.tick(now);
            if tier.tier().accepts(codec, layer) {
                let queued = peer.tx.max_capacity() - peer.tx.capacity();
                let full = peer.tx.try_send(MediaOut::Binary(data.clone())).is_err();
                if tier.tier() == AudioTier::Best {
                    if let Some(next) = tier.record(now, full || queued > AUDIO_PRESSURE) {
                        changed = Some(next);
                    }
                }
            }
            drop(tier);

            if let Some(next) = changed {
                let _ = peer.tx.try_send(tier_message(next));
            }
        }
    }

    pub fn relay_video(
        &self,
        channel_id: &str,
        from_ssrc: u32,
        data: Bytes,
        meta: VideoMeta,
        layers: u8,
        now: i64,
    ) -> Vec<u8> {
        let mut keyframes = Vec::new();
        let Some(peers) = self.media.get(channel_id) else {
            return keyframes;
        };
        for entry in peers.iter() {
            let (ssrc, socket) = *entry.key();
            let peer = entry.value();
            if ssrc == from_ssrc || socket != MediaSocket::Video {
                continue;
            }
            let mut watching = peer.watching.lock().unwrap();
            let Some(state) = watching.get_mut(&from_ssrc) else {
                continue;
            };

            let queued = peer.tx.max_capacity() - peer.tx.capacity();
            let changed = if queued > VIDEO_PRESSURE {
                state.on_pressure(now)
            } else if queued < VIDEO_PRESSURE / 4 {
                state.on_healthy(now)
            } else {
                false
            };
            if changed {
                if let Some(layer) = state.target_for(layers) {
                    keyframes.push(layer);
                }
            }

            if state.route(meta.tag, meta.layer, meta.key_start, layers)
                && peer.tx.try_send(MediaOut::Binary(data.clone())).is_err()
                && state.on_pressure(now)
            {
                if let Some(layer) = state.target_for(layers) {
                    keyframes.push(layer);
                }
            }
        }
        keyframes.sort_unstable();
        keyframes.dedup();
        keyframes
    }

    pub fn send_control(&self, channel_id: &str, target_ssrc: u32, text: String) {
        if let Some(peers) = self.media.get(channel_id) {
            if let Some(peer) = peers.get(&(target_ssrc, MediaSocket::Audio)) {
                let _ = peer.tx.try_send(MediaOut::Text(text));
            }
        }
    }

    pub fn channel_state(&self, guild_id: String, channel_id: String) -> VoiceChannelState {
        let participants = self
            .participants_by_user
            .iter()
            .filter(|entry| entry.guild_id == guild_id && entry.channel_id == channel_id)
            .map(|entry| entry.value().clone())
            .collect();

        VoiceChannelState {
            guild_id,
            channel_id,
            participants,
        }
    }

    pub fn participants_for_guilds(&self, guild_ids: &[String]) -> Vec<VoiceParticipant> {
        let guilds: HashSet<&str> = guild_ids.iter().map(String::as_str).collect();

        self.participants_by_user
            .iter()
            .filter(|entry| guilds.contains(entry.guild_id.as_str()))
            .map(|entry| entry.value().clone())
            .collect()
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(user: &str, channel: &str, state: &VoiceState) -> VoiceParticipant {
        VoiceParticipant {
            user_id: user.into(),
            guild_id: "g".into(),
            channel_id: channel.into(),
            client_session_id: format!("s-{user}"),
            ssrc: state.alloc_ssrc(),
            quality: VoiceQuality::Auto,
            audio_format: VoiceQuality::Auto.audio_format(),
            self_mute: false,
            self_deaf: false,
            screen_sharing: false,
            camera: false,
            joined_at: 0,
        }
    }

    fn binary(out: MediaOut) -> Bytes {
        match out {
            MediaOut::Binary(b) => b,
            MediaOut::Text(_) => panic!("expected binary"),
        }
    }

    fn joined(voice: &VoiceState, user: &str, channel: &str) -> VoiceParticipant {
        let p = participant(user, channel, voice);
        voice.join(p.clone());
        p
    }

    fn audio(
        voice: &VoiceState,
        from: u32,
        body: &'static [u8],
        codec: Codec,
        layer: u8,
        now: i64,
    ) {
        voice.relay_audio("c1", from, Bytes::from_static(body), codec, layer, now);
    }

    fn drain_binary(rx: &mut mpsc::Receiver<MediaOut>) -> Vec<Bytes> {
        let mut out = Vec::new();
        while let Ok(item) = rx.try_recv() {
            if let MediaOut::Binary(b) = item {
                out.push(b);
            }
        }
        out
    }

    fn drain_text(rx: &mut mpsc::Receiver<MediaOut>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(item) = rx.try_recv() {
            if let MediaOut::Text(t) = item {
                out.push(t);
            }
        }
        out
    }

    #[test]
    fn relays_audio_to_others_only_and_respects_deafen() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let b = joined(&voice, "b", "c1");
        let c = joined(&voice, "c", "c2");
        let (_pa, mut ra) = voice.register_media(&a, MediaSocket::Audio);
        let (_pb, mut rb) = voice.register_media(&b, MediaSocket::Audio);
        let (_pc, mut rc) = voice.register_media(&c, MediaSocket::Audio);

        audio(&voice, a.ssrc, b"hi", Codec::Lossless, 0, 0);
        assert_eq!(binary(rb.try_recv().unwrap()), Bytes::from_static(b"hi"));
        assert!(ra.try_recv().is_err(), "sender must not hear itself");
        assert!(rc.try_recv().is_err(), "other channel must not receive");

        voice
            .update("b", "c1", "s-b", |p| p.self_deaf = true)
            .unwrap();
        audio(&voice, a.ssrc, b"x", Codec::Lossless, 0, 0);
        assert!(rb.try_recv().is_err(), "deafened peer gets no audio");
    }

    #[test]
    fn loopback_echoes_own_audio_only_when_enabled() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let (pa, mut ra) = voice.register_media(&a, MediaSocket::Audio);

        audio(&voice, a.ssrc, b"1", Codec::Lossless, 0, 0);
        assert!(ra.try_recv().is_err());

        pa.loopback.store(true, Ordering::Relaxed);
        audio(&voice, a.ssrc, b"2", Codec::Lossless, 0, 0);
        assert_eq!(binary(ra.try_recv().unwrap()), Bytes::from_static(b"2"));
    }

    #[test]
    fn best_receiver_gets_lossless_and_ignores_the_opus_copy() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let b = joined(&voice, "b", "c1");
        let (_pa, _ra) = voice.register_media(&a, MediaSocket::Audio);
        let (_pb, mut rb) = voice.register_media(&b, MediaSocket::Audio);

        audio(&voice, a.ssrc, b"lossless", Codec::Lossless, 0, 0);
        audio(&voice, a.ssrc, b"opus", Codec::Opus, 1, 0);
        assert_eq!(drain_binary(&mut rb), vec![Bytes::from_static(b"lossless")]);
    }

    #[test]
    fn slow_audio_receiver_is_moved_to_opus_without_affecting_others() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let slow = joined(&voice, "slow", "c1");
        let fast = joined(&voice, "fast", "c1");
        let (_pa, _ra) = voice.register_media(&a, MediaSocket::Audio);
        let (pslow, mut rslow) = voice.register_media(&slow, MediaSocket::Audio);
        let (pfast, mut rfast) = voice.register_media(&fast, MediaSocket::Audio);

        let mut now = 0;
        for _ in 0..40 {
            audio(&voice, a.ssrc, b"L", Codec::Lossless, 0, now);
            audio(&voice, a.ssrc, b"O", Codec::Opus, 1, now);
            drain_binary(&mut rfast);
            now += 5;
        }
        assert_eq!(pslow.audio_tier(), AudioTier::Safe);
        assert_eq!(pfast.audio_tier(), AudioTier::Best);
        assert!(
            drain_text(&mut rslow)
                .iter()
                .any(|t| t.contains(r#""tier":"safe""#)),
            "the slow client is told it was moved"
        );

        while rslow.try_recv().is_ok() {}
        audio(&voice, a.ssrc, b"L", Codec::Lossless, 0, now);
        audio(&voice, a.ssrc, b"O", Codec::Opus, 1, now);
        assert_eq!(drain_binary(&mut rslow), vec![Bytes::from_static(b"O")]);
        assert_eq!(drain_binary(&mut rfast), vec![Bytes::from_static(b"L")]);
    }

    #[test]
    fn video_goes_only_to_watchers_on_the_video_socket() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let b = joined(&voice, "b", "c1");
        let c = joined(&voice, "c", "c1");
        let (_pa, _ra) = voice.register_media(&a, MediaSocket::Video);
        let (pb, mut rb) = voice.register_media(&b, MediaSocket::Video);
        let (_pc, mut rc) = voice.register_media(&c, MediaSocket::Video);
        let (_pba, mut rba) = voice.register_media(&b, MediaSocket::Audio);

        let key = VideoMeta {
            tag: 2,
            layer: 0,
            key_start: true,
        };
        let delta = VideoMeta {
            tag: 2,
            layer: 0,
            key_start: false,
        };

        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"v0"), key, 0b1, 0);
        assert!(rb.try_recv().is_err(), "nobody watches yet");

        assert_eq!(pb.set_watching(a.ssrc, true), Some(0));
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"d"), delta, 0b1, 0);
        assert!(rb.try_recv().is_err(), "a new watcher waits for a keyframe");
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"k"), key, 0b1, 0);
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"d"), delta, 0b1, 0);
        assert_eq!(
            drain_binary(&mut rb),
            vec![Bytes::from_static(b"k"), Bytes::from_static(b"d")]
        );
        assert!(rc.try_recv().is_err(), "non-watcher gets nothing");
        assert!(rba.try_recv().is_err(), "audio socket never carries video");

        pb.set_watching(a.ssrc, false);
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"v2"), key, 0b1, 0);
        assert!(rb.try_recv().is_err());
    }

    #[test]
    fn slow_viewer_is_moved_to_a_smaller_layer_and_the_sender_is_asked_for_a_keyframe() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let slow = joined(&voice, "slow", "c1");
        let fast = joined(&voice, "fast", "c1");
        let (_pa, _ra) = voice.register_media(&a, MediaSocket::Video);
        let (pslow, mut rslow) = voice.register_media(&slow, MediaSocket::Video);
        let (pfast, mut rfast) = voice.register_media(&fast, MediaSocket::Video);
        pslow.set_watching(a.ssrc, true);
        pfast.set_watching(a.ssrc, true);

        let key = |layer| VideoMeta {
            tag: 2,
            layer,
            key_start: true,
        };
        let delta = |layer| VideoMeta {
            tag: 2,
            layer,
            key_start: false,
        };
        let mask = 0b111;

        for layer in 0..3 {
            voice.relay_video("c1", a.ssrc, Bytes::from_static(b"K"), key(layer), mask, 0);
        }
        assert_eq!(drain_binary(&mut rslow).len(), 1);
        assert_eq!(drain_binary(&mut rfast).len(), 1);

        let mut asked = Vec::new();
        let mut now = 2_000;
        for _ in 0..(VIDEO_PRESSURE + 20) {
            asked.extend(voice.relay_video(
                "c1",
                a.ssrc,
                Bytes::from_static(b"d"),
                delta(0),
                mask,
                now,
            ));
            drain_binary(&mut rfast);
            now += 10;
        }
        assert!(
            asked.contains(&1),
            "sender is asked for a layer-1 keyframe: {asked:?}"
        );

        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"x"), delta(1), mask, now);
        while rslow.try_recv().is_ok() {}
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"K1"), key(1), mask, now);
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"d0"), delta(0), mask, now);
        voice.relay_video("c1", a.ssrc, Bytes::from_static(b"d1"), delta(1), mask, now);
        assert_eq!(
            drain_binary(&mut rslow),
            vec![Bytes::from_static(b"K1"), Bytes::from_static(b"d1")]
        );
        assert_eq!(drain_binary(&mut rfast), vec![Bytes::from_static(b"d0")]);
    }

    #[test]
    fn leaving_closes_media_queues_and_rejoin_replaces() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let (peer, mut ra) = voice.register_media(&a, MediaSocket::Audio);
        drop(peer);

        voice.leave_user("a").unwrap();
        assert!(matches!(
            ra.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));

        let first = joined(&voice, "a", "c1");
        let (p1, mut r1) = voice.register_media(&first, MediaSocket::Audio);
        drop(p1);
        let _second = joined(&voice, "a", "c2");
        assert!(matches!(
            r1.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }

    #[test]
    fn update_requires_matching_session() {
        let voice = VoiceState::default();
        joined(&voice, "a", "c1");
        assert!(
            voice
                .update("a", "c1", "other", |p| p.self_mute = true)
                .is_none()
        );
        assert!(
            voice
                .update("a", "c2", "s-a", |p| p.self_mute = true)
                .is_none()
        );
        let updated = voice
            .update("a", "c1", "s-a", |p| p.self_mute = true)
            .unwrap();
        assert!(updated.self_mute);
    }

    #[test]
    fn update_propagates_flags_and_forgets_layers_of_stopped_streams() {
        let voice = VoiceState::default();
        let a = joined(&voice, "a", "c1");
        let (peer, _rx) = voice.register_media(&a, MediaSocket::Video);
        assert!(!peer.screen_sharing.load(Ordering::Relaxed));
        voice
            .update("a", "c1", "s-a", |p| p.screen_sharing = true)
            .unwrap();
        assert!(peer.screen_sharing.load(Ordering::Relaxed));

        peer.note_video_layer(2, 0);
        peer.note_video_layer(2, 2);
        assert_eq!(peer.video_layers[2].load(Ordering::Relaxed), 0b101);
        voice
            .update("a", "c1", "s-a", |p| p.screen_sharing = false)
            .unwrap();
        assert_eq!(peer.video_layers[2].load(Ordering::Relaxed), 0);
    }

    #[test]
    fn ssrc_unique_and_nonzero() {
        let voice = VoiceState::default();
        let mut seen = HashSet::new();
        for _ in 0..1000 {
            let v = voice.alloc_ssrc();
            assert_ne!(v, 0);
            assert!(seen.insert(v));
        }
    }
}
