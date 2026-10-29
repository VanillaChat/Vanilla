import { createSignal } from 'solid-js';
import { api } from '../api/client';
import type { Message } from '../api/messages';

const MENTION = /(^|[^\w@])@([\w.-]+)/g;

const BROADCAST = new Set(['everyone', 'here']);

export interface MentionPart {
	text: string;
	mention?: string;
}

export function splitMentions(content: string): MentionPart[] {
	const parts: MentionPart[] = [];
	let last = 0;
	const re = new RegExp(MENTION.source, 'g');
	for (let m = re.exec(content); m; m = re.exec(content)) {
		const start = (m.index ?? 0) + m[1].length;
		if (start > last) parts.push({ text: content.slice(last, start) });
		parts.push({ text: `@${m[2]}`, mention: m[2].toLowerCase() });
		last = start + m[2].length + 1;
	}
	if (last < content.length) parts.push({ text: content.slice(last) });
	return parts;
}

export const isBroadcast = (name: string) => BROADCAST.has(name);

export function mentionsUser(content: string, username: string | undefined): boolean {
	if (!username) return false;
	const me = username.toLowerCase();
	return splitMentions(content).some(
		(p) => p.mention === me || (p.mention && isBroadcast(p.mention)),
	);
}

export interface Ping {
	id: string;
	channelId: string;
	authorId: string;
	content: string;
	at: number;
	read: boolean;
}

const MAX_PINGS = 100;

const [pings, setPings] = createSignal<Ping[]>([]);

export const pingLog = pings;

export const mentionCounts = () => {
	const out: Record<string, number> = {};
	for (const p of pings()) if (!p.read) out[p.channelId] = (out[p.channelId] ?? 0) + 1;
	return out;
};

export const unreadPingTotal = () => pings().filter((p) => !p.read).length;

let viewed: string | null = null;

export function setViewedChannel(channelId: string | null) {
	viewed = channelId;
	if (channelId) clearMentions(channelId);
}

const tellOtherSessions = (channelIds?: string[]) =>
	api<void>('/users/@me/read-pings', { method: 'POST', json: { channelIds } }).catch(() => {});

function markRead(channelIds: string[] | null): boolean {
	const targets = channelIds ? new Set(channelIds) : null;
	const hit = (p: Ping) => !p.read && (!targets || targets.has(p.channelId));
	if (!pings().some(hit)) return false;
	setPings(pings().map((p) => (hit(p) ? { ...p, read: true } : p)));
	return true;
}

export function clearMentions(channelId: string) {
	if (markRead([channelId])) void tellOtherSessions([channelId]);
}

export function markAllPingsRead() {
	if (markRead(null)) void tellOtherSessions();
}

/** Pings that another of your sessions already read; nothing is sent back. */
export const applyRemoteRead = (channelIds: string[] | null) => void markRead(channelIds);

/** Returns true when the message is a new unread ping. */
export function noteIncomingMessage(
	m: Message,
	me: { id: string; username: string } | undefined,
): boolean {
	if (!me || m.authorId === me.id) return false;
	// Every message in a DM is addressed to you, so it always counts.
	if (m.guildId && !mentionsUser(m.content, me.username)) return false;
	const seen = viewed === m.channelId && !document.hidden;
	const ping: Ping = {
		id: m.id,
		channelId: m.channelId,
		authorId: m.authorId,
		content: m.content,
		at: Date.now(),
		read: seen,
	};
	setPings([...pings(), ping].slice(-MAX_PINGS));
	return !seen;
}
