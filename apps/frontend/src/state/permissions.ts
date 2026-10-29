import type { GatewayGuild, GatewayRole } from '../api/gateway';
import { currentUser, guilds } from './gateway-data';

export const Perm = {
	ADMINISTRATOR: 1 << 0,
	MANAGE_GUILD: 1 << 1,
	MANAGE_ROLES: 1 << 2,
	MANAGE_CHANNELS: 1 << 3,
	MANAGE_EMOJIS: 1 << 4,
	MANAGE_MESSAGES: 1 << 5,
	CREATE_INVITE: 1 << 6,
	KICK_MEMBERS: 1 << 7,
	SEND_MESSAGES: 1 << 8,
	VIEW_AUDIT_LOG: 1 << 9,
} as const;

export const ALL_PERMS = (1 << 10) - 1;
export const OWNER_RANK = Number.MAX_SAFE_INTEGER;

export const PERM_LIST: { bit: number; key: string }[] = [
	{ bit: Perm.ADMINISTRATOR, key: 'administrator' },
	{ bit: Perm.MANAGE_GUILD, key: 'manage-guild' },
	{ bit: Perm.MANAGE_ROLES, key: 'manage-roles' },
	{ bit: Perm.MANAGE_CHANNELS, key: 'manage-channels' },
	{ bit: Perm.MANAGE_EMOJIS, key: 'manage-emojis' },
	{ bit: Perm.MANAGE_MESSAGES, key: 'manage-messages' },
	{ bit: Perm.CREATE_INVITE, key: 'create-invite' },
	{ bit: Perm.KICK_MEMBERS, key: 'kick-members' },
	{ bit: Perm.SEND_MESSAGES, key: 'send-messages' },
	{ bit: Perm.VIEW_AUDIT_LOG, key: 'view-audit-log' },
];

export type Standing = { permissions: number; rank: number; isOwner: boolean };

export const hasPerm = (permissions: number, wanted: number) => (permissions & wanted) === wanted;

export function standingIn(guild: GatewayGuild | undefined, userId: string | undefined): Standing {
	if (!guild || !userId) return { permissions: 0, rank: 0, isOwner: false };
	if (guild.ownerId === userId) return { permissions: ALL_PERMS, rank: OWNER_RANK, isOwner: true };
	const roles = guild.roles ?? [];
	const held = new Set(guild.members.find((m) => m.userId === userId)?.roles ?? []);
	const mine = roles.filter((r) => held.has(r.id));
	const everyone = roles.find((r) => r.id === guild.id)?.permissions ?? 0;
	let permissions = mine.reduce((acc, r) => acc | r.permissions, everyone) & ALL_PERMS;
	if (permissions & Perm.ADMINISTRATOR) permissions = ALL_PERMS;
	return { permissions, rank: Math.max(0, ...mine.map((r) => r.position)), isOwner: false };
}

export function myStanding(guildId: string | undefined): Standing {
	return standingIn(
		guilds().find((g) => g.id === guildId),
		currentUser()?.id,
	);
}

export const can = (guildId: string | undefined, wanted: number) =>
	hasPerm(myStanding(guildId).permissions, wanted);

export const canManageAnything = (guildId: string | undefined) => {
	const p = myStanding(guildId).permissions;
	return (
		(p &
			(Perm.MANAGE_GUILD |
				Perm.MANAGE_ROLES |
				Perm.MANAGE_EMOJIS |
				Perm.VIEW_AUDIT_LOG |
				Perm.ADMINISTRATOR)) !==
		0
	);
};

export function memberRoles(guild: GatewayGuild | undefined, userId: string): GatewayRole[] {
	if (!guild) return [];
	const held = new Set(guild.members.find((m) => m.userId === userId)?.roles ?? []);
	return (guild.roles ?? []).filter((r) => held.has(r.id)).sort((a, b) => b.position - a.position);
}

export function memberColor(guild: GatewayGuild | undefined, userId: string): string | undefined {
	const role = memberRoles(guild, userId).find((r) => r.color !== 0);
	return role ? `#${role.color.toString(16).padStart(6, '0')}` : undefined;
}

/** Online members under the highest listed-separately role they hold, highest rank first. */
export function splitByHoist<T extends { userId: string }>(
	guild: GatewayGuild | undefined,
	members: T[],
): { groups: { role: GatewayRole; items: T[] }[]; rest: T[] } {
	const hoisted = (guild?.roles ?? [])
		.filter((r) => r.hoist)
		.sort((a, b) => b.position - a.position);
	const groups = new Map<string, T[]>();
	const rest: T[] = [];
	for (const m of members) {
		const held = new Set(guild?.members.find((g) => g.userId === m.userId)?.roles ?? []);
		const role = hoisted.find((r) => held.has(r.id));
		if (!role) rest.push(m);
		else groups.set(role.id, [...(groups.get(role.id) ?? []), m]);
	}
	return {
		groups: hoisted.flatMap((role) => {
			const items = groups.get(role.id);
			return items ? [{ role, items }] : [];
		}),
		rest,
	};
}

export const roleCss = (color: number) => (color ? `#${color.toString(16).padStart(6, '0')}` : '');
