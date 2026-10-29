import { createChannelInvite } from '../api/invites';

export async function createInviteLink(channelId: string): Promise<string> {
	const invite = await createChannelInvite(channelId);
	if (!invite?.code) throw new Error('No invite code returned');
	return `${window.location.origin}/i/${invite.code}`;
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
