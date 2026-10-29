import { api } from './client';

export type Invite = {
	code: string;
	channelId: string;
	guildId?: string;
	createdAt?: number | string;
	expiresAt?: number | string | null;
};

export type CreateInviteOptions = {
	maxUses?: number;
};

export function createChannelInvite(
	channelId: string,
	opts: CreateInviteOptions = {},
): Promise<Invite> {
	return api<Invite>(`/channels/${channelId}/invites`, {
		method: 'POST',
		json: { max_uses: opts.maxUses ?? 0 },
	});
}
