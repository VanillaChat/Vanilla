// Per-stream playout buffer. Pure logic (no Web Audio) so it can be unit
// tested; the playout AudioWorklet drives it.
//
// Goal: the lowest delay the connection sustains. The target starts tiny,
// grows by 10 ms on every real underrun and decays back slowly when stable.
// Bursts (e.g. after a TCP stall) are trimmed from the old end so latency never
// accumulates.

export const SAMPLE_RATE = 48_000;
const ms = (v: number) => Math.round((v * SAMPLE_RATE) / 1000);

const FADE = 48;
/// An underrun followed by data within this window was a network stall; later
/// resumption means the sender simply stopped (muted), which must not inflate
/// the buffer.
const STALL_WINDOW = ms(250);
const MAX_CONCEAL_GAP = ms(100);

export interface PcmFrame {
	seq: number;
	ts: number;
	n: number;
	l: Float32Array;
	r: Float32Array;
}

export interface StreamStats {
	bufferedMs: number;
	targetMs: number;
	underruns: number;
	concealed: number;
	dropped: number;
	late: number;
}

export class StreamBuffer {
	private q: PcmFrame[] = [];
	private pos = 0;
	private buffered = 0;
	private playing = false;
	private target: number;
	private readonly min: number;
	private readonly max: number;
	private lastSeq: number | null = null;
	private nextTs: number | null = null;
	private renderFade = 0;
	private clock = 0;
	private lastPush = 0;
	private stableFor = 0;
	private pendingUnderrun: number | null = null;

	underruns = 0;
	concealed = 0;
	dropped = 0;
	late = 0;
	private peakRms = 0;

	constructor(minMs = 10, maxMs = 150, initialMs = 20) {
		this.min = ms(minMs);
		this.max = ms(maxMs);
		this.target = ms(initialMs);
	}

	resetSeq(): void {
		this.lastSeq = null;
	}

	push(f: PcmFrame): void {
		if (this.lastSeq !== null && ((f.seq - this.lastSeq) | 0) <= 0) {
			this.late++;
			return;
		}

		if (this.pendingUnderrun !== null) {
			if (this.clock - this.pendingUnderrun < STALL_WINDOW) {
				this.underruns++;
				this.target = Math.min(this.max, this.target + ms(10));
				this.stableFor = 0;
			}
			this.pendingUnderrun = null;
		}

		if (this.nextTs === null) {
			this.fadeIn(f);
		} else {
			const gap = (f.ts - this.nextTs) | 0;
			if (gap > 0 && gap <= MAX_CONCEAL_GAP) {
				this.fadeOutTail();
				this.enqueue({
					seq: f.seq - 1,
					ts: this.nextTs,
					n: gap,
					l: new Float32Array(gap),
					r: new Float32Array(gap),
				});
				this.concealed++;
				this.fadeIn(f);
			} else if (gap > MAX_CONCEAL_GAP) {
				this.fadeIn(f);
			} else if (gap < 0) {
				if (-gap >= f.n) {
					this.late++;
					return;
				}
			}
		}

		this.lastSeq = f.seq;
		this.nextTs = (f.ts + f.n) >>> 0;
		this.lastPush = this.clock;
		this.enqueue(f);
		this.trim();
	}

	mixInto(outL: Float32Array, outR: Float32Array, off: number, len: number, gain: number): void {
		this.clock += len;

		if (!this.playing) {
			if (this.buffered < this.target) return;
			this.playing = true;
		}

		this.stableFor += len;
		if (this.stableFor > ms(4000)) {
			this.stableFor = 0;
			this.target = Math.max(this.min, this.target - ms(2.5));
		}

		let o = 0;
		let sumSq = 0;
		while (o < len) {
			const f = this.q[0];
			if (!f) {
				this.playing = false;
				this.pendingUnderrun = this.clock - (len - o);
				break;
			}
			const take = Math.min(f.n - this.pos, len - o);
			for (let i = 0; i < take; i++) {
				let g = gain;
				if (this.renderFade > 0) {
					g *= 1 - this.renderFade / FADE;
					this.renderFade--;
				}
				const l = f.l[this.pos + i] * g;
				const r = f.r[this.pos + i] * g;
				outL[off + o + i] += l;
				outR[off + o + i] += r;
				sumSq += (l * l + r * r) * 0.5;
			}
			this.pos += take;
			this.buffered -= take;
			o += take;
			if (this.pos >= f.n) {
				this.q.shift();
				this.pos = 0;
			}
		}
		if (o > 0) this.peakRms = Math.max(this.peakRms, Math.sqrt(sumSq / o));
	}

	takeLevel(): number {
		const v = this.peakRms;
		this.peakRms = 0;
		return v;
	}

	stats(): StreamStats {
		return {
			bufferedMs: (this.buffered * 1000) / SAMPLE_RATE,
			targetMs: (this.target * 1000) / SAMPLE_RATE,
			underruns: this.underruns,
			concealed: this.concealed,
			dropped: this.dropped,
			late: this.late,
		};
	}

	isIdle(): boolean {
		return this.q.length === 0 && this.clock - this.lastPush > ms(5000);
	}

	private enqueue(f: PcmFrame): void {
		this.q.push(f);
		this.buffered += f.n;
	}

	private trim(): void {
		if (this.buffered <= this.target + ms(40)) return;
		while (this.q.length > 1 && this.buffered - (this.q[0].n - this.pos) >= this.target + ms(5)) {
			this.buffered -= this.q[0].n - this.pos;
			this.q.shift();
			this.pos = 0;
			this.dropped++;
			this.renderFade = FADE;
		}
	}

	private fadeIn(f: PcmFrame): void {
		const n = Math.min(FADE, f.n);
		for (let i = 0; i < n; i++) {
			const g = i / FADE;
			f.l[i] *= g;
			f.r[i] *= g;
		}
	}

	private fadeOutTail(): void {
		const last = this.q[this.q.length - 1];
		if (!last) return;
		const n = Math.min(FADE, last.n);
		for (let i = 0; i < n; i++) {
			const g = i / FADE;
			last.l[last.n - 1 - i] *= g;
			last.r[last.n - 1 - i] *= g;
		}
	}
}
