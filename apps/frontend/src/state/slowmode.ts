import { createSignal } from 'solid-js';

const [lastSent, setLastSent] = createSignal<Record<string, number>>({});

export const lastSentStore = lastSent;

export function recordSent(channelId: string) {
	setLastSent({ ...lastSent(), [channelId]: Date.now() });
}

export function getLastSent(channelId: string): number {
	return lastSent()[channelId] ?? 0;
}
