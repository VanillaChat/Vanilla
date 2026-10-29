/// <reference path="./worklet-env.d.ts" />

import { StreamBuffer } from './jitter';
import type { PlayoutStats, ToPlayout } from './messages';

interface Stream {
	buf: StreamBuffer;
	ssrc: number;
	tag: number;
	gain: number;
}

class PlayoutProcessor extends AudioWorkletProcessor {
	private streams = new Map<string, Stream>();
	private gains = new Map<string, number>();
	private master = 1;
	private workerPort: MessagePort | null = null;
	private sinceLevels = 0;
	private sinceStats = 0;

	constructor() {
		super();
		this.port.onmessage = (e: MessageEvent) => {
			const m = e.data;
			if (m.type === 'port') {
				this.workerPort = m.port as MessagePort;
				this.workerPort.onmessage = (ev: MessageEvent) => this.onPcm(ev.data as ToPlayout);
			} else if (m.type === 'gain') {
				this.gains.set(m.key as string, m.gain as number);
				const s = this.streams.get(m.key as string);
				if (s) s.gain = m.gain as number;
			} else if (m.type === 'master') {
				this.master = m.gain as number;
			}
		};
	}

	private onPcm(m: ToPlayout) {
		if (m.type !== 'pcm') return;
		let s = this.streams.get(m.key);
		if (!s) {
			s = {
				buf: new StreamBuffer(),
				ssrc: m.ssrc,
				tag: m.tag,
				gain: this.gains.get(m.key) ?? 1,
			};
			this.streams.set(m.key, s);
		}

		const n = m.pcm.length / m.channels;
		const l = new Float32Array(n);
		const r = m.channels === 2 ? new Float32Array(n) : l;
		if (m.channels === 2) {
			for (let i = 0; i < n; i++) {
				l[i] = m.pcm[i * 2];
				r[i] = m.pcm[i * 2 + 1];
			}
		} else {
			l.set(m.pcm);
		}
		if (m.resetSeq) s.buf.resetSeq();
		s.buf.push({ seq: m.seq, ts: m.ts, n, l, r });
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0];
		if (!out || out.length === 0) return true;
		const outL = out[0];
		const outR = out[1] ?? out[0];
		const len = outL.length;

		this.streams.forEach((s) => {
			s.buf.mixInto(outL, outR, 0, len, s.gain * this.master);
		});
		for (let i = 0; i < len; i++) {
			outL[i] = Math.max(-1, Math.min(1, outL[i]));
			if (outR !== outL) outR[i] = Math.max(-1, Math.min(1, outR[i]));
		}

		this.sinceLevels += len;
		if (this.sinceLevels >= 2400) {
			this.sinceLevels = 0;
			const levels: Record<string, number> = {};
			this.streams.forEach((s, key) => {
				levels[key] = s.buf.takeLevel();
			});
			this.port.postMessage({ type: 'levels', levels });
		}

		this.sinceStats += len;
		if (this.sinceStats >= 48_000) {
			this.sinceStats = 0;
			this.streams.forEach((s, key) => {
				if (s.buf.isIdle()) this.streams.delete(key);
			});
			if (this.workerPort) {
				const stats: PlayoutStats = {
					type: 'stats',
					streams: Array.from(this.streams, ([key, s]) => ({
						key,
						ssrc: s.ssrc,
						tag: s.tag,
						...s.buf.stats(),
					})),
				};
				this.workerPort.postMessage(stats);
			}
		}
		return true;
	}
}

registerProcessor('vanilla-playout', PlayoutProcessor);
