import { createMemo } from 'solid-js';
import {
	type GatewayChannel,
	type GatewayGuild,
	type GatewayMember,
	type GatewayUser,
	ready,
	type UserStatus,
} from '../api/gateway';
import type { VoiceParticipant } from '../api/voice';
import { DM_SCOPE, dmTitle, getDm } from './dms';

export const currentUser = () => ready()?.user;
export const guilds = () => ready()?.guilds ?? [];

export function getUser(id: string | undefined): GatewayUser | undefined {
	if (!id) return undefined;
	return ready()?.users?.[id];
}

export function findUserByUsername(name: string): GatewayUser | undefined {
	const lower = name.toLowerCase();
	const users = ready()?.users ?? {};
	return Object.values(users).find((u) => u.username.toLowerCase() === lower);
}

export function findChannel(channelId: string | undefined) {
	if (!channelId) return undefined;
	for (const g of guilds()) {
		const c = g.channels?.find((c) => c.id === channelId);
		if (c) return c;
	}
	return undefined;
}

export function useGuild(id: () => string | undefined) {
	return createMemo<GatewayGuild | undefined>(() => guilds().find((g) => g.id === id()));
}

export function useChannel(guildId: () => string | undefined, channelId: () => string | undefined) {
	return createMemo<GatewayChannel | undefined>(() => {
		if (guildId() === DM_SCOPE) {
			const dm = getDm(channelId());
			if (!dm) return undefined;
			return {
				id: dm.id,
				name: dmTitle(dm, currentUser()?.id),
				createdAt: '',
				guildId: DM_SCOPE,
				rateLimitPerUser: 0,
				type: 'TEXT',
			};
		}
		const g = guilds().find((g) => g.id === guildId());
		return g?.channels.find((c) => c.id === channelId());
	});
}

export type GuildMemberView = GatewayMember & { user: GatewayUser; status: UserStatus };

export function useGuildUsers(guildId: () => string | undefined) {
	return createMemo<GuildMemberView[]>(() => {
		const r = ready();
		const g = guilds().find((g) => g.id === guildId());
		if (!g?.members || !r) return [];
		const presence = new Map(r.presences?.map((p) => [p.id, p.status]) ?? []);
		const out: GuildMemberView[] = [];
		for (const m of g.members) {
			const user = r.users?.[m.userId];
			if (!user) continue;
			out.push({ ...m, user, status: presence.get(m.userId) ?? 'UNAVAILABLE' });
		}
		return out;
	});
}

export { colorForId } from './palette';

export function isOnline(s: UserStatus): boolean {
	return s !== 'UNAVAILABLE';
}

export function userPresence(userId: string): UserStatus | undefined {
	return ready()?.presences?.find((p) => p.id === userId)?.status;
}

export function voicePresence(userId: string): UserStatus {
	const s = userPresence(userId);
	return s === undefined || s === 'UNAVAILABLE' ? 'ONLINE' : s;
}

export const compactMode = () => ready()?.settings?.compactMode ?? false;

export const voiceStates = () => ready()?.voiceStates ?? [];

export function useVoiceParticipants(channelId: () => string | undefined) {
	return createMemo<VoiceParticipant[]>(() => {
		const id = channelId();
		if (!id) return [];
		return voiceStates().filter((p) => p.channelId === id);
	});
}
