import { api } from './client';
import { getClientSessionId } from './client-session';

export type VoiceQuality = 'AUTO' | 'VOICE_LOSSLESS' | 'STUDIO_LOSSLESS' | 'MUSIC_LOSSLESS';

export type VoiceAudioFormat = {
	sampleRate: number;
	bitDepth: number;
	channels: number;
	estimatedBitrateBps: number;
};

export type VoiceParticipant = {
	userId: string;
	guildId: string;
	channelId: string;
	ssrc: number;
	quality: VoiceQuality;
	audioFormat: VoiceAudioFormat;
	selfMute: boolean;
	selfDeaf: boolean;
	screenSharing: boolean;
	camera: boolean;
	joinedAt: number;
};

export type VoiceChannelState = {
	guildId: string;
	channelId: string;
	participants: VoiceParticipant[];
};

export type JoinVoiceRequest = {
	quality: VoiceQuality;
	selfMute?: boolean;
	selfDeaf?: boolean;
};

export type UpdateVoiceRequest = {
	quality?: VoiceQuality;
	selfMute?: boolean;
	selfDeaf?: boolean;
	screenSharing?: boolean;
	camera?: boolean;
};

export function fetchVoiceState(channelId: string): Promise<VoiceChannelState> {
	return api<VoiceChannelState>(`/channels/${channelId}/voice`);
}

export function joinVoice(
	channelId: string,
	payload: JoinVoiceRequest,
): Promise<VoiceChannelState> {
	return api<VoiceChannelState>(`/channels/${channelId}/voice/join`, {
		method: 'POST',
		json: {
			...payload,
			clientSessionId: getClientSessionId(),
		},
	});
}

export function leaveVoice(channelId: string): Promise<VoiceChannelState> {
	return api<VoiceChannelState>(`/channels/${channelId}/voice/leave`, {
		method: 'POST',
		json: {
			clientSessionId: getClientSessionId(),
		},
	});
}

export function updateVoice(
	channelId: string,
	payload: UpdateVoiceRequest,
): Promise<VoiceChannelState> {
	return api<VoiceChannelState>(`/channels/${channelId}/voice`, {
		method: 'PATCH',
		json: {
			...payload,
			clientSessionId: getClientSessionId(),
		},
	});
}
