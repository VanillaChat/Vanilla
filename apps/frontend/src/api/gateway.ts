import { createSignal } from 'solid-js';
import { bumpDm, type DmChannel, getDm, loadDms, removeDm, upsertDm } from '../state/dms';
import { type Relationship, removeRelationship, upsertRelationship } from '../state/friends';
import { applyRemoteRead, noteIncomingMessage } from '../state/mentions';
import { addMessage, removeMessage, updateMessage } from '../state/messages';
import { prefs } from '../state/prefs';
import { addTyping } from '../state/typing';
import { playPing } from '../voice/sounds';
import { getClientSessionId } from './client-session';
import type { Message } from './messages';
import type { VoiceChannelState, VoiceParticipant } from './voice';
export const OP_DISPATCH = 0;
export const OP_HEARTBEAT = 1;
export const OP_IDENTIFY = 2;
export const OP_PRESENCE_UPDATE = 3;
export const OP_HELLO = 10;
export const OP_HEARTBEAT_ACK = 11;

export type UserStatus = 'ONLINE' | 'IDLE' | 'DND' | 'LOOKING_TO_PLAY' | 'UNAVAILABLE';

export type GatewayUser = {
	id: string;
	username: string;
	tag: string;
	createdAt: Date;
	bot: boolean;
	flags: number;
	bio: string | null;
	avatar?: string | null;
	banner?: string | null;
	customStatus?: CustomStatus | null;
	badges?: string[];
};

export type CustomStatus = {
	text?: string | null;
	emoji?: string | null;
	expiresAt?: number | null;
};

export type GatewayAccount = {
	id: string;
	email: string;
	emailVerified: string;
	locale: string;
};

export type DmPrivacy = 'EVERYONE' | 'SHARED_SERVERS' | 'FRIENDS';

export type GatewaySettings = {
	theme: 'LIGHT' | 'DARK' | 'DIM';
	compactMode: boolean;
	compactShowAvatars: boolean;
	dmPrivacy?: DmPrivacy;
	pendingDeletion: boolean;
	deleteAt: number;
};

export type ChannelType = 'TEXT' | 'VOICE';

export type GatewayChannel = {
	id: string;
	name: string;
	createdAt: string;
	guildId: string;
	rateLimitPerUser?: number;
	type?: ChannelType;
};

export type GatewayMember = {
	id: number;
	nickname: string | null;
	userId: string;
	joinedAt: string;
	roles?: string[];
};

export type GatewayRole = {
	id: string;
	guildId: string;
	name: string;
	color: number;
	hoist: boolean;
	position: number;
	permissions: number;
};

export type GatewayEmoji = {
	id: string;
	guildId: string;
	name: string;
	animated: boolean;
	creatorId: string;
	url: string;
};

export type GatewayGuild = {
	id: string;
	name: string;
	brief: string;
	icon: string | null;
	ownerId: string;
	createdAt: string;
	channels: GatewayChannel[];
	members: GatewayMember[];
	emojis?: GatewayEmoji[];
	roles?: GatewayRole[];
};

export type GatewayPresence = {
	id: string;
	status: UserStatus;
	until?: number | null;
};

export type VoiceStateUpdate = {
	guildId: string;
	channelId: string;
	userId: string;
	voiceState: VoiceParticipant | null;
};

export type ReadyPayload = {
	user: GatewayUser;
	account: GatewayAccount;
	settings: GatewaySettings;
	guilds: GatewayGuild[];
	presences: GatewayPresence[];
	users: Record<string, GatewayUser>;
	voiceStates?: VoiceParticipant[];
};

export type GatewayMessage = {
	op: number;
	d?: unknown;
	t?: string;
	s?: number;
};

export type GatewayState = 'disconnected' | 'connecting' | 'connected' | 'ready';

type Persisted = {
	ws: WebSocket | null;
	heartbeatTimer: number | null;
	readyData: ReadyPayload | null;
	state: GatewayState;
	reconnectTimer: number | null;
	reconnectAttempts: number;
	intentionalClose: boolean;
	netListenersAttached: boolean;
};

const g = globalThis as { __vanillaGateway?: Persisted };
const persisted: Persisted = g.__vanillaGateway ?? {
	ws: null,
	heartbeatTimer: null,
	readyData: null,
	state: 'disconnected',
	reconnectTimer: null,
	reconnectAttempts: 0,
	intentionalClose: false,
	netListenersAttached: false,
};

g.__vanillaGateway = persisted;

const initialState: GatewayState =
	persisted.ws?.readyState === WebSocket.OPEN
		? persisted.readyData
			? 'ready'
			: 'connected'
		: persisted.ws?.readyState === WebSocket.CONNECTING
			? 'connecting'
			: 'disconnected';

const [state, _setState] = createSignal<GatewayState>(initialState);
const [readyData, _setReadyData] = createSignal<ReadyPayload | null>(persisted.readyData);

const setState = (v: GatewayState) => {
	persisted.state = v;
	_setState(v);
};
const setReadyData = (v: ReadyPayload | null) => {
	persisted.readyData = v;
	_setReadyData(v);
};

export function patchSettings(patch: Partial<GatewaySettings>) {
	const r = readyData();
	if (r) setReadyData({ ...r, settings: { ...r.settings, ...patch } });
}

const handlers = new Set<(msg: GatewayMessage) => void>();

export const gatewayState = state;
export const ready = readyData;

export function addGuild(guild: GatewayGuild) {
	const r = readyData();
	if (!r) return;
	const safe: GatewayGuild = {
		...guild,
		channels: guild.channels ?? [],
		members: guild.members ?? [],
	};
	const idx = r.guilds.findIndex((g) => g.id === safe.id);
	if (idx !== -1) {
		const old = r.guilds[idx];
		const merged: GatewayGuild = {
			...old,
			...safe,
			channels: safe.channels.length > 0 ? safe.channels : old.channels,
			members: safe.members.length > 0 ? safe.members : old.members,
		};
		const newGuilds = [...r.guilds];
		newGuilds[idx] = merged;
		setReadyData({ ...r, guilds: newGuilds });
		return;
	}
	setReadyData({ ...r, guilds: [...r.guilds, safe] });
}

export function removeGuild(guildId: string) {
	const r = readyData();
	if (!r) return;
	setReadyData({ ...r, guilds: r.guilds.filter((g) => g.id !== guildId) });
}

function patchGuild(guildId: string, change: (g: GatewayGuild) => GatewayGuild) {
	const r = readyData();
	if (!r) return;
	const idx = r.guilds.findIndex((g) => g.id === guildId);
	if (idx === -1) return;
	const guilds = [...r.guilds];
	guilds[idx] = change(guilds[idx]);
	setReadyData({ ...r, guilds });
}

export function updateGuildDetails(guild: Partial<GatewayGuild> & { id: string }) {
	patchGuild(guild.id, (g) => ({
		...g,
		name: guild.name ?? g.name,
		brief: guild.brief === undefined ? g.brief : guild.brief,
		icon: guild.icon === undefined ? g.icon : guild.icon,
	}));
}

export function updateGuildChannel(channel: GatewayChannel) {
	patchGuild(channel.guildId, (g) => ({
		...g,
		channels: g.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c)),
	}));
}

export function removeGuildChannel(guildId: string, channelId: string) {
	patchGuild(guildId, (g) => ({ ...g, channels: g.channels.filter((c) => c.id !== channelId) }));
}

export function setGuildEmojis(guildId: string, emojis: GatewayEmoji[]) {
	patchGuild(guildId, (g) => ({ ...g, emojis }));
}

export function setGuildRoles(guildId: string, roles: GatewayRole[]) {
	patchGuild(guildId, (g) => {
		const live = new Set(roles.map((r) => r.id));
		return {
			...g,
			roles,
			// A deleted role is gone from its holders too.
			members: g.members.map((m) =>
				m.roles?.some((id) => !live.has(id))
					? { ...m, roles: m.roles.filter((id) => live.has(id)) }
					: m,
			),
		};
	});
}

export function setMemberRoles(guildId: string, userId: string, roles: string[]) {
	patchGuild(guildId, (g) => ({
		...g,
		members: g.members.map((m) => (m.userId === userId ? { ...m, roles } : m)),
	}));
}

export function addGuildChannel(guildId: string, channel: GatewayChannel) {
	const r = readyData();
	if (!r) return;
	const idx = r.guilds.findIndex((g) => g.id === guildId);
	if (idx === -1) return;
	const guild = r.guilds[idx];
	const existing = guild.channels ?? [];
	if (existing.some((c) => c.id === channel.id)) return;
	const newGuild = { ...guild, channels: [...existing, channel] };
	const newGuilds = [...r.guilds];
	newGuilds[idx] = newGuild;
	setReadyData({ ...r, guilds: newGuilds });
}

export function addGuildMember(guildId: string, member: GatewayMember) {
	const r = readyData();
	if (!r) return;
	const idx = r.guilds.findIndex((g) => g.id === guildId);
	if (idx === -1) return;
	const guild = r.guilds[idx];
	const existing = guild.members ?? [];
	if (existing.some((m) => m.userId === member.userId)) return;
	const newGuild = { ...guild, members: [...existing, member] };
	const newGuilds = [...r.guilds];
	newGuilds[idx] = newGuild;
	setReadyData({ ...r, guilds: newGuilds });
}

export function removeGuildMember(guildId: string, userId: string) {
	const r = readyData();
	if (!r) return;
	const idx = r.guilds.findIndex((g) => g.id === guildId);
	if (idx === -1) return;
	const guild = r.guilds[idx];
	const newGuild = {
		...guild,
		members: (guild.members ?? []).filter((m) => m.userId !== userId),
	};
	const newGuilds = [...r.guilds];
	newGuilds[idx] = newGuild;
	setReadyData({ ...r, guilds: newGuilds });
}

export function applyPresence(userId: string, status: UserStatus, until?: number | null) {
	const r = readyData();
	if (!r) return;
	const presences = r.presences ?? [];
	const idx = presences.findIndex((p) => p.id === userId);
	const next =
		idx === -1
			? [...presences, { id: userId, status, until: until ?? null }]
			: presences.map((p) =>
					p.id === userId ? { ...p, status, until: until === undefined ? p.until : until } : p,
				);
	setReadyData({ ...r, presences: next });
}

export function setVoiceChannelState(next: VoiceChannelState) {
	const r = readyData();
	if (!r) return;

	const current = r.voiceStates ?? [];
	const withoutChannel = current.filter((p) => p.channelId !== next.channelId);

	setReadyData({
		...r,
		voiceStates: [...withoutChannel, ...next.participants],
	});
}

export function applyVoiceStateUpdate(update: VoiceStateUpdate) {
	const r = readyData();
	if (!r || !update.userId) return;

	const current = r.voiceStates ?? [];

	const withoutUser = current.filter((p) => p.userId !== update.userId);

	setReadyData({
		...r,
		voiceStates: update.voiceState ? [...withoutUser, update.voiceState] : withoutUser,
	});
}

export function upsertUser(user: GatewayUser) {
	const r = readyData();
	if (!r || !user?.id) return;
	const users = { ...(r.users ?? {}), [user.id]: { ...(r.users?.[user.id] ?? {}), ...user } };
	setReadyData({
		...r,
		users,
		...(r.user?.id === user.id ? { user: { ...r.user, ...user } } : {}),
	});
}

export function upsertDmUsers(list: DmChannel[]) {
	list.forEach((d) => {
		d.members.forEach((m) => {
			upsertUser(m);
		});
	});
}

export function upsertUsers(users: GatewayUser[] | Record<string, GatewayUser> | undefined) {
	if (!users) return;
	const r = readyData();
	if (!r) return;
	const entries = Array.isArray(users)
		? users.map((u) => [u.id, u] as const)
		: Object.entries(users);
	if (entries.length === 0) return;
	const merged = { ...(r.users ?? {}) };
	for (const [id, u] of entries) {
		if (!id) continue;
		merged[id] = { ...(merged[id] ?? {}), ...u };
	}
	setReadyData({ ...r, users: merged });
}

function resolveGatewayUrl(): string {
	const url = process.env.GATEWAY_URL;
	if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
	const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${proto}//${window.location.host}${url}`;
}

function attachHandlers(socket: WebSocket) {
	socket.onopen = () => {
		persisted.reconnectAttempts = 0;
		setState('connected');
	};
	socket.onclose = () => {
		clearHeartbeat();
		setReadyData(null);
		setState('disconnected');
		persisted.ws = null;
		if (!persisted.intentionalClose) scheduleReconnect();
	};
	socket.onerror = () => {};
	socket.onmessage = (e) => {
		let msg: GatewayMessage;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		handleMessage(msg);
		handlers.forEach((handler) => {
			handler(msg);
		});
	};
}

function clearReconnect() {
	if (persisted.reconnectTimer !== null) {
		clearTimeout(persisted.reconnectTimer);
		persisted.reconnectTimer = null;
	}
}

function scheduleReconnect() {
	clearReconnect();
	const attempt = persisted.reconnectAttempts++;
	const base = Math.min(30000, 1000 * 2 ** attempt);
	const jitter = Math.random() * 500;
	const delay = base + jitter;
	persisted.reconnectTimer = window.setTimeout(() => {
		persisted.reconnectTimer = null;
		if (persisted.intentionalClose) return;
		if (typeof navigator !== 'undefined' && !navigator.onLine) return;
		connect();
	}, delay);
}

function attachNetListeners() {
	if (persisted.netListenersAttached) return;
	persisted.netListenersAttached = true;
	window.addEventListener('online', () => {
		if (persisted.intentionalClose) return;
		const ws = persisted.ws;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
		persisted.reconnectAttempts = 0;
		clearReconnect();
		connect();
	});
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState !== 'visible') return;
		if (persisted.intentionalClose) return;
		const ws = persisted.ws;
		if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
		persisted.reconnectAttempts = 0;
		clearReconnect();
		connect();
	});
}

// Re-attach handlers on hot reload if WS already exists
if (
	persisted.ws &&
	(persisted.ws.readyState === WebSocket.OPEN || persisted.ws.readyState === WebSocket.CONNECTING)
) {
	attachHandlers(persisted.ws);
}

export function connect() {
	attachNetListeners();
	persisted.intentionalClose = false;
	const existing = persisted.ws;
	if (
		existing &&
		(existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
	) {
		return;
	}
	clearReconnect();
	setState('connecting');
	const socket = new WebSocket(resolveGatewayUrl());
	persisted.ws = socket;
	attachHandlers(socket);
}

function handleMessage(msg: GatewayMessage) {
	if (msg.op === OP_HELLO) {
		const interval =
			(msg.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 30000;
		sendIdentify();
		sendHeartbeat();
		clearHeartbeat();
		persisted.heartbeatTimer = window.setInterval(sendHeartbeat, interval);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'READY') {
		const d = msg.d as ReadyPayload & {
			guilds?: (GatewayGuild & { members?: (GatewayMember & { user?: GatewayUser })[] })[];
		};
		const users: Record<string, GatewayUser> = { ...(d.users ?? {}) };
		if (d.user?.id) users[d.user.id] ??= d.user;
		for (const g of d.guilds ?? []) {
			for (const m of g.members ?? []) {
				if (m.user?.id) users[m.user.id] ??= m.user;
			}
		}
		setReadyData({ ...d, users, voiceStates: d.voiceStates ?? [] });
		setState('ready');
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_CREATE') {
		const d = msg.d as
			| (GatewayGuild & {
					guild?: GatewayGuild;
					channels?: GatewayChannel[];
					members?: (GatewayMember & { user?: GatewayUser })[];
					users?: GatewayUser[] | Record<string, GatewayUser>;
			  })
			| undefined;
		if (!d) return;
		const inner = d.guild ?? d;
		const channels = d.channels ?? inner?.channels ?? [];
		const rawMembers = (d.members ?? inner?.members ?? []) as (GatewayMember & {
			user?: GatewayUser;
		})[];
		const stripped: GatewayMember[] = rawMembers.map((m) => ({
			id: m.id,
			nickname: m.nickname,
			userId: m.userId,
			joinedAt: m.joinedAt,
			roles: m.roles ?? [],
		}));
		const inlineUsers = rawMembers.flatMap((m) => (m.user ? [m.user] : []));
		upsertUsers(d.users ?? inlineUsers);
		if (inner?.id) {
			addGuild({ ...inner, channels, members: stripped });
		}
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'CHANNEL_CREATE') {
		const d = msg.d as GatewayChannel | undefined;
		if (d?.id && d?.guildId) addGuildChannel(d.guildId, d);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'CHANNEL_UPDATE') {
		const d = msg.d as GatewayChannel | undefined;
		if (d?.id && d?.guildId) updateGuildChannel(d);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'CHANNEL_DELETE') {
		const d = msg.d as { id?: string; guildId?: string } | undefined;
		if (d?.id && d?.guildId) removeGuildChannel(d.guildId, d.id);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_UPDATE') {
		const d = msg.d as (Partial<GatewayGuild> & { id?: string }) | undefined;
		if (d?.id) updateGuildDetails({ ...d, id: d.id });
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_EMOJIS_UPDATE') {
		const d = msg.d as { guildId?: string; emojis?: GatewayEmoji[] } | undefined;
		if (d?.guildId) setGuildEmojis(d.guildId, d.emojis ?? []);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'PINGS_READ') {
		const d = msg.d as { channelIds?: string[] | null } | undefined;
		applyRemoteRead(d?.channelIds ?? null);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_ROLES_UPDATE') {
		const d = msg.d as { guildId?: string; roles?: GatewayRole[] } | undefined;
		if (d?.guildId) setGuildRoles(d.guildId, d.roles ?? []);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_MEMBER_UPDATE') {
		const d = msg.d as { guildId?: string; userId?: string; roles?: string[] } | undefined;
		if (d?.guildId && d?.userId) setMemberRoles(d.guildId, d.userId, d.roles ?? []);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_DELETE') {
		const guildId = (msg.d as { id?: string } | undefined)?.id;
		if (guildId) removeGuild(guildId);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_MEMBER_ADD') {
		const d = msg.d as
			| {
					guildId: string;
					nickname: string | null;
					userId: string;
					user?: GatewayUser;
			  }
			| undefined;
		if (d?.guildId && d?.userId) {
			if (d.user) upsertUser(d.user);
			addGuildMember(d.guildId, {
				id: 0,
				nickname: d.nickname ?? null,
				userId: d.userId,
				joinedAt: new Date().toISOString(),
			});
		}
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'GUILD_MEMBER_REMOVE') {
		const d = msg.d as { guildId?: string; userId?: string; user?: { id?: string } } | undefined;
		const userId = d?.userId ?? d?.user?.id;
		if (!d?.guildId || !userId) return;
		// Removed yourself (kicked): the server is gone from your list.
		if (userId === readyData()?.user.id) removeGuild(d.guildId);
		else removeGuildMember(d.guildId, userId);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'PRESENCE_UPDATE') {
		const d = msg.d as
			| { id?: string; userId?: string; status?: UserStatus; until?: number | null }
			| undefined;
		const id = d?.id ?? d?.userId;
		if (id && d?.status) applyPresence(id, d.status, d.until);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'USER_UPDATE') {
		const d = msg.d as { user?: GatewayUser } | undefined;
		if (d?.user) upsertUser(d.user);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'VOICE_STATE_UPDATE') {
		const d = msg.d as VoiceStateUpdate | undefined;

		if (d?.userId && d?.channelId) {
			applyVoiceStateUpdate(d);
		}

		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'MESSAGE_CREATE') {
		const m = msg.d as Message & { author?: GatewayUser };
		if (m.author) upsertUser(m.author);
		addMessage(m);
		if (!m.guildId) {
			if (getDm(m.channelId)) bumpDm(m.channelId, Number(m.createdAt));
			else
				loadDms()
					.then(upsertDmUsers)
					.catch(() => {});
		}
		const me = readyData()?.user ?? undefined;
		const unread = noteIncomingMessage(m, me);
		const dnd = readyData()?.presences?.find((p) => p.id === me?.id)?.status === 'DND';
		if (unread && !dnd && prefs().pingSound) playPing();
		return;
	}

	if (msg.op === OP_DISPATCH && (msg.t === 'DM_CHANNEL_CREATE' || msg.t === 'DM_CHANNEL_UPDATE')) {
		const dm = msg.d as DmChannel;
		upsertDmUsers([dm]);
		upsertDm(dm);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'RELATIONSHIP_ADD') {
		upsertRelationship(msg.d as Relationship);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'RELATIONSHIP_REMOVE') {
		removeRelationship((msg.d as { userId: string }).userId);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'DM_CHANNEL_DELETE') {
		removeDm((msg.d as { id: string }).id);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'MESSAGE_UPDATE') {
		const m = msg.d as Message & { author?: GatewayUser };
		if (m.author) upsertUser(m.author);
		updateMessage(m);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'MESSAGE_DELETE') {
		const d = msg.d as { id?: string; channelId?: string } | undefined;
		if (d?.id && d?.channelId) removeMessage(d.channelId, d.id);
		return;
	}

	if (msg.op === OP_DISPATCH && msg.t === 'TYPING_START') {
		const d = msg.d as
			| {
					channelId?: string;
					channel_id?: string;
					userId?: string;
					user_id?: string;
					user?: {
						username?: string;
						member?: { nickname: string | null } | null;
					};
			  }
			| undefined;
		const channelId = d?.channelId ?? d?.channel_id;
		const userId = d?.userId ?? d?.user_id;
		if (!channelId || !userId) return;
		if (userId === readyData()?.user?.id) return;
		addTyping(channelId, {
			userId,
			username: d?.user?.member?.nickname ?? d?.user?.username ?? 'someone',
			expiresAt: Date.now() + 6000,
		});
		return;
	}
}

function sendHeartbeat() {
	send({ op: OP_HEARTBEAT, d: null });
}

function sendIdentify() {
	send({
		op: OP_IDENTIFY,
		d: {
			clientSessionId: getClientSessionId(),
		},
	});
}

function clearHeartbeat() {
	if (persisted.heartbeatTimer !== null) {
		clearInterval(persisted.heartbeatTimer);
		persisted.heartbeatTimer = null;
	}
}

export function disconnect() {
	persisted.intentionalClose = true;
	clearReconnect();
	persisted.reconnectAttempts = 0;
	clearHeartbeat();
	persisted.ws?.close();
	persisted.ws = null;
	setReadyData(null);
	setState('disconnected');
}

export function send(payload: unknown) {
	if (persisted.ws?.readyState === WebSocket.OPEN) {
		persisted.ws.send(JSON.stringify(payload));
	}
}

export function updatePresence(status: UserStatus, durationMs?: number) {
	send({ op: OP_PRESENCE_UPDATE, d: { status, ...(durationMs ? { durationMs } : {}) } });
	const r = readyData();
	if (r?.user) {
		applyPresence(r.user.id, status, durationMs ? Date.now() + durationMs : null);
	}
}

export const ownStatusUntil = (): number | null => {
	const r = readyData();
	const me = r?.user?.id;
	return (me && r?.presences?.find((p) => p.id === me)?.until) || null;
};

export function onMessage(handler: (msg: GatewayMessage) => void): () => void {
	handlers.add(handler);
	return () => handlers.delete(handler);
}
