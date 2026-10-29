import { createSignal } from 'solid-js';
import type { VoiceMode } from './messages';

export interface VoiceSettings {
	mode: VoiceMode;
	inputDeviceId: string;
	outputDeviceId: string;
	echoCancellation: boolean;
	noiseSuppression: boolean;
	aiNoiseSuppression: boolean;
	noiseGate: boolean;
	noiseGateThreshold: number;
	autoGainControl: boolean;
	inputVolume: number;
	outputVolume: number;
	pushToTalk: boolean;
	pushToTalkKey: string;
	userVolumes: Record<string, number>;
	developerMode: boolean;
	soundEffects: boolean;
	screenPreset: 'p720' | 'p1080' | 'p1080x60' | 'p1440x60' | 'p4k30' | 'source';
}

const STORAGE_KEY = 'vanilla-voice-settings';

const DEFAULTS: VoiceSettings = {
	// Auto adapts to the connection; lossless is always opt-in.
	mode: 'AUTO',
	inputDeviceId: '',
	outputDeviceId: '',
	// Browser echo cancellation gates and clips the voice (and fights "Hear myself"): opt-in.
	echoCancellation: false,
	noiseSuppression: false,
	aiNoiseSuppression: true,
	noiseGate: true,
	noiseGateThreshold: -45,
	autoGainControl: false,
	inputVolume: 1,
	outputVolume: 1,
	pushToTalk: false,
	pushToTalkKey: 'KeyV',
	userVolumes: {},
	developerMode: false,
	soundEffects: true,
	screenPreset: 'p1080',
};

function load(): VoiceSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const saved = JSON.parse(raw);
			// Echo cancellation used to default on and got persisted by any change: reset it once.
			if (saved.v === undefined) saved.echoCancellation = false;
			// The noise gate became on-by-default in v3.
			if (saved.v === undefined || saved.v < 3) {
				delete saved.noiseGate;
				delete saved.noiseGateThreshold;
			}
			return { ...DEFAULTS, ...saved };
		}
	} catch {}
	return DEFAULTS;
}

const [settings, setSettingsSignal] = createSignal<VoiceSettings>(load());

export const voiceSettings = settings;

export function updateVoiceSettings(patch: Partial<VoiceSettings>) {
	const next = { ...settings(), ...patch };
	setSettingsSignal(next);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...next, v: 3 }));
	} catch {}
}

export const SCREEN_PRESETS: Record<
	VoiceSettings['screenPreset'],
	{ label: string; width: number; height: number; fps: number; bitrate: number }
> = {
	p720: { label: '720p · 30 fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
	p1080: { label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 },
	p1080x60: { label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
	p1440x60: { label: '1440p · 60 fps', width: 2560, height: 1440, fps: 60, bitrate: 16_000_000 },
	p4k30: { label: '4K · 30 fps', width: 3840, height: 2160, fps: 30, bitrate: 20_000_000 },
	source: {
		label: 'Monitor quality (native resolution and refresh rate)',
		width: 7680,
		height: 4320,
		fps: 0,
		bitrate: 0,
	},
};

/** ~0.09 bits per pixel keeps text sharp at screen-content frame rates. */
export function screenBitrate(width: number, height: number, fps: number, preset: number): number {
	if (preset > 0) return preset;
	return Math.min(40_000_000, Math.max(4_000_000, Math.round(width * height * fps * 0.09)));
}
