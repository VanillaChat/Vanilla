import { voiceSettings } from './settings';

export type SoundName =
	| 'join'
	| 'leave'
	| 'mute'
	| 'unmute'
	| 'deafen'
	| 'undeafen'
	| 'shareStart'
	| 'shareStop'
	| 'peerJoin'
	| 'peerLeave'
	| 'ping';

interface Note {
	freq: number;
	to?: number;
	at: number;
	dur: number;
	gain?: number;
	type?: OscillatorType;
	shimmer?: number;
}

interface Voicing {
	notes: Note[];
	cutoff: number;
	air: number;
}

// Pentatonic pitches keep every sound consonant whatever order they play in.
const E3 = 164.81;
const D4 = 293.66;
const E4 = 329.63;
const G4 = 392;
const A4 = 440;
const B4 = 493.88;
const D5 = 587.33;
const E5 = 659.25;

const SOUNDS: Record<SoundName, Voicing> = {
	join: {
		cutoff: 2600,
		air: 0.22,
		notes: [
			{ freq: E4, at: 0, dur: 0.2, shimmer: 0.08 },
			{ freq: B4, at: 0.1, dur: 0.26, shimmer: 0.1 },
			{ freq: E5, at: 0.2, dur: 0.38, gain: 0.55, shimmer: 0.08 },
		],
	},
	leave: {
		cutoff: 2600,
		air: 0.1,
		notes: [
			{ freq: E5, at: 0, dur: 0.1, gain: 0.6, shimmer: 0.06 },
			{ freq: A4, at: 0.07, dur: 0.22, gain: 0.55, shimmer: 0.05 },
		],
	},
	mute: {
		cutoff: 1900,
		air: 0.12,
		notes: [
			{ freq: B4, at: 0, dur: 0.1, gain: 0.6, shimmer: 0.04 },
			{ freq: G4, at: 0.07, dur: 0.18, gain: 0.55 },
		],
	},
	unmute: {
		cutoff: 2800,
		air: 0.14,
		notes: [
			{ freq: G4, at: 0, dur: 0.1, gain: 0.6, shimmer: 0.04 },
			{ freq: B4, at: 0.07, dur: 0.2, gain: 0.55, shimmer: 0.06 },
		],
	},
	deafen: {
		cutoff: 1500,
		air: 0.1,
		notes: [
			{ freq: G4, at: 0, dur: 0.12, type: 'triangle', gain: 1.1 },
			{ freq: D5 / 2, at: 0.09, dur: 0.2, type: 'triangle', gain: 1.1 },
		],
	},
	undeafen: {
		cutoff: 4600,
		air: 0.14,
		notes: [
			{ freq: D5 / 2, at: 0, dur: 0.12, type: 'triangle', gain: 1.1 },
			{ freq: A4, at: 0.09, dur: 0.22, gain: 1, shimmer: 0.25 },
		],
	},
	shareStart: {
		cutoff: 2800,
		air: 0.25,
		notes: [
			{ freq: D4, at: 0, dur: 0.14, shimmer: 0.08 },
			{ freq: A4, at: 0.07, dur: 0.14, shimmer: 0.08 },
			{ freq: D5, at: 0.14, dur: 0.16, shimmer: 0.08 },
			{ freq: E5, at: 0.22, dur: 0.36, gain: 0.5, shimmer: 0.06 },
		],
	},
	shareStop: {
		cutoff: 2200,
		air: 0.18,
		notes: [
			{ freq: E5, at: 0, dur: 0.13, shimmer: 0.06 },
			{ freq: A4, at: 0.07, dur: 0.14 },
			{ freq: D4, to: E3, at: 0.14, dur: 0.3, gain: 0.9, type: 'triangle' },
		],
	},
	peerJoin: {
		cutoff: 2400,
		air: 0.1,
		notes: [
			{ freq: A4, at: 0, dur: 0.11, gain: 0.7, shimmer: 0.06 },
			{ freq: E5, at: 0.06, dur: 0.22, gain: 0.6, shimmer: 0.06 },
		],
	},
	ping: {
		cutoff: 2100,
		air: 0.16,
		notes: [
			{ freq: G4, at: 0, dur: 0.16, gain: 0.55, shimmer: 0.05 },
			{ freq: D5, at: 0.1, dur: 0.34, gain: 0.5, shimmer: 0.07 },
		],
	},
	peerLeave: {
		cutoff: 2000,
		air: 0.08,
		notes: [
			{ freq: A4, at: 0, dur: 0.11, gain: 0.8, type: 'triangle' },
			{ freq: D4, at: 0.06, dur: 0.22, gain: 0.8, type: 'triangle' },
		],
	},
};

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
	try {
		ctx ??= new AudioContext({ latencyHint: 'interactive' });
		if (ctx.state === 'suspended') void ctx.resume();
		const sink = voiceSettings().outputDeviceId;
		const withSink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
		if (sink) void withSink.setSinkId?.(sink).catch(() => {});
		return ctx;
	} catch {
		return null;
	}
}

export function playSound(name: SoundName) {
	if (!voiceSettings().soundEffects) return;
	render(name);
}

/** Message pings have their own switch (`prefs.pingSound`), separate from the voice cues. */
export const playPing = () => render('ping');

function render(name: SoundName) {
	const ac = context();
	if (!ac) return;

	const v = SOUNDS[name];
	const t0 = ac.currentTime + 0.01;
	const master = ac.createGain();
	master.gain.value = 0.32 * Math.min(1, Math.max(0.15, voiceSettings().outputVolume));

	const filter = ac.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = v.cutoff;
	filter.Q.value = 0.6;
	filter.connect(master);
	master.connect(ac.destination);

	let end = 0;
	if (v.air > 0) {
		const delay = ac.createDelay(0.5);
		delay.delayTime.value = 0.085;
		const feedback = ac.createGain();
		feedback.gain.value = 0.32;
		const wet = ac.createGain();
		wet.gain.value = v.air;
		filter.connect(delay);
		delay.connect(feedback).connect(delay);
		delay.connect(wet).connect(master);
		end += 0.45;
	}

	let last = 0;
	for (const n of v.notes) {
		const start = t0 + n.at;
		const stop = start + n.dur;
		last = Math.max(last, n.at + n.dur);

		const env = ac.createGain();
		const peak = 0.5 * (n.gain ?? 1);
		env.gain.setValueAtTime(0.0001, start);
		env.gain.exponentialRampToValueAtTime(peak, start + 0.012);
		env.gain.exponentialRampToValueAtTime(0.0001, stop);
		env.connect(filter);

		const partials: Array<{ ratio: number; level: number }> = [{ ratio: 1, level: 1 }];
		if (n.shimmer) partials.push({ ratio: 2, level: n.shimmer });
		for (const p of partials) {
			const osc = ac.createOscillator();
			osc.type = n.type ?? 'sine';
			osc.frequency.setValueAtTime(n.freq * p.ratio, start);
			if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to * p.ratio, stop);
			const level = ac.createGain();
			level.gain.value = p.level;
			osc.connect(level).connect(env);
			osc.start(start);
			osc.stop(stop + 0.02);
		}
	}

	setTimeout(() => master.disconnect(), (last + end + 0.2) * 1000);
}
