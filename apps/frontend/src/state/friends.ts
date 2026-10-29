import { createSignal } from 'solid-js';
import { api } from '../api/client';
import type { GatewayUser } from '../api/gateway';

export type RelationshipKind = 'FRIEND' | 'INCOMING' | 'OUTGOING' | 'BLOCKED';

export type Relationship = { user: GatewayUser; kind: RelationshipKind; since: number };

export type FriendTarget = { userId: string } | { username: string; tag: string };

const [byUser, setByUser] = createSignal<Record<string, Relationship>>({});

const byName = (a: Relationship, b: Relationship) => a.user.username.localeCompare(b.user.username);

export const relationshipsOf = (kind: RelationshipKind) =>
	Object.values(byUser())
		.filter((r) => r.kind === kind)
		.sort(byName);

export const relationshipKind = (userId: string | undefined): RelationshipKind | undefined =>
	userId ? byUser()[userId]?.kind : undefined;

export const incomingRequests = () => relationshipsOf('INCOMING');

export function parseFriendTag(input: string): { username: string; tag: string } | null {
	const text = input.trim();
	const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('#'));
	const username = text.slice(0, at).trim();
	const tag = text.slice(at + 1).trim();
	return at > 0 && username && tag ? { username, tag } : null;
}

export function upsertRelationship(rel: Relationship) {
	setByUser({ ...byUser(), [rel.user.id]: rel });
}

export function removeRelationship(userId: string) {
	const { [userId]: _gone, ...rest } = byUser();
	setByUser(rest);
}

export async function loadRelationships(): Promise<void> {
	const list = await api<Relationship[]>('/friends');
	setByUser(Object.fromEntries(list.map((r) => [r.user.id, r])));
}

async function apply(request: Promise<Relationship>): Promise<Relationship> {
	const rel = await request;
	upsertRelationship(rel);
	return rel;
}

export const sendFriendRequest = (target: FriendTarget) =>
	apply(api<Relationship>('/friends/requests', { method: 'POST', json: target }));

export const acceptFriend = (userId: string) =>
	apply(api<Relationship>(`/friends/${userId}/accept`, { method: 'POST' }));

export const blockUser = (userId: string) =>
	apply(api<Relationship>(`/friends/blocks/${userId}`, { method: 'PUT' }));

export async function removeFriend(userId: string): Promise<void> {
	await api<void>(`/friends/${userId}`, { method: 'DELETE' });
	removeRelationship(userId);
}

export async function unblockUser(userId: string): Promise<void> {
	await api<void>(`/friends/blocks/${userId}`, { method: 'DELETE' });
	removeRelationship(userId);
}
