import { api } from './client';
import type { ChannelType, GatewayChannel } from './gateway';

export type CreateChannelRequest = {
	name: string;
	rateLimitPerUser?: number;
	type?: ChannelType;
};

export function createChannel(
	guildId: string,
	payload: CreateChannelRequest,
): Promise<GatewayChannel> {
	const body: Record<string, unknown> = {
		name: payload.name,
	};

	if (payload.type !== undefined) {
		body.type = payload.type;
	}

	if (payload.rateLimitPerUser !== undefined) {
		body.rate_limit_per_user = payload.rateLimitPerUser;
	}

	return api<GatewayChannel>(`/guilds/${guildId}/channels`, {
		method: 'POST',
		json: body,
	});
}

export type UpdateChannelRequest = {
	name?: string;
	rateLimitPerUser?: number;
};

export function updateChannel(
	channelId: string,
	payload: UpdateChannelRequest,
): Promise<GatewayChannel> {
	return api<GatewayChannel>(`/channels/${channelId}`, { method: 'PATCH', json: payload });
}

export function deleteChannel(channelId: string): Promise<void> {
	return api<void>(`/channels/${channelId}`, { method: 'DELETE' });
}
