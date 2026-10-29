import { api } from './client';
import type { GatewayUser } from './gateway';

export type CustomStatusInput = {
	text?: string;
	emoji?: string;
	durationMs?: number;
};

export function setCustomStatus(input: CustomStatusInput): Promise<GatewayUser> {
	return api<GatewayUser>('/users/@me/custom-status', { method: 'PUT', json: input });
}
