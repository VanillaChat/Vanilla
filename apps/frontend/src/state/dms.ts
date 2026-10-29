import { createSignal } from 'solid-js';
import { api } from '../api/client';
import type { GatewayUser } from '../api/gateway';

export type DmChannel = {
	id: string;
	name: string | null;
	isGroup: boolean;
	ownerId: string;
	members: GatewayUser[];
	lastMessageAt: number;
};

export const DM_SCOPE = '@me';

const [dms, setDms] = createSignal<DmChannel[]>([]);

export const dmChannels = dms;

export const getDm = (id: string | undefined) => dms().find((d) => d.id === id);

/**
 * Whether a channel id belongs to a DM. While the list is still loading, the page being
 * viewed (`/app/@me/<id>`) already tells us.
 */
export function isDmChannel(id: string): boolean {
	return (
		dms().some((d) => d.id === id) ||
		(typeof window !== 'undefined' && window.location.pathname.startsWith(`/app/${DM_SCOPE}/${id}`))
	);
}

export function dmOthers(dm: DmChannel, meId: string | undefined): GatewayUser[] {
	const others = dm.members.filter((m) => m.id !== meId);
	return others.length > 0 ? others : dm.members;
}

export function dmTitle(dm: DmChannel, meId: string | undefined): string {
	if (dm.name) return dm.name;
	return dmOthers(dm, meId)
		.map((m) => m.username)
		.join(', ');
}

const sorted = (list: DmChannel[]) => [...list].sort((a, b) => b.lastMessageAt - a.lastMessageAt);

export async function loadDms(): Promise<DmChannel[]> {
	const list = await api<DmChannel[]>('/dms');
	setDms(sorted(list));
	return list;
}

export function upsertDm(dm: DmChannel) {
	setDms(sorted([...dms().filter((d) => d.id !== dm.id), dm]));
}

export function removeDm(id: string) {
	setDms(dms().filter((d) => d.id !== id));
}

export function bumpDm(channelId: string, at: number) {
	setDms(sorted(dms().map((d) => (d.id === channelId ? { ...d, lastMessageAt: at } : d))));
}

export async function openDm(userId: string): Promise<DmChannel> {
	const dm = await api<DmChannel>('/dms', { method: 'POST', json: { userId } });
	upsertDm(dm);
	return dm;
}

export async function createGroup(userIds: string[], name: string): Promise<DmChannel> {
	const dm = await api<DmChannel>('/dms/groups', {
		method: 'POST',
		json: { userIds, name: name.trim() || undefined },
	});
	upsertDm(dm);
	return dm;
}

export async function addToGroup(channelId: string, userIds: string[]): Promise<DmChannel> {
	const dm = await api<DmChannel>(`/dms/${channelId}/members`, {
		method: 'POST',
		json: { userIds },
	});
	upsertDm(dm);
	return dm;
}

export async function leaveGroup(channelId: string): Promise<void> {
	await api<void>(`/dms/${channelId}/members/@me`, { method: 'DELETE' });
	removeDm(channelId);
}
