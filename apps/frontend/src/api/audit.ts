import { api } from './client';
import type { GatewayUser } from './gateway';

export type AuditEntry = {
	id: string;
	actorId: string;
	actor: GatewayUser | null;
	action: string;
	targetType: string | null;
	targetId: string | null;
	targetName: string | null;
	changes: Record<string, unknown[]> | null;
	createdAt: number;
};

export type AuditPage = { entries: AuditEntry[]; hasMore: boolean };

export const fetchAuditLog = (guildId: string, before?: string) =>
	api<AuditPage>(
		`/guilds/${guildId}/audit-log?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
		{ method: 'GET' },
	);
