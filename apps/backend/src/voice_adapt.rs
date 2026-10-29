//! Per-receiver adaptation. The server never transcodes: senders publish
//! several versions of a stream and these state machines pick, for each
//! receiver separately, the version its connection can sustain.
//!
//! All timestamps are passed in (milliseconds) so the logic is deterministic
//! and unit-testable.

use vanilla_voice::packet::Codec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioTier {
    Best,
    Safe,
}

impl AudioTier {
    pub fn as_str(self) -> &'static str {
        match self {
            AudioTier::Best => "best",
            AudioTier::Safe => "safe",
        }
    }

    /// A lossless sender emits layer 0 (lossless) plus layer 1 (Opus); an Opus
    /// sender emits only layer 0 (Opus), which both tiers can use.
    pub fn accepts(self, codec: Codec, layer: u8) -> bool {
        match self {
            AudioTier::Best => layer == 0,
            AudioTier::Safe => codec == Codec::Opus,
        }
    }
}

const WINDOW_MS: i64 = 1_000;
const PRESSURE_EVENTS: u32 = 3;
const START_BACKOFF_MS: i64 = 15_000;
const MAX_BACKOFF_MS: i64 = 120_000;
const PROBE_MS: i64 = 5_000;

/// Drops a receiver to the safe tier when its queue keeps backing up, then
/// retries the best tier after a growing back-off.
#[derive(Debug)]
pub struct TierState {
    tier: AudioTier,
    safe_since: i64,
    probing_until: i64,
    backoff_ms: i64,
    window_start: i64,
    pressure: u32,
}

impl Default for TierState {
    fn default() -> Self {
        Self {
            tier: AudioTier::Best,
            safe_since: 0,
            probing_until: 0,
            backoff_ms: START_BACKOFF_MS,
            window_start: 0,
            pressure: 0,
        }
    }
}

impl TierState {
    pub fn tier(&self) -> AudioTier {
        self.tier
    }

    pub fn tick(&mut self, now: i64) -> Option<AudioTier> {
        match self.tier {
            AudioTier::Safe if now - self.safe_since >= self.backoff_ms => {
                self.tier = AudioTier::Best;
                self.probing_until = now + PROBE_MS;
                self.window_start = now;
                self.pressure = 0;
                Some(AudioTier::Best)
            }
            AudioTier::Best if self.probing_until != 0 && now >= self.probing_until => {
                self.probing_until = 0;
                self.backoff_ms = START_BACKOFF_MS;
                None
            }
            _ => None,
        }
    }

    pub fn record(&mut self, now: i64, pressured: bool) -> Option<AudioTier> {
        if now - self.window_start >= WINDOW_MS {
            self.window_start = now;
            self.pressure = 0;
        }
        if !pressured || self.tier != AudioTier::Best {
            return None;
        }
        self.pressure += 1;
        if self.pressure < PRESSURE_EVENTS {
            return None;
        }
        self.tier = AudioTier::Safe;
        self.safe_since = now;
        self.pressure = 0;
        if self.probing_until != 0 {
            self.backoff_ms = (self.backoff_ms * 2).min(MAX_BACKOFF_MS);
            self.probing_until = 0;
        }
        Some(AudioTier::Safe)
    }
}

pub const MAX_VIDEO_LAYER: u8 = 2;
const MIN_DOWN_INTERVAL_MS: i64 = 1_500;
const START_UP_BACKOFF_MS: i64 = 10_000;
const MAX_UP_BACKOFF_MS: i64 = 60_000;
const UP_FAILED_WITHIN_MS: i64 = 5_000;

#[derive(Debug)]
pub struct WatchState {
    want: u8,
    last_change: i64,
    last_pressure: i64,
    last_up: i64,
    up_backoff_ms: i64,
    active: [Option<u8>; 4],
}

impl WatchState {
    pub fn new() -> Self {
        Self {
            want: 0,
            last_change: 0,
            last_pressure: 0,
            last_up: 0,
            up_backoff_ms: START_UP_BACKOFF_MS,
            active: [None; 4],
        }
    }

    pub fn want(&self) -> u8 {
        self.want
    }

    pub fn on_pressure(&mut self, now: i64) -> bool {
        if self.last_up != 0 && now - self.last_up < UP_FAILED_WITHIN_MS {
            self.up_backoff_ms = (self.up_backoff_ms * 2).min(MAX_UP_BACKOFF_MS);
        }
        self.last_pressure = now;
        if self.want < MAX_VIDEO_LAYER && now - self.last_change >= MIN_DOWN_INTERVAL_MS {
            self.want += 1;
            self.last_change = now;
            return true;
        }
        false
    }

    pub fn on_healthy(&mut self, now: i64) -> bool {
        if self.want > 0
            && now - self.last_pressure >= self.up_backoff_ms
            && now - self.last_change >= self.up_backoff_ms
        {
            self.want -= 1;
            self.last_change = now;
            self.last_up = now;
            return true;
        }
        false
    }

    pub fn target_for(&self, mask: u8) -> Option<u8> {
        (self.want..=MAX_VIDEO_LAYER)
            .find(|l| mask & (1 << l) != 0)
            .or_else(|| (0..self.want).rev().find(|l| mask & (1 << l) != 0))
    }

    /// Should this packet go to the viewer? Switching layers is only allowed
    /// at the start of a keyframe so the decoder never sees a broken stream.
    pub fn route(&mut self, tag: usize, layer: u8, key_start: bool, mask: u8) -> bool {
        let Some(target) = self.target_for(mask) else {
            return false;
        };
        let slot = &mut self.active[tag & 3];
        match *slot {
            Some(active) if active == layer => true,
            _ if layer == target && key_start => {
                *slot = Some(layer);
                true
            }
            _ => false,
        }
    }
}

impl Default for WatchState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_matrix() {
        assert!(AudioTier::Best.accepts(Codec::Lossless, 0));
        assert!(
            !AudioTier::Best.accepts(Codec::Opus, 1),
            "best ignores the Opus copy"
        );
        assert!(
            AudioTier::Best.accepts(Codec::Opus, 0),
            "Opus-only sender reaches best"
        );
        assert!(!AudioTier::Safe.accepts(Codec::Lossless, 0));
        assert!(AudioTier::Safe.accepts(Codec::Opus, 1));
        assert!(
            AudioTier::Safe.accepts(Codec::Opus, 0),
            "Opus-only sender reaches safe"
        );
    }

    #[test]
    fn tier_drops_on_sustained_pressure_only() {
        let mut t = TierState::default();
        assert_eq!(t.record(100, true), None);
        assert_eq!(t.record(200, true), None);
        assert_eq!(t.record(1_500, true), None);
        assert_eq!(t.record(1_600, true), None);
        assert_eq!(t.record(1_700, true), Some(AudioTier::Safe));
        assert_eq!(t.tier(), AudioTier::Safe);
    }

    #[test]
    fn healthy_traffic_never_demotes() {
        let mut t = TierState::default();
        for i in 0..10_000 {
            assert_eq!(t.record(i, false), None);
        }
        assert_eq!(t.tier(), AudioTier::Best);
    }

    #[test]
    fn tier_probes_after_backoff_and_backs_off_longer_on_failure() {
        let mut t = TierState::default();
        for i in 0..3 {
            t.record(i, true);
        }
        assert_eq!(t.tier(), AudioTier::Safe);

        assert_eq!(t.tick(10_000), None, "still inside the back-off");
        assert_eq!(t.tick(15_100), Some(AudioTier::Best), "probe starts");

        for i in 0..3 {
            t.record(15_200 + i, true);
        }
        assert_eq!(t.tier(), AudioTier::Safe);
        assert_eq!(t.tick(15_200 + 29_000), None, "30 s back-off now");
        assert_eq!(t.tick(15_200 + 30_100), Some(AudioTier::Best));

        assert_eq!(t.tick(15_200 + 30_100 + 5_100), None);
        for i in 0..3 {
            t.record(100_000 + i, true);
        }
        assert_eq!(
            t.tick(100_000 + 15_100),
            Some(AudioTier::Best),
            "reset to 15 s"
        );
    }

    #[test]
    fn video_steps_down_under_pressure_with_cooldown() {
        let mut w = WatchState::new();
        assert!(w.on_pressure(10_000));
        assert_eq!(w.want(), 1);
        assert!(!w.on_pressure(10_500), "cooldown");
        assert!(w.on_pressure(12_000));
        assert_eq!(w.want(), 2);
        assert!(!w.on_pressure(20_000), "already at the lowest layer");
    }

    #[test]
    fn video_climbs_back_only_after_a_quiet_spell() {
        let mut w = WatchState::new();
        w.on_pressure(10_000);
        w.on_pressure(12_000);
        assert!(!w.on_healthy(15_000));
        assert!(w.on_healthy(22_100));
        assert_eq!(w.want(), 1);
    }

    #[test]
    fn failed_climb_lengthens_the_wait() {
        let mut w = WatchState::new();
        w.on_pressure(10_000);
        assert!(w.on_healthy(20_100));
        assert!(w.on_pressure(22_000));
        assert!(!w.on_healthy(22_000 + 15_000), "back-off is now 20 s");
        assert!(w.on_healthy(22_000 + 20_100));
    }

    #[test]
    fn target_layer_is_clamped_to_what_the_sender_offers() {
        let mut w = WatchState::new();
        w.on_pressure(10_000);
        w.on_pressure(12_000);
        assert_eq!(w.want(), 2);
        assert_eq!(w.target_for(0b111), Some(2));
        assert_eq!(w.target_for(0b011), Some(1), "sender has no layer 2");
        assert_eq!(w.target_for(0b001), Some(0));
        assert_eq!(w.target_for(0), None);

        let fresh = WatchState::new();
        assert_eq!(fresh.target_for(0b110), Some(1), "no layer 0: next best");
    }

    #[test]
    fn switching_layers_waits_for_a_keyframe_start() {
        let mut w = WatchState::new();
        assert!(!w.route(2, 0, false, 0b111));
        assert!(w.route(2, 0, true, 0b111));
        assert!(w.route(2, 0, false, 0b111));

        w.on_pressure(10_000);
        assert!(w.route(2, 0, false, 0b111), "old layer continues");
        assert!(
            !w.route(2, 1, false, 0b111),
            "new layer's delta frame is skipped"
        );
        assert!(w.route(2, 1, true, 0b111), "switch at the keyframe");
        assert!(!w.route(2, 0, false, 0b111), "old layer is cut");
        assert!(w.route(2, 1, false, 0b111));
    }

    #[test]
    fn screen_and_camera_switch_independently() {
        let mut w = WatchState::new();
        assert!(w.route(2, 0, true, 0b111));
        assert!(!w.route(3, 0, false, 0b111), "camera has not started yet");
        assert!(w.route(3, 0, true, 0b111));
    }
}
