import {
	loadRnnoise,
	NoiseGateWorkletNode,
	RnnoiseWorkletNode,
} from '@sapphi-red/web-noise-suppressor';
import noiseGateUrl from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url';
import rnnoiseWasm from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasm from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';

export interface CleanerOptions {
	suppress: boolean;
	gate: boolean;
	gateThreshold: number;
}

export interface MicChain {
	out: AudioNode;
	active: { suppress: boolean; gate: boolean };
	dispose: () => void;
}

const loaded = new WeakMap<BaseAudioContext, Promise<unknown>>();
let rnnoiseBinary: Promise<ArrayBuffer> | null = null;

function loadModules(ctx: AudioContext) {
	let p = loaded.get(ctx);
	if (!p) {
		p = Promise.all([
			ctx.audioWorklet.addModule(rnnoiseUrl),
			ctx.audioWorklet.addModule(noiseGateUrl),
		]);
		loaded.set(ctx, p);
	}
	return p;
}

/**
 * Builds source -> [RNNoise] -> [noise gate]. Any stage that fails to load is
 * skipped, so a broken cleaner never costs the user their microphone.
 */
export async function buildMicChain(
	ctx: AudioContext,
	source: AudioNode,
	channels: number,
	opts: CleanerOptions,
): Promise<MicChain> {
	const nodes: AudioNode[] = [];
	let out: AudioNode = source;
	const active = { suppress: false, gate: false };

	if (opts.suppress || opts.gate) {
		try {
			await loadModules(ctx);
			if (opts.suppress) {
				rnnoiseBinary ??= loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimdWasm });
				const node = new RnnoiseWorkletNode(ctx, {
					maxChannels: channels,
					wasmBinary: await rnnoiseBinary,
				});
				out.connect(node);
				out = node;
				nodes.push(node);
				active.suppress = true;
			}
			if (opts.gate) {
				const node = new NoiseGateWorkletNode(ctx, {
					openThreshold: opts.gateThreshold,
					closeThreshold: opts.gateThreshold - 4,
					holdMs: 150,
					maxChannels: channels,
				});
				out.connect(node);
				out = node;
				nodes.push(node);
				active.gate = true;
			}
		} catch (err) {
			console.warn('[voice] noise cleaner unavailable:', err);
			rnnoiseBinary = null;
		}
	}

	console.info('[voice] mic cleaner', { wanted: opts, active });
	return {
		out,
		active,
		dispose: () => {
			for (const n of nodes) {
				if (n instanceof RnnoiseWorkletNode) n.destroy();
				n.disconnect();
			}
		},
	};
}
