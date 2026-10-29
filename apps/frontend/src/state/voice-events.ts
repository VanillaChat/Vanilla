import { createSignal } from 'solid-js';

export interface VoiceEvent {
	id: string;
	channelId: string;
	userId: string;
	kind: 'join' | 'leave';
	at: number;
}

const MAX_EVENTS = 200;

const [events, setEvents] = createSignal<VoiceEvent[]>([]);

export const voiceEvents = events;

let counter = 0;

export function recordVoiceEvent(channelId: string, userId: string, kind: VoiceEvent['kind']) {
	const event: VoiceEvent = { id: `ve-${++counter}`, channelId, userId, kind, at: Date.now() };
	setEvents((list) => [...list, event].slice(-MAX_EVENTS));
}
