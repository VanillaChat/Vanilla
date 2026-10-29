import { api } from './client';
import { type DmPrivacy, patchSettings } from './gateway';

export async function updateDmPrivacy(dmPrivacy: DmPrivacy): Promise<void> {
	await api<void>('/users/@me/user-settings', { method: 'PATCH', json: { dmPrivacy } });
	patchSettings({ dmPrivacy });
}
