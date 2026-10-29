import { createSignal } from 'solid-js';

export type TypingUser = {
	userId: string;
	username: string;
	expiresAt: number;
};

const [byChannel, setByChannel] = createSignal<Record<string, TypingUser[]>>({});

export const typingStore = byChannel;

export function addTyping(channelId: string, user: TypingUser) {
	const map = byChannel();
	const now = Date.now();
	const list = (map[channelId] ?? []).filter((u) => u.userId !== user.userId && u.expiresAt > now);
	setByChannel({ ...map, [channelId]: [...list, user] });
}

export function removeTyping(channelId: string, userId: string) {
	const map = byChannel();
	const list = map[channelId];
	if (!list) return;
	setByChannel({
		...map,
		[channelId]: list.filter((u) => u.userId !== userId),
	});
}

function prune() {
	const now = Date.now();
	const map = byChannel();
	let changed = false;
	const next: Record<string, TypingUser[]> = {};
	for (const [chId, users] of Object.entries(map)) {
		const filtered = users.filter((u) => u.expiresAt > now);
		if (filtered.length !== users.length) changed = true;
		next[chId] = filtered;
	}
	if (changed) setByChannel(next);
}

if (typeof window !== 'undefined') {
	const g = globalThis as { __vanillaTypingPrune?: number };
	if (!g.__vanillaTypingPrune) {
		g.__vanillaTypingPrune = window.setInterval(prune, 500);
	}
}
