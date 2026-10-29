import { addGuild, type GatewayMember, type GatewayUser, upsertUsers } from '../api/gateway';
import type { ServerResponse } from '../api/servers';

export function adoptServer(result: ServerResponse): string | null {
	if (!result?.guild?.id) return null;
	const g = result.guild;
	const rawMembers = (g.members ?? []) as (GatewayMember & { user?: GatewayUser })[];
	upsertUsers(result.users ?? rawMembers.flatMap((m) => (m.user ? [m.user] : [])));
	const stripped: GatewayMember[] = rawMembers.map((m) => ({
		id: m.id,
		nickname: m.nickname,
		userId: m.userId,
		joinedAt: m.joinedAt,
	}));
	addGuild({
		...g,
		channels: g.channels ?? result.channels ?? [],
		members: stripped,
	} as Parameters<typeof addGuild>[0]);
	return g.id;
}
