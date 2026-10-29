import { ApiError, api } from './client';
import type { GatewayEmoji } from './gateway';

export const MAX_EMOJI_BYTES = 256 * 1024;
export const MAX_EMOJIS_PER_SERVER = 50;

export const emojiSrc = (e: Pick<GatewayEmoji, 'url'>) => `${process.env.API_URL ?? ''}${e.url}`;

export async function uploadEmoji(
	guildId: string,
	name: string,
	file: File,
): Promise<GatewayEmoji> {
	const form = new FormData();
	form.set('name', name);
	form.set('file', file);
	const res = await fetch(`${process.env.API_URL ?? ''}/guilds/${guildId}/emojis`, {
		method: 'POST',
		body: form,
		credentials: 'include',
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!res.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
				? body.message
				: `Request failed (${res.status})`;
		throw new ApiError(res.status, message, body);
	}
	return body as GatewayEmoji;
}

export function renameEmoji(guildId: string, emojiId: string, name: string): Promise<GatewayEmoji> {
	return api<GatewayEmoji>(`/guilds/${guildId}/emojis/${emojiId}`, {
		method: 'PATCH',
		json: { name },
	});
}

export function deleteEmoji(guildId: string, emojiId: string): Promise<void> {
	return api<void>(`/guilds/${guildId}/emojis/${emojiId}`, { method: 'DELETE' });
}
