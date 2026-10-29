import { api } from './client';
import type { GatewayRole } from './gateway';

export type RoleInput = { name: string; color?: number; hoist?: boolean; permissions?: number };

const base = (guildId: string) => `/guilds/${guildId}/roles`;

export const createRole = (guildId: string, input: RoleInput) =>
	api<GatewayRole>(base(guildId), { method: 'POST', json: input });

export const updateRole = (guildId: string, roleId: string, input: Partial<RoleInput>) =>
	api<GatewayRole>(`${base(guildId)}/${roleId}`, { method: 'PATCH', json: input });

export const deleteRole = (guildId: string, roleId: string) =>
	api<void>(`${base(guildId)}/${roleId}`, { method: 'DELETE' });

export const reorderRoles = (guildId: string, roleIds: string[]) =>
	api<GatewayRole[]>(`${base(guildId)}/reorder`, { method: 'POST', json: { roleIds } });

export const giveRole = (guildId: string, userId: string, roleId: string) =>
	api<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'PUT' });

export const takeRole = (guildId: string, userId: string, roleId: string) =>
	api<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'DELETE' });

export const kickMember = (guildId: string, userId: string) =>
	api<void>(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE' });
