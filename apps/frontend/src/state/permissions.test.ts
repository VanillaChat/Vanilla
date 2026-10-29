import { describe, expect, test } from 'bun:test';
import type { GatewayGuild } from '../api/gateway';
import { ALL_PERMS, OWNER_RANK, Perm, standingIn } from './permissions';

const guild = (over: Partial<GatewayGuild> = {}): GatewayGuild => ({
	id: 'g',
	name: 'g',
	brief: '',
	icon: null,
	ownerId: 'owner',
	createdAt: '',
	channels: [],
	members: [
		{ id: 1, nickname: null, userId: 'mod', joinedAt: '', roles: ['r1'] },
		{ id: 2, nickname: null, userId: 'plain', joinedAt: '', roles: [] },
		{ id: 3, nickname: null, userId: 'boss', joinedAt: '', roles: ['r2'] },
	],
	roles: [
		{
			id: 'g',
			guildId: 'g',
			name: '@everyone',
			color: 0,
			hoist: false,
			position: 0,
			permissions: Perm.SEND_MESSAGES,
		},
		{
			id: 'r1',
			guildId: 'g',
			name: 'Mod',
			color: 0xff0000,
			hoist: false,
			position: 1,
			permissions: Perm.KICK_MEMBERS,
		},
		{
			id: 'r2',
			guildId: 'g',
			name: 'Boss',
			color: 0,
			hoist: false,
			position: 2,
			permissions: Perm.ADMINISTRATOR,
		},
	],
	...over,
});

describe('standingIn', () => {
	test('the owner can do everything and outranks all', () => {
		const s = standingIn(guild(), 'owner');
		expect(s.permissions).toBe(ALL_PERMS);
		expect(s.rank).toBe(OWNER_RANK);
	});

	test('everyone and held roles add up', () => {
		const s = standingIn(guild(), 'mod');
		expect(s.permissions).toBe(Perm.SEND_MESSAGES | Perm.KICK_MEMBERS);
		expect(s.rank).toBe(1);
	});

	test('a member without roles gets @everyone only', () => {
		expect(standingIn(guild(), 'plain').permissions).toBe(Perm.SEND_MESSAGES);
	});

	test('administrator is everything', () => {
		expect(standingIn(guild(), 'boss').permissions).toBe(ALL_PERMS);
	});

	test('an unknown guild grants nothing', () => {
		expect(standingIn(undefined, 'x').permissions).toBe(0);
	});
});
