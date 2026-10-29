import { createSignal } from 'solid-js';
import type { Message } from '../api/messages';

const [byChannel, setByChannel] = createSignal<Record<string, Message[]>>({});

export const messageStore = byChannel;

function dedupeMerge(existing: Message[], incoming: Message[]): Message[] {
	const seen = new Set<string>();
	const merged: Message[] = [];
	for (const m of [...existing, ...incoming]) {
		if (!m?.id || seen.has(m.id)) continue;
		seen.add(m.id);
		merged.push(m);
	}
	return merged;
}

/**
 * Channels showing a window of old history (after jumping to a search result) rather than
 * the latest messages. New messages are not appended to them, which would leave a gap.
 */
const [detached, setDetached] = createSignal<Record<string, true>>({});
export const isChannelDetached = (id: string) => !!detached()[id];
export function setChannelDetached(id: string, value: boolean) {
	const { [id]: _was, ...rest } = detached();
	setDetached(value ? { ...rest, [id]: true } : rest);
}

export function addMessage(msg: Message) {
	if (!msg?.id || !msg.channelId) return;
	if (detached()[msg.channelId]) return;
	const map = byChannel();
	const existing = map[msg.channelId] ?? [];
	if (existing.some((m) => m.id === msg.id)) return;
	setByChannel({ ...map, [msg.channelId]: [...existing, msg] });
}

export function setChannelMessages(channelId: string, msgs: Message[]) {
	setByChannel({ ...byChannel(), [channelId]: dedupeMerge([], msgs) });
}

export function prependMessages(channelId: string, older: Message[]) {
	if (!older?.length) return;
	const map = byChannel();
	const existing = map[channelId] ?? [];
	setByChannel({ ...map, [channelId]: dedupeMerge(older, existing) });
}

export function updateMessage(updated: Message) {
	if (!updated?.id || !updated.channelId) return;
	const map = byChannel();
	const list = map[updated.channelId];
	if (!list) return;
	const next = list.map((m) => (m.id === updated.id ? { ...m, ...updated } : m));
	setByChannel({ ...map, [updated.channelId]: next });
}

export function removeMessage(channelId: string, messageId: string) {
	const map = byChannel();
	const list = map[channelId];
	if (!list) return;
	setByChannel({
		...map,
		[channelId]: list.filter((m) => m.id !== messageId),
	});
}

const loadedChannels = new Set<string>();
export const isChannelLoaded = (id: string) => loadedChannels.has(id);
export const markChannelLoaded = (id: string) => loadedChannels.add(id);

const exhaustedChannels = new Set<string>();
export const isChannelExhausted = (id: string) => exhaustedChannels.has(id);
export const markChannelExhausted = (id: string) => exhaustedChannels.add(id);
export const unmarkChannelExhausted = (id: string) => exhaustedChannels.delete(id);
