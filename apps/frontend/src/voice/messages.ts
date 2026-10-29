export type VoiceMode = 'AUTO' | 'VOICE_LOSSLESS' | 'STUDIO_LOSSLESS' | 'MUSIC_LOSSLESS';

export const LOSSLESS_FORMATS: Record<
	Exclude<VoiceMode, 'AUTO'>,
	{ bitDepth: 16 | 24; channels: 1 | 2 }
> = {
	VOICE_LOSSLESS: { bitDepth: 16, channels: 1 },
	STUDIO_LOSSLESS: { bitDepth: 24, channels: 1 },
	MUSIC_LOSSLESS: { bitDepth: 16, channels: 2 },
};

export const FRAME_SAMPLES = 240;

export type VideoKind = 'screen' | 'camera';

export type ToWorker =
	| { type: 'init' }
	| {
			type: 'connect';
			audioUrl: string;
			videoUrl: string;
			ssrc: number;
			mode: VoiceMode;
	  }
	| { type: 'ports'; mic: MessagePort; screenAudio: MessagePort; playout: MessagePort }
	| { type: 'mic-port'; port: MessagePort }
	| { type: 'screen-audio-port'; port: MessagePort }
	| {
			type: 'set';
			mode?: VoiceMode;
			muted?: boolean;
			micChannels?: number;
			loopback?: boolean;
	  }
	| { type: 'watch'; ssrc: number; on: boolean }
	| {
			type: 'video-start';
			kind: VideoKind;
			width: number;
			height: number;
			fps: number;
			bitrate: number;
	  }
	| { type: 'video-frame'; kind: VideoKind; frame: VideoFrame }
	| { type: 'video-stop'; kind: VideoKind }
	| { type: 'close' };

export interface QualityReport {
	codec: 'lossless' | 'opus';
	bitDepth: number;
	channels: number;
	bitrate: number;
	fallback: boolean;
	rttMs: number | null;
	congested: boolean;
	connected: boolean;
	receiveSafe: boolean;
}

export type FromWorker =
	| { type: 'ready' }
	| { type: 'quality'; report: QualityReport }
	| { type: 'video'; ssrc: number; tag: number; frame: VideoFrame }
	| { type: 'video-error'; kind: VideoKind; message: string }
	| { type: 'error'; message: string };

export type ToPlayout = {
	type: 'pcm';
	key: string;
	ssrc: number;
	tag: number;
	seq: number;
	ts: number;
	channels: number;
	pcm: Float32Array;
	resetSeq?: boolean;
};

export type PlayoutStats = {
	type: 'stats';
	streams: Array<{
		key: string;
		ssrc: number;
		tag: number;
		bufferedMs: number;
		targetMs: number;
		underruns: number;
		concealed: number;
		dropped: number;
	}>;
};
