import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js';
import type { VoiceParticipant } from '../../api/voice';
import { useProfile } from '../../contexts/profile';
import { t } from '../../i18n';
import {
	currentUser,
	getUser,
	guilds,
	useVoiceParticipants,
	voicePresence,
} from '../../state/gateway-data';
import {
	isDeafened,
	isMuted,
	joinVoiceChannel,
	leaveVoiceChannel,
	localCameraStream,
	localScreenStream,
	setUserVolume,
	speakingSsrcs,
	startCamera,
	startScreenShare,
	stopVideo,
	toggleDeafen,
	toggleMute,
	voiceChannel,
	voiceError,
	voiceQuality,
	voiceStatus,
	watchedSsrcs,
	watchStream,
} from '../../voice/engine';
import { voiceSettings } from '../../voice/settings';
import { Avatar } from '../Avatar';
import { Slider } from '../ui/Slider';
import { Tooltip } from '../ui/Tooltip';
import { qualityLabel } from '../voice/quality';
import { LocalVideo, RemoteVideo } from '../voice/VideoView';

const TAG_SCREEN = 2;
const TAG_CAMERA = 3;

function ControlButton(props: {
	icon: string;
	title: string;
	onClick: () => void;
	active?: boolean;
	danger?: boolean;
	disabled?: boolean;
	badge?: number;
}) {
	return (
		<Tooltip text={props.title}>
			<button
				type="button"
				aria-label={props.title}
				aria-pressed={props.active}
				disabled={props.disabled}
				onClick={props.onClick}
				class="relative w-12 h-12 rounded-2xl flex items-center justify-center transition-colors disabled:opacity-40"
				classList={{
					'bg-[#f7e26c] text-stone-900': props.active && !props.danger,
					'bg-red-500 text-white hover:bg-red-600': props.danger,
					'bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700':
						!props.active && !props.danger,
				}}
			>
				<i class={`fa-solid ${props.icon}`} />
				<Show when={props.badge}>
					<span class="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center ring-2 ring-white dark:ring-[#211e1b]">
						{(props.badge ?? 0) > 99 ? '99+' : props.badge}
					</span>
				</Show>
			</button>
		</Tooltip>
	);
}

function ParticipantTile(props: { p: VoiceParticipant; connected: boolean }) {
	const me = () => props.p.userId === currentUser()?.id;
	const user = () => getUser(props.p.userId) ?? (me() ? currentUser() : undefined);
	const speaking = () => speakingSsrcs().has(props.p.ssrc);
	const watched = () => watchedSsrcs().has(props.p.ssrc);
	const live = () => props.p.screenSharing || props.p.camera;
	const [showVolume, setShowVolume] = createSignal(false);
	const volume = () => voiceSettings().userVolumes[props.p.userId] ?? 1;

	return (
		<div
			class="relative rounded-2xl bg-[#fdfaf3] dark:bg-stone-900/40 border-2 transition-colors p-4 flex flex-col items-center gap-2"
			classList={{
				'border-green-500': speaking(),
				'border-stone-100 dark:border-stone-800': !speaking(),
			}}
		>
			<Show when={user()}>
				{(u) => <Avatar user={u()} status={voicePresence(props.p.userId)} size={56} />}
			</Show>
			<div class="text-sm text-stone-800 dark:text-stone-100 truncate max-w-full">
				{user()?.username ?? props.p.userId}
				<Show when={me()}>
					<span class="text-stone-400"> ({t('voice-you')})</span>
				</Show>
			</div>

			<div class="absolute top-2 right-2 flex items-center gap-1.5 text-xs">
				<Show when={props.p.selfDeaf}>
					<i class="fa-solid fa-volume-xmark text-red-500" />
				</Show>
				<Show when={props.p.selfMute && !props.p.selfDeaf}>
					<i class="fa-solid fa-microphone-slash text-red-500" />
				</Show>
			</div>

			<Show when={live() && !me() && props.connected}>
				<button
					type="button"
					onClick={() => watchStream(props.p.ssrc, !watched())}
					class="text-xs px-2.5 py-1 rounded-lg font-medium"
					classList={{
						'bg-red-500 text-white': !watched(),
						'bg-stone-200 dark:bg-stone-700 text-stone-700 dark:text-stone-200': watched(),
					}}
				>
					{watched() ? t('voice-stop-watching') : `${t('voice-live')} · ${t('voice-watch')}`}
				</button>
			</Show>

			<Show when={!me() && props.connected}>
				<div class="absolute top-2 left-2">
					<Tooltip text={t('voice-user-volume')}>
						<button
							type="button"
							aria-label={t('voice-user-volume')}
							onClick={() => setShowVolume(!showVolume())}
							class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 text-xs"
						>
							<i class="fa-solid fa-sliders" />
						</button>
					</Tooltip>
				</div>
				<Show when={showVolume()}>
					<Slider
						min={0}
						max={2}
						step={0.05}
						value={volume()}
						label={t('voice-user-volume')}
						onInput={(v) => setUserVolume(props.p.userId, v)}
						class="w-full"
					/>
				</Show>
			</Show>
		</div>
	);
}

function StreamCard(props: { title: string; children: JSX.Element }) {
	let box!: HTMLDivElement;
	const [full, setFull] = createSignal(false);

	const toggleFullscreen = () => {
		if (document.fullscreenElement) void document.exitFullscreen();
		else void box.requestFullscreen?.().catch(() => {});
	};

	onMount(() => {
		const sync = () => setFull(document.fullscreenElement === box);
		document.addEventListener('fullscreenchange', sync);
		onCleanup(() => document.removeEventListener('fullscreenchange', sync));
	});

	return (
		<div
			ref={box}
			class="group relative rounded-2xl overflow-hidden bg-black border border-stone-800 flex flex-col"
			classList={{ 'rounded-none': full() }}
		>
			<div
				class="w-full"
				classList={{
					'aspect-video': !full(),
					'flex-1 min-h-0': full(),
					'max-h-[78vh]': !full(),
				}}
			>
				{props.children}
			</div>
			<div class="px-3 py-1.5 text-xs text-stone-300 bg-stone-900">{props.title}</div>
			<div class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
				<Tooltip text={full() ? t('voice-exit-fullscreen') : t('voice-fullscreen')}>
					<button
						type="button"
						aria-label={full() ? t('voice-exit-fullscreen') : t('voice-fullscreen')}
						onClick={toggleFullscreen}
						class="w-9 h-9 rounded-xl bg-black/60 hover:bg-black/80 text-white flex items-center justify-center"
					>
						<i class={`fa-solid ${full() ? 'fa-compress' : 'fa-expand'}`} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}

export function VoiceChannelView(props: {
	channelId: string;
	channelName: string;
	guildId: string;
	chatOpen: boolean;
	chatUnread: number;
	onToggleChat: () => void;
}) {
	const participants = useVoiceParticipants(() => props.channelId);
	const { openSettings: openAppSettings } = useProfile();
	const openSettings = () => openAppSettings('voice');

	const connectedHere = createMemo(
		() => voiceStatus() === 'connected' && voiceChannel()?.channelId === props.channelId,
	);
	const connecting = createMemo(
		() => voiceStatus() === 'connecting' && voiceChannel()?.channelId === props.channelId,
	);
	const connectedElsewhere = createMemo(
		() => voiceStatus() !== 'idle' && voiceChannel()?.channelId !== props.channelId,
	);

	const elsewhereName = createMemo(() => {
		const active = voiceChannel();
		if (!active) return '';
		const guild = guilds().find((g) => g.id === active.guildId);
		return guild?.channels.find((c) => c.id === active.channelId)?.name ?? '';
	});

	const nameOf = (userId: string) => getUser(userId)?.username ?? userId;

	const streamCards = createMemo(() => {
		const cards: Array<{ ssrc: number; tag: number; title: string }> = [];
		for (const p of participants()) {
			if (p.userId === currentUser()?.id || !watchedSsrcs().has(p.ssrc)) continue;
			if (p.screenSharing) {
				cards.push({
					ssrc: p.ssrc,
					tag: TAG_SCREEN,
					title: t('voice-screen-of', { name: nameOf(p.userId) }),
				});
			}
			if (p.camera) {
				cards.push({
					ssrc: p.ssrc,
					tag: TAG_CAMERA,
					title: t('voice-camera-of', { name: nameOf(p.userId) }),
				});
			}
		}
		return cards;
	});

	const join = () => joinVoiceChannel(props.channelId, props.guildId);

	return (
		<div class="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-4 sm:py-6 flex flex-col gap-4">
			<div class="text-center">
				<h2 class="font-display text-3xl">{props.channelName}</h2>
				<p class="text-sm text-stone-500 italic font-display mt-1 whitespace-nowrap">
					<Show when={connectedHere()} fallback={t('voice-title')}>
						{qualityLabel(voiceQuality())}
					</Show>
				</p>
			</div>

			<Show when={localScreenStream() || localCameraStream() || streamCards().length > 0}>
				<div class="grid gap-3 grid-cols-1">
					<Show when={localScreenStream()}>
						<StreamCard title={t('voice-sharing-screen')}>
							<LocalVideo stream={localScreenStream()} />
						</StreamCard>
					</Show>
					<Show when={localCameraStream()}>
						<StreamCard title={t('voice-sharing-camera')}>
							<LocalVideo stream={localCameraStream()} />
						</StreamCard>
					</Show>
					<For each={streamCards()}>
						{(c) => (
							<StreamCard title={c.title}>
								<RemoteVideo ssrc={c.ssrc} tag={c.tag} />
							</StreamCard>
						)}
					</For>
				</div>
			</Show>

			<Show
				when={participants().length > 0}
				fallback={
					<div class="text-center text-sm text-stone-400 italic font-display py-6">
						{t('voice-nobody')}
					</div>
				}
			>
				<div class="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
					<For each={participants()}>
						{(p) => <ParticipantTile p={p} connected={connectedHere()} />}
					</For>
				</div>
			</Show>

			<div class="mt-auto pt-2 flex flex-col items-center gap-3">
				<Show when={voiceError()}>
					<div class="text-sm text-red-600 dark:text-red-400 text-center">{voiceError()}</div>
				</Show>

				<Show
					when={connectedHere()}
					fallback={
						<div class="flex flex-col items-center gap-2">
							<Show when={connectedElsewhere()}>
								<p class="text-xs text-stone-500 italic font-display">
									{t('voice-connected-elsewhere', { channel: elsewhereName() })}
								</p>
							</Show>
							<div class="flex items-center gap-3">
								<button
									type="button"
									onClick={join}
									disabled={connecting()}
									class="rounded-2xl bg-[#f7e26c] text-stone-900 px-6 py-3 font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow disabled:opacity-60"
								>
									<i class={`fa-solid ${connecting() ? 'fa-spinner fa-spin' : 'fa-phone'} mr-2`} />
									{connecting() ? t('voice-connecting') : t('voice-join')}
								</button>
								<ControlButton
									icon="fa-comment"
									title={t('voice-chat')}
									active={props.chatOpen}
									badge={props.chatUnread}
									onClick={props.onToggleChat}
								/>
								<ControlButton
									icon="fa-sliders"
									title={t('voice-settings')}
									onClick={openSettings}
								/>
							</div>
						</div>
					}
				>
					<div class="flex flex-wrap items-center justify-center gap-2">
						<ControlButton
							icon={isMuted() ? 'fa-microphone-slash' : 'fa-microphone'}
							title={isMuted() ? t('voice-unmute') : t('voice-mute')}
							active={isMuted()}
							danger={isMuted()}
							onClick={toggleMute}
						/>
						<ControlButton
							icon={isDeafened() ? 'fa-volume-xmark' : 'fa-headphones'}
							title={isDeafened() ? t('voice-undeafen') : t('voice-deafen')}
							active={isDeafened()}
							danger={isDeafened()}
							onClick={toggleDeafen}
						/>
						<ControlButton
							icon="fa-comment"
							title={t('voice-chat')}
							active={props.chatOpen}
							badge={props.chatUnread}
							onClick={props.onToggleChat}
						/>
						<ControlButton
							icon="fa-video"
							title={localCameraStream() ? t('voice-camera-off') : t('voice-camera-on')}
							active={!!localCameraStream()}
							onClick={() => (localCameraStream() ? stopVideo('camera') : void startCamera())}
						/>
						<ControlButton
							icon="fa-display"
							title={localScreenStream() ? t('voice-stop-share') : t('voice-share-screen')}
							active={!!localScreenStream()}
							onClick={() => (localScreenStream() ? stopVideo('screen') : void startScreenShare())}
						/>
						<ControlButton icon="fa-sliders" title={t('voice-settings')} onClick={openSettings} />
						<ControlButton
							icon="fa-phone-slash"
							title={t('voice-leave')}
							danger
							active
							onClick={() => void leaveVoiceChannel()}
						/>
					</div>
				</Show>
			</div>
		</div>
	);
}
