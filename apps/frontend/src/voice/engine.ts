// Main-thread side of voice: device handling, the Web Audio graph, session
// lifecycle and screen/camera capture. All media processing runs in
// media.worker.ts; this file only wires things together and exposes signals.

import { batch, createEffect, createRoot, createSignal } from 'solid-js';
import { getClientSessionId } from '../api/client-session';
import { ready, setVoiceChannelState } from '../api/gateway';
import { joinVoice, leaveVoice, updateVoice } from '../api/voice';
import { currentUser, voiceStates } from '../state/gateway-data';
import { recordVoiceEvent } from '../state/voice-events';
import captureUrl from './capture.worklet.ts?worker&url';
import { buildMicChain, type MicChain } from './cleaner';
import MediaWorker from './media.worker.ts?worker';
import {
	FRAME_SAMPLES,
	type FromWorker,
	type QualityReport,
	type ToWorker,
	type VideoKind,
	type VoiceMode,
} from './messages';
import playoutUrl from './playout.worklet.ts?worker&url';
import { SCREEN_PRESETS, screenBitrate, updateVoiceSettings, voiceSettings } from './settings';
import { playSound } from './sounds';

type Status = 'idle' | 'connecting' | 'connected';

declare class MediaStreamTrackProcessor {
	constructor(init: { track: MediaStreamTrack });
	readable: ReadableStream<VideoFrame>;
}

const SPEAKING_RMS = 0.012;
const SPEAKING_HOLD_MS = 250;

const [status, setStatus] = createSignal<Status>('idle');
const [activeChannel, setActiveChannel] = createSignal<{
	channelId: string;
	guildId: string;
} | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [userMuted, setUserMuted] = createSignal(false);
const [deafened, setDeafened] = createSignal(false);
const [pttActive, setPttActive] = createSignal(false);
const [quality, setQuality] = createSignal<QualityReport | null>(null);
const [localLevel, setLocalLevel] = createSignal(0);
const [loopback, setLoopback] = createSignal(false);
const [speaking, setSpeaking] = createSignal<ReadonlySet<number>>(new Set());
const [screenStream, setScreenStream] = createSignal<MediaStream | null>(null);
const [cameraStream, setCameraStream] = createSignal<MediaStream | null>(null);
const [watching, setWatching] = createSignal<ReadonlySet<number>>(new Set());
const [inputDevices, setInputDevices] = createSignal<MediaDeviceInfo[]>([]);
const [outputDevices, setOutputDevices] = createSignal<MediaDeviceInfo[]>([]);

export const voiceStatus = status;
export const voiceChannel = activeChannel;
export const voiceError = error;
export const isMuted = userMuted;
export const isDeafened = deafened;
export const voiceQuality = quality;
export const isLoopback = loopback;
export const micLevel = localLevel;

const [cleanerActive, setCleanerActive] = createSignal({ suppress: false, gate: false });

export { cleanerActive };
export const speakingSsrcs = speaking;
export const localScreenStream = screenStream;
export const localCameraStream = cameraStream;
export const watchedSsrcs = watching;
export const audioInputs = inputDevices;
export const audioOutputs = outputDevices;
export const isPushToTalkActive = pttActive;

const transmitMuted = () =>
	userMuted() || deafened() || (voiceSettings().pushToTalk && !pttActive());

interface Runtime {
	ctx: AudioContext;
	worker: Worker;
	micStream: MediaStream;
	micNode: AudioWorkletNode;
	playoutNode: AudioWorkletNode;
	channels: number;
	ssrc: number;
	screenAudio: { node: AudioWorkletNode; source: MediaStreamAudioSourceNode } | null;
	screenAudioPort: MessagePort;
	videoPumps: Partial<Record<VideoKind, () => void>>;
	speakingUntil: Map<number, number>;
	micSpeakingUntil: number;
	gainNode: GainNode;
	micSource: MediaStreamAudioSourceNode;
	chain: MicChain;
}

let rt: Runtime | null = null;
let leaving: Promise<void> | null = null;
const videoSinks = new Map<string, (frame: VideoFrame) => void>();

const send = (m: ToWorker, transfer: Transferable[] = []) => rt?.worker.postMessage(m, transfer);

function mediaUrl(channelId: string, socket: 'audio' | 'video'): string {
	const gateway = process.env.GATEWAY_URL;
	let origin: string;
	if (gateway.startsWith('ws://') || gateway.startsWith('wss://')) {
		origin = new URL(gateway).origin;
	} else {
		const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		origin = `${proto}//${window.location.host}`;
	}
	const query = new URLSearchParams({
		channelId,
		clientSessionId: getClientSessionId(),
		socket,
	});
	return `${origin}/voice/media?${query}`;
}

function micConstraints(channels: number): MediaStreamConstraints {
	const s = voiceSettings();
	const audio: MediaTrackConstraints & { voiceIsolation?: boolean; latency?: ConstrainDouble } = {
		channelCount: { ideal: channels },
		sampleRate: { ideal: 48_000 },
		echoCancellation: s.echoCancellation,
		noiseSuppression: s.noiseSuppression,
		autoGainControl: s.autoGainControl,
		voiceIsolation: false,
		latency: { ideal: 0 },
	};
	if (s.inputDeviceId) audio.deviceId = { exact: s.inputDeviceId };
	return { audio };
}

function cleaner() {
	const s = voiceSettings();
	return {
		suppress: s.aiNoiseSuppression,
		gate: s.noiseGate,
		gateThreshold: s.noiseGateThreshold,
	};
}

function micChannelsFor(mode: VoiceMode) {
	return mode === 'MUSIC_LOSSLESS' ? 2 : 1;
}

async function refreshDevices() {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		setInputDevices(devices.filter((d) => d.kind === 'audioinput'));
		setOutputDevices(devices.filter((d) => d.kind === 'audiooutput'));
	} catch {}
}

function patchServer(patch: Parameters<typeof updateVoice>[1]) {
	const channel = activeChannel();
	if (!channel) return;
	updateVoice(channel.channelId, patch)
		.then(setVoiceChannelState)
		.catch((err) => console.error('voice state update failed', err));
}

function applyMuteToWorker() {
	send({ type: 'set', muted: transmitMuted() });
}

function handleWorkerMessage(e: MessageEvent<FromWorker>) {
	const m = e.data;
	switch (m.type) {
		case 'quality':
			setQuality(m.report);
			break;
		case 'video': {
			const sink = videoSinks.get(`${m.ssrc}:${m.tag}`);
			if (sink) sink(m.frame);
			else m.frame.close();
			break;
		}
		case 'video-error':
			setError(m.message);
			stopVideo(m.kind);
			break;
		case 'error':
			console.error('[voice]', m.message);
			break;
	}
}

function handlePlayoutMessage(e: MessageEvent) {
	const runtime = rt;
	if (!runtime || e.data.type !== 'levels') return;
	const t = performance.now();
	const levels = e.data.levels as Record<string, number>;
	for (const [key, level] of Object.entries(levels)) {
		const [ssrcText, tagText] = key.split(':');
		if (tagText !== '0') continue;
		const ssrc = Number(ssrcText);
		if (level > SPEAKING_RMS) runtime.speakingUntil.set(ssrc, t + SPEAKING_HOLD_MS);
	}
	const next = new Set<number>();
	runtime.speakingUntil.forEach((until, ssrc) => {
		if (until > t) next.add(ssrc);
		else runtime.speakingUntil.delete(ssrc);
	});
	if (runtime.micSpeakingUntil > t) next.add(runtime.ssrc);

	const prev = speaking();
	let changed = prev.size !== next.size;
	next.forEach((ssrc) => {
		if (!prev.has(ssrc)) changed = true;
	});
	if (changed) setSpeaking(next);
}

async function startAudio(
	ssrc: number,
	channelId: string,
	ctx: AudioContext,
	micStream: MediaStream,
) {
	const mode = voiceSettings().mode;
	const channels = micChannelsFor(mode);

	await ctx.audioWorklet.addModule(captureUrl);
	await ctx.audioWorklet.addModule(playoutUrl);

	const worker = new MediaWorker();
	const ready = new Promise<void>((resolve, reject) => {
		const onMessage = (e: MessageEvent<FromWorker>) => {
			if (e.data.type === 'ready') {
				worker.removeEventListener('message', onMessage);
				resolve();
			} else if (e.data.type === 'error') {
				reject(new Error(e.data.message));
			}
		};
		worker.addEventListener('message', onMessage);
		worker.addEventListener('error', () => reject(new Error('Voice worker failed to start')), {
			once: true,
		});
	});
	worker.postMessage({ type: 'init' } satisfies ToWorker);
	await ready;
	worker.addEventListener('message', handleWorkerMessage);

	const micSource = ctx.createMediaStreamSource(micStream);
	const gainNode = ctx.createGain();
	gainNode.gain.value = voiceSettings().inputVolume;
	const micNode = new AudioWorkletNode(ctx, 'vanilla-capture', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		channelCount: channels,
		channelCountMode: 'explicit',
		outputChannelCount: [1],
		processorOptions: { frame: FRAME_SAMPLES, channels },
	});
	const silent = ctx.createGain();
	silent.gain.value = 0;
	const chain = await buildMicChain(ctx, micSource, channels, cleaner());
	setCleanerActive(chain.active);
	chain.out.connect(gainNode).connect(micNode).connect(silent).connect(ctx.destination);

	const playoutNode = new AudioWorkletNode(ctx, 'vanilla-playout', {
		numberOfInputs: 0,
		numberOfOutputs: 1,
		outputChannelCount: [2],
	});
	playoutNode.connect(ctx.destination);

	const micChannel = new MessageChannel();
	const screenChannel = new MessageChannel();
	const playoutChannel = new MessageChannel();
	micNode.port.postMessage({ port: micChannel.port1 }, [micChannel.port1]);
	playoutNode.port.postMessage({ type: 'port', port: playoutChannel.port1 }, [
		playoutChannel.port1,
	]);

	const runtime: Runtime = {
		ctx,
		worker,
		micStream,
		micNode,
		playoutNode,
		channels,
		ssrc,
		screenAudio: null,
		screenAudioPort: screenChannel.port1,
		videoPumps: {},
		speakingUntil: new Map(),
		micSpeakingUntil: 0,
		gainNode,
		micSource,
		chain,
	};
	rt = runtime;

	micNode.port.onmessage = (e) => {
		const level = e.data.level as number;
		setLocalLevel(level);
		if (!transmitMuted() && level > SPEAKING_RMS) {
			runtime.micSpeakingUntil = performance.now() + SPEAKING_HOLD_MS;
		}
	};
	playoutNode.port.onmessage = handlePlayoutMessage;

	// The worker creates its session on `connect`: ports must follow it.
	send({
		type: 'connect',
		audioUrl: mediaUrl(channelId, 'audio'),
		videoUrl: mediaUrl(channelId, 'video'),
		ssrc,
		mode,
	});
	send(
		{
			type: 'ports',
			mic: micChannel.port2,
			screenAudio: screenChannel.port2,
			playout: playoutChannel.port2,
		},
		[micChannel.port2, screenChannel.port2, playoutChannel.port2],
	);
	send({ type: 'set', micChannels: channels, muted: transmitMuted() });

	const sink = voiceSettings().outputDeviceId;
	if (sink) {
		await (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> })
			.setSinkId?.(sink)
			.catch(() => {});
	}
	playoutNode.port.postMessage({
		type: 'master',
		gain: deafened() ? 0 : voiceSettings().outputVolume,
	});
}

async function teardownLocal() {
	const runtime = rt;
	rt = null;
	videoSinks.clear();
	if (runtime) {
		runtime.videoPumps.screen?.();
		runtime.videoPumps.camera?.();
		runtime.worker.postMessage({ type: 'close' } satisfies ToWorker);
		runtime.worker.terminate();
		runtime.micStream.getTracks().forEach((t) => {
			t.stop();
		});
		runtime.micSource.disconnect();
		runtime.chain.dispose();
		await runtime.ctx.close().catch(() => {});
	}
	screenStream()
		?.getTracks()
		.forEach((t) => {
			t.stop();
		});
	cameraStream()
		?.getTracks()
		.forEach((t) => {
			t.stop();
		});
	batch(() => {
		setScreenStream(null);
		setCameraStream(null);
		setWatching(new Set<number>());
		setSpeaking(new Set<number>());
		setQuality(null);
		setLocalLevel(0);
		setPttActive(false);
		setLoopback(false);
	});
}

export async function joinVoiceChannel(channelId: string, guildId: string) {
	if (status() === 'connecting') return;
	const current = activeChannel();
	if (status() === 'connected' && current?.channelId === channelId) return;
	if (status() !== 'idle') await leaveVoiceChannel();
	if (leaving) await leaving;

	setError(null);
	setStatus('connecting');
	setActiveChannel({ channelId, guildId });

	let ctx: AudioContext | null = null;
	let micStream: MediaStream | null = null;
	let joinedOnServer = false;
	try {
		// Created inside the click gesture so the browser lets it run.
		ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
		await ctx.resume();

		micStream = await navigator.mediaDevices.getUserMedia(
			micConstraints(micChannelsFor(voiceSettings().mode)),
		);
		void refreshDevices();

		const state = await joinVoice(channelId, {
			quality: voiceSettings().mode,
			selfMute: userMuted(),
			selfDeaf: deafened(),
		});
		joinedOnServer = true;
		setVoiceChannelState(state);

		const me = state.participants.find((p) => p.userId === currentUser()?.id);
		if (!me) throw new Error('Could not join voice');

		await startAudio(me.ssrc, channelId, ctx, micStream);
		setStatus('connected');
		playSound('join');
	} catch (err) {
		micStream?.getTracks().forEach((t) => {
			t.stop();
		});
		await ctx?.close().catch(() => {});
		await teardownLocal();
		if (joinedOnServer) {
			leaveVoice(channelId)
				.then(setVoiceChannelState)
				.catch(() => {});
		}
		setActiveChannel(null);
		setStatus('idle');
		setError(describeError(err));
	}
}

function describeError(err: unknown, device: 'microphone' | 'camera' = 'microphone'): string {
	if (err instanceof DOMException && err.name === 'NotAllowedError') {
		return `${device === 'camera' ? 'Camera' : 'Microphone'} access was blocked. Allow it in the browser and try again.`;
	}
	if (err instanceof DOMException && err.name === 'NotFoundError') {
		return `No ${device} found.`;
	}
	return err instanceof Error ? err.message : 'Voice connection failed';
}

export function leaveVoiceChannel(): Promise<void> {
	if (leaving) return leaving;
	const channel = activeChannel();
	if (!channel) return Promise.resolve();

	playSound('leave');
	leaving = (async () => {
		await teardownLocal();
		setActiveChannel(null);
		setStatus('idle');
		try {
			setVoiceChannelState(await leaveVoice(channel.channelId));
		} catch (err) {
			console.error('leave voice failed', err);
		}
	})().finally(() => {
		leaving = null;
	});
	return leaving;
}

export function toggleMute() {
	const next = !userMuted();
	setUserMuted(next);
	// Unmuting while deafened also undeafens, like Discord.
	if (!next && deafened()) setDeafened(false);
	applyMuteToWorker();
	applyDeafToWorker();
	patchServer({ selfMute: next, selfDeaf: deafened() });
	playSound(next ? 'mute' : 'unmute');
}

export function toggleDeafen() {
	const next = !deafened();
	setDeafened(next);
	applyMuteToWorker();
	applyDeafToWorker();
	patchServer({ selfDeaf: next, selfMute: next ? true : userMuted() });
	playSound(next ? 'deafen' : 'undeafen');
}

function applyDeafToWorker() {
	rt?.playoutNode.port.postMessage({
		type: 'master',
		gain: deafened() ? 0 : voiceSettings().outputVolume,
	});
}

export function toggleLoopback() {
	const next = !loopback();
	setLoopback(next);
	send({ type: 'set', loopback: next });
}

export function setVoiceMode(mode: VoiceMode) {
	updateVoiceSettings({ mode });
	if (!rt) return;
	send({ type: 'set', mode });
	patchServer({ quality: mode });
	const wantChannels = micChannelsFor(mode);
	if (wantChannels !== rt.channels) void restartMic();
}

export async function restartMic() {
	const runtime = rt;
	if (!runtime) return;
	const channels = micChannelsFor(voiceSettings().mode);
	try {
		const stream = await navigator.mediaDevices.getUserMedia(micConstraints(channels));
		runtime.micStream.getTracks().forEach((t) => {
			t.stop();
		});
		runtime.micSource.disconnect();
		runtime.chain.dispose();
		runtime.micStream = stream;
		runtime.micSource = runtime.ctx.createMediaStreamSource(stream);
		runtime.gainNode.disconnect();

		// The capture node's channel layout is fixed at construction: rebuild it.
		const micChannel = new MessageChannel();
		runtime.micNode.disconnect();
		const micNode = new AudioWorkletNode(runtime.ctx, 'vanilla-capture', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			channelCount: channels,
			channelCountMode: 'explicit',
			outputChannelCount: [1],
			processorOptions: { frame: FRAME_SAMPLES, channels },
		});
		const silent = runtime.ctx.createGain();
		silent.gain.value = 0;
		const gainNode = runtime.ctx.createGain();
		gainNode.gain.value = voiceSettings().inputVolume;
		runtime.chain = await buildMicChain(runtime.ctx, runtime.micSource, channels, cleaner());
		setCleanerActive(runtime.chain.active);
		runtime.chain.out
			.connect(gainNode)
			.connect(micNode)
			.connect(silent)
			.connect(runtime.ctx.destination);
		micNode.port.postMessage({ port: micChannel.port1 }, [micChannel.port1]);
		micNode.port.onmessage = runtime.micNode.port.onmessage;
		runtime.micNode = micNode;
		runtime.gainNode = gainNode;
		runtime.channels = channels;
		send({ type: 'mic-port', port: micChannel.port2 }, [micChannel.port2]);
		send({ type: 'set', micChannels: channels });
		void refreshDevices();
	} catch (err) {
		setError(describeError(err));
	}
}

export function setInputVolume(volume: number) {
	updateVoiceSettings({ inputVolume: volume });
	if (rt) rt.gainNode.gain.value = volume;
}

export function setOutputVolume(volume: number) {
	updateVoiceSettings({ outputVolume: volume });
	applyDeafToWorker();
}

export async function setOutputDevice(deviceId: string) {
	updateVoiceSettings({ outputDeviceId: deviceId });
	const ctx = rt?.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined;
	await ctx?.setSinkId?.(deviceId).catch(() => {});
}

export function setUserVolume(userId: string, volume: number) {
	updateVoiceSettings({ userVolumes: { ...voiceSettings().userVolumes, [userId]: volume } });
	applyUserVolumes();
}

function applyUserVolumes() {
	if (!rt) return;
	const volumes = voiceSettings().userVolumes;
	for (const p of voiceStates()) {
		const gain = volumes[p.userId];
		if (gain === undefined) continue;
		for (const tag of [0, 1]) {
			rt.playoutNode.port.postMessage({ type: 'gain', key: `${p.ssrc}:${tag}`, gain });
		}
	}
}

function isTextTarget(target: EventTarget | null) {
	const el = target as HTMLElement | null;
	return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

if (typeof window !== 'undefined') {
	window.addEventListener('keydown', (e) => {
		const s = voiceSettings();
		if (!s.pushToTalk || e.code !== s.pushToTalkKey || e.repeat || isTextTarget(e.target)) return;
		if (status() !== 'connected') return;
		setPttActive(true);
		applyMuteToWorker();
	});
	window.addEventListener('keyup', (e) => {
		if (e.code !== voiceSettings().pushToTalkKey || !pttActive()) return;
		setPttActive(false);
		applyMuteToWorker();
	});
	window.addEventListener('blur', () => {
		if (pttActive()) {
			setPttActive(false);
			applyMuteToWorker();
		}
	});
	navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());
}

export function registerVideoSink(
	ssrc: number,
	tag: number,
	sink: (frame: VideoFrame) => void,
): () => void {
	const key = `${ssrc}:${tag}`;
	videoSinks.set(key, sink);
	return () => {
		if (videoSinks.get(key) === sink) videoSinks.delete(key);
	};
}

export function watchStream(ssrc: number, on: boolean) {
	const next = new Set<number>();
	watching().forEach((v) => {
		next.add(v);
	});
	if (on) next.add(ssrc);
	else next.delete(ssrc);
	setWatching(next);
	send({ type: 'watch', ssrc, on });
}

function pumpFrames(track: MediaStreamTrack, kind: VideoKind): () => void {
	let stopped = false;

	if (typeof MediaStreamTrackProcessor !== 'undefined') {
		const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
		(async () => {
			while (!stopped) {
				const { value, done } = await reader.read();
				if (done || !value) break;
				if (stopped || !rt) {
					value.close();
					break;
				}
				send({ type: 'video-frame', kind, frame: value }, [value]);
			}
		})().catch(() => {});
		return () => {
			stopped = true;
			reader.cancel().catch(() => {});
		};
	}

	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.srcObject = new MediaStream([track]);
	void video.play();
	const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
		if (stopped) return;
		if (rt) {
			const frame = new VideoFrame(video, { timestamp: Math.round(meta.mediaTime * 1_000_000) });
			send({ type: 'video-frame', kind, frame }, [frame]);
		}
		video.requestVideoFrameCallback(tick);
	};
	video.requestVideoFrameCallback(tick);
	return () => {
		stopped = true;
		video.srcObject = null;
	};
}

async function attachScreenAudio(stream: MediaStream) {
	const runtime = rt;
	if (!runtime || stream.getAudioTracks().length === 0) return;
	const source = runtime.ctx.createMediaStreamSource(stream);
	const node = new AudioWorkletNode(runtime.ctx, 'vanilla-capture', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		channelCount: 2,
		channelCountMode: 'explicit',
		outputChannelCount: [1],
		processorOptions: { frame: FRAME_SAMPLES, channels: 2 },
	});
	const silent = runtime.ctx.createGain();
	silent.gain.value = 0;
	source.connect(node).connect(silent).connect(runtime.ctx.destination);
	node.port.postMessage({ port: runtime.screenAudioPort }, [runtime.screenAudioPort]);
	runtime.screenAudio = { node, source };
}

export async function startScreenShare() {
	if (!rt || screenStream()) return;
	const runtime = rt;
	const preset = SCREEN_PRESETS[voiceSettings().screenPreset];
	try {
		if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
			setError(
				'Screen sharing is not supported by this desktop webview. Try the web client in a browser with screen capture support.',
			);
			return;
		}
		// WebKit requires capture to start inside the click handler. Measuring the
		// monitor first crosses animation frames and loses the user gesture.
		const stream = await navigator.mediaDevices.getDisplayMedia({
			// Native quality must leave sizing to the selected source. Asking for
			// the placeholder 8K dimensions makes WebKit negotiate a capture preset
			// even when the PipeWire source has no matching preset.
			video: preset.fps
				? {
						width: { ideal: preset.width },
						height: { ideal: preset.height },
						frameRate: { ideal: preset.fps, max: preset.fps },
					}
				: true,
			audio: {
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false,
			},
		});
		if (rt !== runtime || screenStream()) {
			stream.getTracks().forEach((track) => track.stop());
			return;
		}
		const track = stream.getVideoTracks()[0];
		const settings = track.getSettings();
		track.addEventListener('ended', () => stopVideo('screen'));

		setScreenStream(stream);
		patchServer({ screenSharing: true });
		playSound('shareStart');
		await attachScreenAudio(stream);
		const width = settings.width ?? preset.width;
		const height = settings.height ?? preset.height;
		const fps = Math.round(settings.frameRate ?? (preset.fps || 60));
		send({
			type: 'video-start',
			kind: 'screen',
			width,
			height,
			fps,
			bitrate: screenBitrate(width, height, fps, preset.bitrate),
		});
		if (rt) rt.videoPumps.screen = pumpFrames(track, 'screen');
	} catch (err) {
		setError(
			err instanceof DOMException && err.name === 'NotAllowedError'
				? 'Screen sharing was cancelled or blocked. Check screen recording permissions and try again.'
				: describeError(err),
		);
	}
}

export async function startCamera() {
	if (!rt || cameraStream()) return;
	try {
		const stream = await navigator.mediaDevices.getUserMedia({
			video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
		});
		const track = stream.getVideoTracks()[0];
		const settings = track.getSettings();
		track.addEventListener('ended', () => stopVideo('camera'));

		setCameraStream(stream);
		patchServer({ camera: true });
		send({
			type: 'video-start',
			kind: 'camera',
			width: settings.width ?? 1280,
			height: settings.height ?? 720,
			fps: Math.round(settings.frameRate ?? 30),
			bitrate: 2_000_000,
		});
		if (rt) rt.videoPumps.camera = pumpFrames(track, 'camera');
	} catch (err) {
		setError(describeError(err, 'camera'));
	}
}

export function stopVideo(kind: VideoKind) {
	const stream = kind === 'screen' ? screenStream() : cameraStream();
	if (kind === 'screen' && stream) playSound('shareStop');
	stream?.getTracks().forEach((t) => {
		t.stop();
	});
	if (kind === 'screen') {
		setScreenStream(null);
		if (rt?.screenAudio) {
			rt.screenAudio.node.disconnect();
			rt.screenAudio.source.disconnect();
			rt.screenAudio = null;
			// The port was transferred into the (now gone) node; mint a fresh pair.
			const channel = new MessageChannel();
			rt.screenAudioPort = channel.port1;
			send({ type: 'screen-audio-port', port: channel.port2 }, [channel.port2]);
		}
	} else {
		setCameraStream(null);
	}
	if (rt) {
		rt.videoPumps[kind]?.();
		delete rt.videoPumps[kind];
	}
	send({ type: 'video-stop', kind });
	patchServer(kind === 'screen' ? { screenSharing: false } : { camera: false });
}

createRoot(() => {
	let known: Map<string, string> | null = null;
	createEffect(() => {
		if (!ready()) {
			known = null;
			return;
		}
		const next = new Map<string, string>();
		voiceStates().forEach((p) => {
			next.set(p.userId, p.channelId);
		});
		const prev = known;
		known = next;
		if (!prev) return;
		next.forEach((channelId, userId) => {
			const was = prev.get(userId);
			if (was === channelId) return;
			if (was) recordVoiceEvent(was, userId, 'leave');
			recordVoiceEvent(channelId, userId, 'join');
		});
		prev.forEach((channelId, userId) => {
			if (!next.has(userId)) recordVoiceEvent(channelId, userId, 'leave');
		});
	});

	let peers: Set<string> | null = null;
	createEffect(() => {
		const channel = activeChannel();
		const me = currentUser()?.id;
		if (status() !== 'connected' || !channel) {
			peers = null;
			return;
		}
		const now = new Set<string>();
		voiceStates().forEach((p) => {
			if (p.channelId === channel.channelId && p.userId !== me) now.add(p.userId);
		});
		const before = peers;
		peers = now;
		if (!before) return;
		let joined = false;
		let left = false;
		now.forEach((id) => {
			if (!before.has(id)) joined = true;
		});
		before.forEach((id) => {
			if (!now.has(id)) left = true;
		});
		if (joined) playSound('peerJoin');
		else if (left) playSound('peerLeave');
	});

	createEffect(() => {
		const states = voiceStates();
		const user = currentUser();
		const channel = activeChannel();

		if (status() === 'connected' && channel && user) {
			const me = states.find((p) => p.userId === user.id);
			// The server dropped us (e.g. gateway reconnect): stop capturing.
			if (!me || me.channelId !== channel.channelId) {
				void teardownLocal().then(() => {
					setActiveChannel(null);
					setStatus('idle');
				});
				return;
			}
		}

		const live = new Set(states.filter((p) => p.screenSharing || p.camera).map((p) => p.ssrc));
		watching().forEach((ssrc) => {
			if (!live.has(ssrc)) watchStream(ssrc, false);
		});

		applyUserVolumes();
	});
});
