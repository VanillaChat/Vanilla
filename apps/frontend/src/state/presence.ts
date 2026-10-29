import { createEffect, onCleanup } from 'solid-js';
import { t } from '../i18n';
import { DM_SCOPE } from './dms';
import { currentUser, findChannel, guilds, voiceStates } from './gateway-data';
import { prefs } from './prefs';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke = (): Invoke | undefined =>
	(window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;

export const isDesktop = () => !!invoke();

const startedAt = Math.floor(Date.now() / 1000);

export function usePresence(where: () => { serverId?: string; channelId?: string }) {
	createEffect(() => {
		const call = invoke();
		if (!call) return;
		if (!prefs().discordPresence || !currentUser()) {
			call('clear_presence').catch(() => {});
			return;
		}

		const me = currentUser()?.id;
		const voice = voiceStates().find((p) => p.userId === me);
		const { serverId, channelId } = where();
		const inDm = serverId === DM_SCOPE;
		const channel = findChannel(voice?.channelId ?? (inDm ? undefined : channelId));
		const guildId = voice
			? guilds().find((g) => g.channels?.some((c) => c.id === voice.channelId))?.id
			: serverId;
		const guild = guilds().find((g) => g.id === guildId);

		let details = t('presence-idle');
		if (voice && channel) details = t('presence-voice', { channel: channel.name });
		else if (inDm) details = t('presence-dm');
		else if (channel) details = t('presence-channel', { channel: channel.name });

		call('set_presence', {
			activity: { details, state: guild?.name, startedAt },
		}).catch(() => {});
	});
	onCleanup(() => {
		invoke()?.('clear_presence').catch(() => {});
	});
}
