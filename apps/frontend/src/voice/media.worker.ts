// Media worker: owns the media sockets, all codecs and the quality controller.
// Audio is captured/played by worklets that talk to this worker directly over
// MessagePorts, so nothing on the hot path touches the main thread.

import type {
	FromWorker,
	PlayoutStats,
	QualityReport,
	ToPlayout,
	ToWorker,
	VideoKind,
	VoiceMode,
} from './messages';
import { LOSSLESS_FORMATS } from './messages';
import {
	Codec,
	Flag,
	Kind,
	layerFlags,
	layerOf,
	parsePacket,
	primaryPayload,
	Tag,
	writePacket,
} from './protocol';
import init, { LosslessDecoder, LosslessEncoder } from './wasm/vanilla_voice';
import wasmUrl from './wasm/vanilla_voice_bg.wasm?url';

const scope = self as unknown as {
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

const post = (m: FromWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const now = () => performance.now();

const HAS_OPUS = typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
const HAS_VIDEO = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';

let videoBackendReady: Promise<unknown> | undefined;

function prepareVideoBackend() {
	// WebKitGTK 2.52 can register its video encoder before GStreamer has
	// initialized the caps types. Every subsequent video support query then
	// returns false. An audio support query initializes GStreamer first, even
	// when voice uses our lossless codec and never creates an Opus encoder.
	videoBackendReady ??= HAS_OPUS
		? AudioEncoder.isConfigSupported({
				codec: 'opus',
				sampleRate: 48_000,
				numberOfChannels: 2,
				bitrate: 96_000,
			}).catch(() => undefined)
		: Promise.resolve();
	return videoBackendReady;
}

const AUDIO_SEND_CAP = 48 * 1024;
const VIDEO_SEND_CAP = 1024 * 1024;
const VIDEO_FRAGMENT = 16_000;

const OPUS_LADDER = [128_000, 96_000, 64_000, 48_000, 32_000, 24_000, 16_000];

class Link {
	private ws: WebSocket | null = null;
	private closed = false;
	private attempts = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	sendDrops = 0;

	constructor(
		private readonly url: string,
		private readonly cap: number,
		private readonly onBinary: (data: Uint8Array) => void,
		private readonly onText: (text: string) => void,
		private readonly onOpen: () => void,
	) {}

	connect() {
		if (this.closed) return;
		const ws = new WebSocket(this.url);
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			this.attempts = 0;
			this.onOpen();
		};
		ws.onmessage = (e) => {
			if (typeof e.data === 'string') this.onText(e.data);
			else this.onBinary(new Uint8Array(e.data as ArrayBuffer));
		};
		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			if (this.closed || this.attempts >= 20) return;
			const delay = Math.min(5000, 250 * 2 ** this.attempts++);
			this.timer = setTimeout(() => this.connect(), delay);
		};
		ws.onerror = () => ws.close();
		this.ws = ws;
	}

	get isOpen() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	get buffered() {
		return this.ws?.bufferedAmount ?? 0;
	}

	sendBinary(data: Uint8Array): boolean {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
		if (this.ws.bufferedAmount > this.cap) {
			this.sendDrops++;
			return false;
		}
		this.ws.send(data);
		return true;
	}

	sendText(text: string) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
	}

	close() {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.ws?.close();
		this.ws = null;
	}
}

interface AudioPlan {
	codec: 'lossless' | 'opus';
	bitDepth: 16 | 24;
	channels: 1 | 2;
	bitrate: number;
}

class Controller {
	mode: VoiceMode = 'AUTO';
	fallback = false;
	congested = false;
	rtt: number | null = null;

	private ladder = 0;
	private lastChange = 0;
	private fallbackSince = 0;
	private backoff = 15_000;
	private probing = false;
	private probeStart = 0;
	private strikes = 0;
	private lastBadReport = 0;
	private rttSamples: number[] = [];
	private lastDrops = 0;

	setMode(mode: VoiceMode) {
		this.mode = mode;
		this.fallback = false;
		this.probing = false;
		this.strikes = 0;
		this.backoff = 15_000;
	}

	onRtt(sample: number) {
		this.rtt = this.rtt === null ? sample : this.rtt * 0.7 + sample * 0.3;
		this.rttSamples.push(sample);
		if (this.rttSamples.length > 30) this.rttSamples.shift();
	}

	onBadReport() {
		this.lastBadReport = now();
	}

	plan(tag: number = Tag.Mic): AudioPlan {
		const lossless = this.mode !== 'AUTO' && (!this.fallback || this.probing);
		if (lossless || !HAS_OPUS) {
			const fmt = LOSSLESS_FORMATS[this.mode === 'AUTO' ? 'VOICE_LOSSLESS' : this.mode];
			const channels = tag === Tag.ScreenAudio ? 2 : fmt.channels;
			return {
				codec: 'lossless',
				bitDepth: tag === Tag.ScreenAudio ? 16 : fmt.bitDepth,
				channels,
				bitrate: 0,
			};
		}

		const stereo = tag === Tag.ScreenAudio || this.mode === 'MUSIC_LOSSLESS';
		const base = this.mode === 'AUTO' ? OPUS_LADDER[this.ladder] : stereo ? 192_000 : 128_000;
		return {
			codec: 'opus',
			bitDepth: 16,
			channels: stereo ? 2 : 1,
			bitrate: stereo && this.mode === 'AUTO' ? Math.round(base * 1.5) : base,
		};
	}

	tick(t: number, buffered: number, drops: number) {
		const lossless = this.plan().codec === 'lossless';
		const dropped = drops > this.lastDrops;
		this.lastDrops = drops;

		const minRtt = this.rttSamples.length ? Math.min(...this.rttSamples) : null;
		const bufferBad = buffered > (lossless ? 8_000 : 4_000);
		const rttBad = this.rtt !== null && minRtt !== null && this.rtt - minRtt > 120;
		const reportBad = t - this.lastBadReport < 2_000;
		this.congested = bufferBad || rttBad || reportBad || dropped;

		if (this.mode === 'AUTO') {
			if (this.congested && t - this.lastChange > 1_000) {
				this.ladder = Math.min(OPUS_LADDER.length - 1, this.ladder + 1);
				this.lastChange = t;
			} else if (!this.congested && t - this.lastChange > 8_000 && this.ladder > 0) {
				this.ladder--;
				this.lastChange = t;
			}
			return;
		}

		if (this.probing) {
			if (this.congested) {
				this.probing = false;
				this.fallbackSince = t;
				this.backoff = Math.min(this.backoff * 2, 120_000);
			} else if (t - this.probeStart > 4_000) {
				this.probing = false;
				this.fallback = false;
				this.backoff = 15_000;
			}
		} else if (this.fallback) {
			if (t - this.fallbackSince > this.backoff) {
				this.probing = true;
				this.probeStart = t;
			}
		} else if (this.congested) {
			// Lossless needs ~3 consecutive bad ticks (1.5 s) before giving way.
			if (++this.strikes >= 3) {
				this.fallback = true;
				this.fallbackSince = t;
				this.strikes = 0;
			}
		} else {
			this.strikes = 0;
		}
	}
}

function convertChannels(pcm: Float32Array, inCh: number, outCh: number): Float32Array {
	if (inCh === outCh) return pcm;
	const n = pcm.length / inCh;
	const out = new Float32Array(n * outCh);
	if (outCh === 1) {
		for (let i = 0; i < n; i++) out[i] = (pcm[i * 2] + pcm[i * 2 + 1]) * 0.5;
	} else {
		for (let i = 0; i < n; i++) {
			out[i * 2] = pcm[i];
			out[i * 2 + 1] = pcm[i];
		}
	}
	return out;
}

class OpusLayer {
	private enc: AudioEncoder | null = null;
	private key = '';

	constructor(private readonly onChunk: (data: Uint8Array, ts: number) => void) {}

	encode(
		frame: Float32Array,
		n: number,
		channels: number,
		bitrate: number,
		music: boolean,
		ts: number,
	) {
		const key = `${channels}/${bitrate}/${music}`;
		if (!this.enc || this.key !== key || this.enc.state === 'closed') {
			this.enc?.close();
			const enc = new AudioEncoder({
				output: (chunk) => {
					const data = new Uint8Array(chunk.byteLength);
					chunk.copyTo(data);
					this.onChunk(data, Math.round((chunk.timestamp * 48) / 1000) >>> 0);
				},
				error: (e) => post({ type: 'error', message: `opus encoder: ${e.message}` }),
			});
			// `application`/`signal` are in the WebCodecs Opus registration but not in lib.dom yet.
			const opus = {
				frameDuration: 10_000,
				application: music ? 'audio' : 'voip',
				signal: music ? 'music' : 'voice',
				complexity: 10,
				useinbandfec: false,
				usedtx: false,
			};
			enc.configure({
				codec: 'opus',
				sampleRate: 48_000,
				numberOfChannels: channels,
				bitrate,
				bitrateMode: 'variable',
				opus: opus as OpusEncoderConfig,
			});
			this.enc = enc;
			this.key = key;
		}

		let planar = frame;
		if (channels === 2) {
			planar = new Float32Array(n * 2);
			for (let i = 0; i < n; i++) {
				planar[i] = frame[i * 2];
				planar[n + i] = frame[i * 2 + 1];
			}
		}
		const data = new AudioData({
			format: 'f32-planar',
			sampleRate: 48_000,
			numberOfFrames: n,
			numberOfChannels: channels,
			timestamp: Math.round((ts * 1000) / 48),
			data: planar as Float32Array<ArrayBuffer>,
		});
		this.enc.encode(data);
		data.close();
	}

	close() {
		if (this.enc && this.enc.state !== 'closed') this.enc.close();
		this.enc = null;
	}
}

/**
 * Publishes audio in up to two layers. Layer 0 is the best stream (lossless in
 * the lossless modes, Opus otherwise). While layer 0 is lossless an Opus copy
 * goes out as layer 1, so the server can give receivers on a slow link the
 * lighter stream without dragging everyone else down.
 */
class AudioSender {
	private seq = [0, 0];
	private ts = 0;
	private lossless: LosslessEncoder | null = null;
	private losslessKey = '';
	private main = new OpusLayer((data, ts) => this.emit(0, Codec.Opus, data, ts));
	private safe = new OpusLayer((data, ts) => this.emit(1, Codec.Opus, data, ts));
	bytes = 0;

	constructor(
		private readonly tag: number,
		private readonly ssrc: () => number,
		private readonly link: () => Link | null,
		private readonly ctrl: Controller,
	) {}

	push(pcm: Float32Array, inChannels: number, muted: boolean) {
		const n = pcm.length / inChannels;
		const plan = this.ctrl.plan(this.tag);
		if (muted) {
			this.ts = (this.ts + n) >>> 0;
			return;
		}

		const frame = convertChannels(pcm, inChannels, plan.channels);
		const music = this.ctrl.mode === 'MUSIC_LOSSLESS';

		if (plan.codec === 'lossless') {
			const key = `${plan.channels}/${plan.bitDepth}`;
			if (!this.lossless || this.losslessKey !== key) {
				this.lossless?.free();
				this.lossless = new LosslessEncoder(plan.channels, plan.bitDepth);
				this.losslessKey = key;
			}
			try {
				this.emit(0, Codec.Lossless, this.lossless.encode(frame), this.ts);
			} catch {}
			if (HAS_OPUS) {
				const bitrate = plan.channels === 2 ? 128_000 : 64_000;
				this.safe.encode(frame, n, plan.channels, bitrate, music, this.ts);
			}
			this.main.close();
		} else {
			this.main.encode(frame, n, plan.channels, plan.bitrate, music, this.ts);
			this.safe.close();
		}
		this.ts = (this.ts + n) >>> 0;
	}

	private emit(layer: number, codec: number, payload: Uint8Array, ts: number) {
		const link = this.link();
		if (!link) return;
		const pkt = writePacket(
			{
				kind: Kind.Audio,
				codec,
				flags: layerFlags(layer),
				tag: this.tag,
				ssrc: this.ssrc(),
				seq: this.seq[layer],
				timestamp: ts,
			},
			payload,
		);
		this.seq[layer] = (this.seq[layer] + 1) >>> 0;
		// Layer 1 is a bonus copy: never let it back up the socket.
		if (layer === 1 && link.buffered > AUDIO_SEND_CAP / 4) return;
		if (link.sendBinary(pkt) && layer === 0) this.bytes += pkt.length;
	}

	close() {
		this.lossless?.free();
		this.lossless = null;
		this.main.close();
		this.safe.close();
	}
}

interface AudioHeader {
	codec: number;
	flags: number;
	tag: number;
	ssrc: number;
	seq: number;
	timestamp: number;
}

interface OpusStream {
	decoder: AudioDecoder;
	pending: Map<number, number>;
}

class AudioReceiver {
	private lossless = new LosslessDecoder();
	private opus = new Map<string, OpusStream>();
	private layers = new Map<string, number>();

	constructor(private readonly playout: () => MessagePort | null) {}

	handle(header: AudioHeader, payload: Uint8Array) {
		const key = `${header.ssrc}:${header.tag}`;
		if (header.codec === Codec.Lossless) {
			let pcm: Float32Array;
			try {
				pcm = this.lossless.decode(payload);
			} catch {
				return;
			}
			this.deliver(key, header, this.lossless.channels(), pcm);
		} else if (header.codec === Codec.Opus && HAS_OPUS) {
			this.decodeOpus(key, header, payload);
		}
	}

	private decodeOpus(key: string, header: AudioHeader, payload: Uint8Array) {
		let stream = this.opus.get(key);
		if (!stream || stream.decoder.state === 'closed') {
			const pending = new Map<number, number>();
			const decoder = new AudioDecoder({
				output: (ad) => {
					const n = ad.numberOfFrames;
					const ch = ad.numberOfChannels;
					const out = new Float32Array(n * ch);
					const plane = new Float32Array(n);
					for (let c = 0; c < ch; c++) {
						ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
						for (let i = 0; i < n; i++) out[i * ch + c] = plane[i];
					}
					const seq = pending.get(ad.timestamp);
					pending.delete(ad.timestamp);
					const ts = Math.round((ad.timestamp * 48) / 1000) >>> 0;
					ad.close();
					if (seq === undefined) return;
					this.deliver(key, { ...header, seq, timestamp: ts }, ch, out);
				},
				error: (e) => post({ type: 'error', message: `opus decoder: ${e.message}` }),
			});
			decoder.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 });
			stream = { decoder, pending };
			this.opus.set(key, stream);
		}

		const us = Math.round((header.timestamp * 1000) / 48);
		stream.pending.set(us, header.seq);
		if (stream.pending.size > 64) {
			const first = stream.pending.keys().next().value;
			if (first !== undefined) stream.pending.delete(first);
		}
		stream.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: us, data: payload }));
	}

	private deliver(key: string, header: AudioHeader, channels: number, pcm: Float32Array) {
		const port = this.playout();
		if (!port) return;
		const layer = layerOf(header.flags);
		const previous = this.layers.get(key);
		this.layers.set(key, layer);
		const copy = new Float32Array(pcm);
		const msg: ToPlayout = {
			type: 'pcm',
			key,
			ssrc: header.ssrc,
			tag: header.tag,
			seq: header.seq,
			ts: header.timestamp,
			channels,
			pcm: copy,
			resetSeq: previous !== undefined && previous !== layer,
		};
		port.postMessage(msg, [copy.buffer]);
	}

	close() {
		this.lossless.free();
		this.opus.forEach((s) => {
			if (s.decoder.state !== 'closed') s.decoder.close();
		});
		this.opus.clear();
	}
}

const VIDEO_CODECS = [
	{
		id: Codec.H264,
		maxMbps: 2_073_600, // level 5.2: up to 4K60 / 1080p165
		config: { codec: 'avc1.640034', avc: { format: 'annexb' } },
	},
	{
		id: Codec.H264,
		maxMbps: 16_711_680, // level 6.2: 1440p165, 4K120 and up
		config: { codec: 'avc1.64003e', avc: { format: 'annexb' } },
	},
	{ id: Codec.Vp8, maxMbps: Number.POSITIVE_INFINITY, config: { codec: 'vp8' } },
] as const;

const DECODER_CONFIG: Record<number, VideoDecoderConfig> = {
	// The level is only a ceiling; the stream's SPS carries the real one.
	[Codec.H264]: { codec: 'avc1.64003e' },
	[Codec.Vp8]: { codec: 'vp8' },
	[Codec.Vp9]: { codec: 'vp09.00.40.08' },
	[Codec.Av1]: { codec: 'av01.0.08M.08' },
};

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/**
 * Simulcast plan: the source plus up to two smaller encodes. A viewer on a
 * slow link is served a smaller one by the server, so the sender never has to
 * degrade for everybody. Layers below 360 px are not worth sending.
 */
function layerPlan(width: number, height: number) {
	const plan = [{ scale: 1, share: 1 }];
	for (const [scale, share] of [
		[0.5, 0.3],
		[0.25, 0.1],
	]) {
		if (Math.min(width, height) * scale >= 360) plan.push({ scale, share });
	}
	return plan;
}

interface VideoLayer {
	index: number;
	encoder: VideoEncoder;
	width: number;
	height: number;
	share: number;
	seq: number;
	needKey: boolean;
}

class VideoSender {
	private layers: VideoLayer[] = [];
	private codecId: number = Codec.Vp8;
	private candidate: (typeof VIDEO_CODECS)[number] = VIDEO_CODECS[VIDEO_CODECS.length - 1];
	private frames = 0;
	private bitrate = 0;
	private targetBitrate = 0;
	private lastRaise = 0;
	private fps = 30;

	constructor(
		private readonly kind: VideoKind,
		private readonly ssrc: () => number,
		private readonly link: () => Link | null,
	) {}

	private get tag() {
		return this.kind === 'screen' ? Tag.ScreenVideo : Tag.Camera;
	}

	private configFor(layer: { width: number; height: number; share: number }, bitrate: number) {
		return {
			...this.candidate.config,
			width: layer.width,
			height: layer.height,
			framerate: this.fps,
			bitrate: Math.max(150_000, Math.round(bitrate * layer.share)),
			latencyMode: 'realtime',
			bitrateMode: 'variable',
		} as VideoEncoderConfig;
	}

	async start(width: number, height: number, fps: number, bitrate: number) {
		await prepareVideoBackend();
		this.stop();
		this.fps = fps;
		this.bitrate = bitrate;
		this.targetBitrate = bitrate;

		const plan = layerPlan(width, height).map((l, index) => ({
			index,
			width: even(width * l.scale),
			height: even(height * l.scale),
			share: l.share,
		}));

		// The codec is chosen on the full-size layer and shared by all layers.
		let chosen = false;
		const mbps = Math.ceil(width / 16) * Math.ceil(height / 16) * fps;
		for (const candidate of VIDEO_CODECS) {
			if (candidate.maxMbps < mbps) continue;
			this.candidate = candidate;
			this.codecId = candidate.id;
			const support = await VideoEncoder.isConfigSupported(this.configFor(plan[0], bitrate)).catch(
				() => null,
			);
			if (support?.supported) {
				chosen = true;
				break;
			}
		}
		if (!chosen) {
			post({ type: 'video-error', kind: this.kind, message: 'No supported video encoder' });
			return;
		}

		for (const l of plan) {
			const encoder = new VideoEncoder({
				output: (chunk) => this.onChunk(l.index, chunk),
				error: (e) => {
					if (l.index === 0) post({ type: 'video-error', kind: this.kind, message: e.message });
				},
			});
			try {
				encoder.configure(this.configFor(l, bitrate));
			} catch {
				encoder.close();
				continue;
			}
			this.layers.push({ ...l, encoder, seq: 0, needKey: true });
		}
	}

	requestKeyframe(layer?: number) {
		for (const l of this.layers) {
			if (layer === undefined || l.index === layer) l.needKey = true;
		}
	}

	encode(frame: VideoFrame) {
		const link = this.link();
		if (this.layers.length === 0 || !link) {
			frame.close();
			return;
		}

		const queued = link.buffered;
		const t = now();
		if (queued > 256 * 1024) {
			frame.close();
			this.adapt(0.7, t);
			this.requestKeyframe();
			return;
		}
		if (queued < 16 * 1024 && this.bitrate < this.targetBitrate && t - this.lastRaise > 5_000) {
			this.adapt(1.15, t);
		}

		const periodic = this.frames % (this.fps * 20) === 0;
		this.frames++;
		for (const l of this.layers) {
			if (l.encoder.state !== 'configured' || l.encoder.encodeQueueSize > 3) continue;
			l.encoder.encode(frame, { keyFrame: l.needKey || periodic });
			l.needKey = false;
		}
		frame.close();
	}

	private adapt(factor: number, t: number) {
		const next = Math.max(300_000, Math.min(this.targetBitrate, Math.round(this.bitrate * factor)));
		this.lastRaise = t;
		if (next === this.bitrate) return;
		this.bitrate = next;
		for (const l of this.layers) {
			if (l.encoder.state === 'configured') l.encoder.configure(this.configFor(l, next));
			l.needKey = true;
		}
	}

	private onChunk(index: number, chunk: EncodedVideoChunk) {
		const layer = this.layers.find((l) => l.index === index);
		const link = this.link();
		if (!layer || !link) return;
		const data = new Uint8Array(chunk.byteLength);
		chunk.copyTo(data);
		const ts = Math.round((chunk.timestamp * 90) / 1000) >>> 0;
		const key = chunk.type === 'key';
		const parts = Math.max(1, Math.ceil(data.length / VIDEO_FRAGMENT));
		for (let i = 0; i < parts; i++) {
			const slice = data.subarray(i * VIDEO_FRAGMENT, (i + 1) * VIDEO_FRAGMENT);
			const pkt = writePacket(
				{
					kind: Kind.Video,
					codec: this.codecId,
					flags:
						layerFlags(index) |
						(key ? Flag.Keyframe : 0) |
						(i === 0 ? Flag.FrameStart : 0) |
						(i === parts - 1 ? Flag.EndOfFrame : 0),
					tag: this.tag,
					ssrc: this.ssrc(),
					seq: layer.seq,
					timestamp: ts,
				},
				slice,
			);
			layer.seq = (layer.seq + 1) >>> 0;
			if (!link.sendBinary(pkt)) {
				layer.needKey = true;
				return;
			}
		}
	}

	stop() {
		for (const l of this.layers) {
			if (l.encoder.state !== 'closed') l.encoder.close();
		}
		this.layers = [];
	}
}

interface VideoStream {
	decoder: VideoDecoder | null;
	codec: number;
	chunks: Uint8Array[];
	key: boolean;
	expectSeq: number | null;
	haveKey: boolean;
	startTs: number;
	layer: number;
}

class VideoReceiver {
	private streams = new Map<string, VideoStream>();

	constructor(private readonly requestKey: (ssrc: number) => void) {}

	handle(
		header: {
			codec: number;
			flags: number;
			tag: number;
			ssrc: number;
			seq: number;
			timestamp: number;
		},
		payload: Uint8Array,
	) {
		if (!HAS_VIDEO) return;
		const id = `${header.ssrc}:${header.tag}`;
		let s = this.streams.get(id);
		if (!s) {
			s = {
				decoder: null,
				codec: -1,
				chunks: [],
				key: false,
				expectSeq: null,
				haveKey: false,
				startTs: 0,
				layer: layerOf(header.flags),
			};
			this.streams.set(id, s);
		}

		// The server moved us to another layer (it only does so at a keyframe):
		// new sequence space, possibly a new resolution, so start the decoder over.
		const layer = layerOf(header.flags);
		if (layer !== s.layer) {
			s.layer = layer;
			s.chunks = [];
			s.expectSeq = null;
			s.haveKey = false;
			s.decoder?.close();
			s.decoder = null;
		}

		// A gap means the server shed packets for us: drop the frame, resync on a keyframe.
		if (s.expectSeq !== null && header.seq !== s.expectSeq) {
			s.chunks = [];
			s.haveKey = false;
			this.requestKey(header.ssrc);
		}
		s.expectSeq = (header.seq + 1) >>> 0;

		if (s.chunks.length === 0) {
			s.key = (header.flags & Flag.Keyframe) !== 0;
			s.startTs = header.timestamp;
		}
		s.chunks.push(payload);
		if ((header.flags & Flag.EndOfFrame) === 0) return;

		const chunks = s.chunks;
		s.chunks = [];
		if (s.key) s.haveKey = true;
		if (!s.haveKey) {
			this.requestKey(header.ssrc);
			return;
		}

		if (!s.decoder || s.decoder.state === 'closed' || s.codec !== header.codec) {
			const config = DECODER_CONFIG[header.codec];
			if (!config) return;
			s.decoder?.close();
			s.decoder = new VideoDecoder({
				output: (frame) =>
					post({ type: 'video', ssrc: header.ssrc, tag: header.tag, frame }, [frame]),
				error: () => {
					s.haveKey = false;
					this.requestKey(header.ssrc);
				},
			});
			s.decoder.configure(config);
			s.codec = header.codec;
			if (!s.key) {
				s.haveKey = false;
				this.requestKey(header.ssrc);
				return;
			}
		}

		if (s.decoder.decodeQueueSize > 6 && !s.key) {
			s.haveKey = false;
			this.requestKey(header.ssrc);
			return;
		}

		let size = 0;
		for (const c of chunks) size += c.length;
		const data = new Uint8Array(size);
		let off = 0;
		for (const c of chunks) {
			data.set(c, off);
			off += c.length;
		}
		s.decoder.decode(
			new EncodedVideoChunk({
				type: s.key ? 'key' : 'delta',
				timestamp: Math.round((s.startTs * 1000) / 90),
				data,
			}),
		);
	}

	close() {
		this.streams.forEach((s) => {
			if (s.decoder && s.decoder.state !== 'closed') s.decoder.close();
		});
		this.streams.clear();
	}
}

class Session {
	private ctrl = new Controller();
	private audio: Link | null = null;
	private video: Link | null = null;
	private videoUrl = '';
	private ssrc = 0;
	private muted = false;
	private micChannels = 1;
	private loopback = false;
	private receiveSafe = false;
	private playout: MessagePort | null = null;
	private micPort: MessagePort | null = null;
	private screenAudioPort: MessagePort | null = null;
	private watching = new Set<number>();

	private mic = new AudioSender(
		Tag.Mic,
		() => this.ssrc,
		() => this.audio,
		this.ctrl,
	);
	private screenAudio = new AudioSender(
		Tag.ScreenAudio,
		() => this.ssrc,
		() => this.audio,
		this.ctrl,
	);
	private receiver = new AudioReceiver(() => this.playout);
	private videoReceiver = new VideoReceiver((ssrc) => this.sendPli(ssrc));
	private videoSenders: Record<VideoKind, VideoSender> = {
		screen: new VideoSender(
			'screen',
			() => this.ssrc,
			() => this.video,
		),
		camera: new VideoSender(
			'camera',
			() => this.ssrc,
			() => this.video,
		),
	};

	private timer: ReturnType<typeof setInterval> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private lastBytes = 0;
	private lastReport = 0;
	private reported = new Map<string, { u: number; c: number; d: number }>();

	connect(audioUrl: string, videoUrl: string, ssrc: number, mode: VoiceMode) {
		this.ssrc = ssrc;
		this.videoUrl = videoUrl;
		this.ctrl.setMode(mode);

		this.audio = new Link(
			audioUrl,
			AUDIO_SEND_CAP,
			(data) => this.onAudioPacket(data),
			(text) => this.onControl(text),
			() => {
				this.ping();
				// The server forgets the switch with the socket: restore it after a reconnect.
				if (this.loopback) this.sendLoopback();
			},
		);
		this.audio.connect();

		this.lastReport = now();
		this.timer = setInterval(() => this.tick(), 500);
		this.pingTimer = setInterval(() => this.ping(), 1000);
	}

	attachMic(port: MessagePort) {
		this.micPort?.close();
		this.micPort = port;
		port.onmessage = (e) => this.mic.push(e.data.pcm as Float32Array, this.micChannels, this.muted);
	}

	attachScreenAudio(port: MessagePort) {
		this.screenAudioPort?.close();
		this.screenAudioPort = port;
		port.onmessage = (e) => this.screenAudio.push(e.data.pcm as Float32Array, 2, false);
	}

	attachPorts(mic: MessagePort, screenAudio: MessagePort, playout: MessagePort) {
		this.attachMic(mic);
		this.attachScreenAudio(screenAudio);
		this.playout = playout;
		playout.onmessage = (e) => {
			const m = e.data as PlayoutStats;
			if (m.type === 'stats') this.sendReports(m);
		};
	}

	set(opts: { mode?: VoiceMode; muted?: boolean; micChannels?: number; loopback?: boolean }) {
		if (opts.loopback !== undefined) {
			this.loopback = opts.loopback;
			this.sendLoopback();
		}
		if (opts.mode !== undefined) this.ctrl.setMode(opts.mode);
		if (opts.muted !== undefined) this.muted = opts.muted;
		if (opts.micChannels !== undefined) this.micChannels = opts.micChannels;
	}

	watch(ssrc: number, on: boolean) {
		if (on) this.watching.add(ssrc);
		else this.watching.delete(ssrc);
		this.ensureVideoLink();
		this.video?.sendText(JSON.stringify({ t: 'watch', target: ssrc, on }));
	}

	async videoStart(kind: VideoKind, width: number, height: number, fps: number, bitrate: number) {
		if (!HAS_VIDEO) {
			post({
				type: 'video-error',
				kind,
				message: 'Video encoding is not supported in this browser',
			});
			return;
		}
		this.ensureVideoLink();
		await this.videoSenders[kind].start(width, height, fps, bitrate);
	}

	videoFrame(kind: VideoKind, frame: VideoFrame) {
		this.videoSenders[kind].encode(frame);
	}

	videoStop(kind: VideoKind) {
		this.videoSenders[kind].stop();
	}

	private ensureVideoLink() {
		if (this.video || !this.videoUrl) return;
		this.video = new Link(
			this.videoUrl,
			VIDEO_SEND_CAP,
			(data) => this.onVideoPacket(data),
			() => {},
			() => {
				// Subscriptions live on the server socket: restore them after a reconnect.
				this.watching.forEach((ssrc) => {
					this.video?.sendText(JSON.stringify({ t: 'watch', target: ssrc, on: true }));
				});
			},
		);
		this.video.connect();
	}

	private onAudioPacket(data: Uint8Array) {
		const parsed = parsePacket(data);
		if (!parsed || parsed.header.kind !== Kind.Audio) return;
		const payload = primaryPayload(parsed.header, parsed.body);
		if (!payload) return;
		this.receiver.handle(parsed.header, payload);
	}

	private onVideoPacket(data: Uint8Array) {
		const parsed = parsePacket(data);
		if (!parsed || parsed.header.kind !== Kind.Video) return;
		this.videoReceiver.handle(parsed.header, parsed.body);
	}

	private onControl(text: string) {
		let m: {
			t?: string;
			n?: number;
			u?: number;
			c?: number;
			d?: number;
			tier?: string;
			layer?: number;
		};
		try {
			m = JSON.parse(text);
		} catch {
			return;
		}
		if (m.t === 'pong' && typeof m.n === 'number') {
			this.ctrl.onRtt(now() - m.n);
		} else if (m.t === 'report') {
			if ((m.u ?? 0) + (m.c ?? 0) + (m.d ?? 0) > 0) this.ctrl.onBadReport();
		} else if (m.t === 'pli') {
			this.videoSenders.screen.requestKeyframe(m.layer);
			this.videoSenders.camera.requestKeyframe(m.layer);
		} else if (m.t === 'tier') {
			this.receiveSafe = m.tier === 'safe';
		}
	}

	private sendLoopback() {
		this.audio?.sendText(JSON.stringify({ t: 'loopback', on: this.loopback }));
	}

	private ping() {
		this.audio?.sendText(JSON.stringify({ t: 'ping', n: now() }));
	}

	private sendPli(ssrc: number) {
		this.audio?.sendText(JSON.stringify({ t: 'pli', target: ssrc }));
	}

	private sendReports(stats: PlayoutStats) {
		for (const s of stats.streams) {
			if (s.tag !== Tag.Mic) continue;
			const prev = this.reported.get(s.key) ?? { u: 0, c: 0, d: 0 };
			const delta = { u: s.underruns - prev.u, c: s.concealed - prev.c, d: s.dropped - prev.d };
			this.reported.set(s.key, { u: s.underruns, c: s.concealed, d: s.dropped });
			if (delta.u + delta.c + delta.d > 0) {
				this.audio?.sendText(JSON.stringify({ t: 'report', target: s.ssrc, ...delta }));
			}
		}
	}

	private tick() {
		const t = now();
		this.ctrl.tick(t, this.audio?.buffered ?? 0, this.audio?.sendDrops ?? 0);

		const dt = (t - this.lastReport) / 1000;
		const bytes = this.mic.bytes;
		const bitrate = dt > 0 ? Math.round(((bytes - this.lastBytes) * 8) / dt) : 0;
		this.lastBytes = bytes;
		this.lastReport = t;

		const plan = this.ctrl.plan();
		const report: QualityReport = {
			codec: plan.codec,
			bitDepth: plan.bitDepth,
			channels: plan.channels,
			bitrate,
			fallback: this.ctrl.mode !== 'AUTO' && plan.codec === 'opus',
			rttMs: this.ctrl.rtt,
			congested: this.ctrl.congested,
			receiveSafe: this.receiveSafe,
			connected: this.audio?.isOpen ?? false,
		};
		post({ type: 'quality', report });
	}

	close() {
		if (this.timer) clearInterval(this.timer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.audio?.close();
		this.video?.close();
		this.mic.close();
		this.screenAudio.close();
		this.receiver.close();
		this.videoReceiver.close();
		this.videoSenders.screen.stop();
		this.videoSenders.camera.stop();
	}
}

let ready: Promise<unknown> | null = null;
let session: Session | null = null;

// Handlers await (wasm init), so run messages strictly in arrival order.
let queue: Promise<void> = Promise.resolve();
scope.onmessage = (e) => {
	queue = queue.then(() => handle(e.data));
};

async function handle(m: ToWorker) {
	try {
		switch (m.type) {
			case 'init':
				ready ??= init({ module_or_path: wasmUrl });
				await ready;
				post({ type: 'ready' });
				break;
			case 'connect':
				await ready;
				session?.close();
				session = new Session();
				session.connect(m.audioUrl, m.videoUrl, m.ssrc, m.mode);
				break;
			case 'ports':
				session?.attachPorts(m.mic, m.screenAudio, m.playout);
				break;
			case 'mic-port':
				session?.attachMic(m.port);
				break;
			case 'screen-audio-port':
				session?.attachScreenAudio(m.port);
				break;
			case 'set':
				session?.set(m);
				break;
			case 'watch':
				session?.watch(m.ssrc, m.on);
				break;
			case 'video-start':
				await session?.videoStart(m.kind, m.width, m.height, m.fps, m.bitrate);
				break;
			case 'video-frame':
				if (session) session.videoFrame(m.kind, m.frame);
				else m.frame.close();
				break;
			case 'video-stop':
				session?.videoStop(m.kind);
				break;
			case 'close':
				session?.close();
				session = null;
				break;
		}
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
}
