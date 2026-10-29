import { isDmChannel } from '../state/dms';
import type { Attachment } from './attachments';
import { api } from './client';

const base = (channelId: string) =>
	isDmChannel(channelId) ? `/dms/${channelId}` : `/channels/${channelId}`;

export type MessageAuthor = {
	id: string;
	username: string;
	tag: string;
	avatar?: string | null;
	bot: boolean;
	flags: number;
	member?: { nickname: string | null } | null;
};

export type MessageReference = {
	messageId?: string;
	channelId?: string;
	guildId?: string;
};

export type Message = {
	id: string;
	channelId: string;
	guildId?: string;
	authorId: string;
	content: string;
	createdAt: number | string;
	updatedAt?: number | string | null;
	type?: string;
	nonce?: string | null;
	author?: MessageAuthor;
	messageReference?: MessageReference | null;
	referencedMessage?: Message | null;
	attachments?: Attachment[];
};

export type CreateMessageRequest = {
	content: string;
	nonce: string;
	messageReference?: { messageId: string };
	attachmentIds?: string[];
};

export function createMessage(channelId: string, payload: CreateMessageRequest): Promise<Message> {
	return api<Message>(`${base(channelId)}/messages`, {
		method: 'POST',
		json: payload,
	});
}

export type FetchMessagesQuery = {
	before?: string;
	after?: string;
	around?: string;
	limit?: number;
};

export function fetchMessages(
	channelId: string,
	query: FetchMessagesQuery = {},
): Promise<Message[]> {
	const qs = new URLSearchParams();
	if (query.before) qs.set('before', query.before);
	if (query.after) qs.set('after', query.after);
	if (query.around) qs.set('around', query.around);
	if (query.limit !== undefined) qs.set('limit', String(query.limit));
	const suffix = qs.toString() ? `?${qs}` : '';
	return api<Message[]>(`${base(channelId)}/messages${suffix}`);
}

export function sendTyping(channelId: string): Promise<void> {
	return api<void>(`${base(channelId)}/typing`, { method: 'POST' });
}

export function editMessage(
	channelId: string,
	messageId: string,
	content: string,
): Promise<Message> {
	return api<Message>(`${base(channelId)}/messages/${messageId}`, {
		method: 'PATCH',
		json: { content },
	});
}

export function deleteMessage(channelId: string, messageId: string): Promise<void> {
	return api<void>(`${base(channelId)}/messages/${messageId}`, {
		method: 'DELETE',
	});
}
