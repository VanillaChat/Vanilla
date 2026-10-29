import { api } from './client';
import type { GatewayChannel, GatewayGuild, GatewayUser } from './gateway';

export type ServerResponse = {
	code?: string;
	guild: Partial<GatewayGuild> & { id: string; name: string };
	channels?: GatewayChannel[];
	users?: GatewayUser[];
};

export type CreateServerRequest = {
	name: string;
	brief?: string;
};

export function createServer(payload: CreateServerRequest): Promise<ServerResponse> {
	return api<ServerResponse>('/guilds', {
		method: 'POST',
		json: payload,
	});
}

export type JoinServerRequest = {
	inviteCode: string;
};

export function joinServer(payload: JoinServerRequest): Promise<ServerResponse> {
	return api<ServerResponse>(`/invites/${payload.inviteCode}`, {
		method: 'POST',
	});
}

export type UpdateServerRequest = {
	name?: string;
	brief?: string | null;
};

export function updateServer(guildId: string, payload: UpdateServerRequest): Promise<GatewayGuild> {
	return api<GatewayGuild>(`/guilds/${guildId}`, { method: 'PATCH', json: payload });
}

export function deleteServer(guildId: string): Promise<void> {
	return api<void>(`/guilds/${guildId}`, { method: 'DELETE' });
}
