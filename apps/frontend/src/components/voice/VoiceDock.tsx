import { Link } from '@tanstack/solid-router';
import { Show } from 'solid-js';
import { t } from '../../i18n';
import { guilds } from '../../state/gateway-data';
import {
	isDeafened,
	isMuted,
	leaveVoiceChannel,
	toggleDeafen,
	toggleMute,
	voiceChannel,
	voiceQuality,
	voiceStatus,
} from '../../voice/engine';
import { Tooltip } from '../ui/Tooltip';
import { qualityLabel } from './quality';

export function VoiceDock() {
	const info = () => {
		const active = voiceChannel();
		if (!active) return null;
		const guild = guilds().find((g) => g.id === active.guildId);
		const channel = guild?.channels.find((c) => c.id === active.channelId);
		return { ...active, name: channel?.name ?? '', guildName: guild?.name ?? '' };
	};

	return (
		<Show when={voiceStatus() !== 'idle' && info()}>
			{(i) => (
				<div class="shrink-0 mx-3 mb-2 rounded-2xl bg-[#e6d8a8] dark:bg-[#2c2724] px-3 py-2.5 flex items-center gap-2">
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2 min-w-0 text-sm font-semibold text-green-700 dark:text-green-400">
							<i class="fa-solid fa-signal text-sm" />
							<span class="truncate whitespace-nowrap">
								{voiceStatus() === 'connecting'
									? t('voice-connecting')
									: qualityLabel(voiceQuality())}
							</span>
						</div>
						<Link
							to="/app/$serverId/$channelId"
							params={{ serverId: i().guildId, channelId: i().channelId }}
							viewTransition={false}
							title={t('voice-back-to-channel')}
							class="block text-sm text-stone-800 dark:text-stone-100 truncate hover:underline underline-offset-2 decoration-stone-400"
						>
							{i().name}
							<span class="text-stone-500"> / {i().guildName}</span>
						</Link>
					</div>
					<Tooltip text={isMuted() ? t('voice-unmute') : t('voice-mute')}>
						<button
							aria-label={isMuted() ? t('voice-unmute') : t('voice-mute')}
							type="button"
							onClick={toggleMute}
							class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 text-stone-700 dark:text-stone-200"
						>
							<i
								class={`fa-solid ${isMuted() ? 'fa-microphone-slash text-red-500' : 'fa-microphone'} text-sm`}
							/>
						</button>
					</Tooltip>
					<Tooltip text={isDeafened() ? t('voice-undeafen') : t('voice-deafen')}>
						<button
							aria-label={isDeafened() ? t('voice-undeafen') : t('voice-deafen')}
							type="button"
							onClick={toggleDeafen}
							class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 text-stone-700 dark:text-stone-200"
						>
							<i
								class={`fa-solid ${isDeafened() ? 'fa-volume-xmark text-red-500' : 'fa-headphones'} text-sm`}
							/>
						</button>
					</Tooltip>
					<Tooltip text={t('voice-leave')}>
						<button
							aria-label={t('voice-leave')}
							type="button"
							onClick={() => void leaveVoiceChannel()}
							class="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-red-500/15 text-red-600"
						>
							<i class="fa-solid fa-phone-slash text-sm" />
						</button>
					</Tooltip>
				</div>
			)}
		</Show>
	);
}
