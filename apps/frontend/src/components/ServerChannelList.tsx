import { Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { GatewayUser } from '../api/gateway';
import { useLayout } from '../contexts/layout';
import { t } from '../i18n';
import { avatarBackdrop } from '../state/default-avatar';
import { DM_SCOPE, dmChannels, dmOthers, dmTitle } from '../state/dms';
import { incomingRequests } from '../state/friends';
import {
	currentUser,
	getUser,
	guilds,
	userPresence,
	useVoiceParticipants,
	voicePresence,
} from '../state/gateway-data';
import { openGroupModal } from '../state/group-modal';
import { mentionCounts } from '../state/mentions';
import { speakingSsrcs } from '../voice/engine';
import { Avatar, statusColors, statusLabels } from './Avatar';
import { ChannelMenu, type ChannelMenuState } from './app/ChannelMenu';
import { InboxBell } from './app/InboxBell';
import { DefaultAvatar } from './ui/DefaultAvatar';
import { VoiceDock } from './voice/VoiceDock';

interface Props {
	currentServerId: () => string | undefined;
	currentChannelId: () => string | undefined;
	onAddServer?: () => void;
	onAddChannel?: (guildId: string) => void;
	canAddChannel?: (guildId: string) => boolean;
	canOpenServerSettings?: (guildId: string) => boolean;
	onOpenProfile?: (user: GatewayUser, e: MouseEvent) => void;
	onOpenSettings?: () => void;
	onOpenServerSettings?: (guildId: string) => void;
	onOpenChannelSettings?: (channelId: string) => void;
}

export function ServerChannelList(props: Props) {
	const layout = useLayout();
	const [overrides, setOverrides] = createSignal<Record<string, boolean>>({});

	const isExpanded = (id: string) => {
		const o = overrides();
		if (id in o) return o[id];
		return id === props.currentServerId();
	};

	const toggle = (id: string) => {
		setOverrides({ ...overrides(), [id]: !isExpanded(id) });
	};

	const dmMentions = () => dmChannels().reduce((sum, d) => sum + (mentionCounts()[d.id] ?? 0), 0);
	const homeBadge = () => dmMentions() + incomingRequests().length;
	const friendsActive = () => props.currentServerId() === DM_SCOPE && !props.currentChannelId();

	const [channelMenu, setChannelMenu] = createSignal<ChannelMenuState | null>(null);
	const canManage = (guildId: string) => props.canAddChannel?.(guildId) ?? false;
	const canSettings = (guildId: string) => props.canOpenServerSettings?.(guildId) ?? false;

	return (
		<aside
			class="w-72 max-w-[85vw] shrink-0 bg-[#f5efe1] dark:bg-[#211e1b] flex flex-col shadow-[0_2px_10px_rgba(0,0,0,0.04)] overflow-hidden fixed top-[var(--titlebar,0px)] bottom-0 left-0 z-40 pt-safe pb-safe lg:pt-0 lg:pb-0 lg:rounded-3xl lg:my-3 lg:ml-3 lg:mr-2"
			style={layout.leftStyle()}
			onMouseLeave={() => {
				if (!layout.isMobile() && layout.sidebarCollapsed()) {
					layout.setSidebarPeeking(false);
				}
			}}
		>
			<div class="pl-7 pr-4 pt-6 pb-5 flex items-center shrink-0">
				<Link to="/" class="flex items-center" aria-label="vanilla">
					<span
						class="block h-6 w-[111px] bg-stone-900 dark:bg-stone-100"
						style={{
							mask: 'url(/VanillaLogo.svg) left center / contain no-repeat',
							'-webkit-mask': 'url(/VanillaLogo.svg) left center / contain no-repeat',
						}}
					/>
				</Link>
				<InboxBell />
			</div>

			<div class="flex-1 overflow-y-auto px-2 pb-3 space-y-1 min-h-0">
				<div
					class="rounded-2xl transition-colors"
					classList={{
						'bg-[#e6d8a8] dark:bg-[#2c2724] shadow-inner shadow-black/[0.04] dark:shadow-black/20':
							isExpanded(DM_SCOPE),
					}}
				>
					<button
						type="button"
						onClick={() => toggle(DM_SCOPE)}
						class="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left transition-colors"
						classList={{
							'hover:bg-[#ece4cf] dark:hover:bg-stone-800/40': !isExpanded(DM_SCOPE),
						}}
					>
						<span class="flex items-center justify-center w-7 h-7 rounded-lg bg-[#f7e26c] text-stone-900 shrink-0 text-sm">
							<i class="fa-solid fa-house" />
						</span>
						<span class="flex-1 truncate font-display text-base text-stone-800 dark:text-stone-100">
							{t('home-title')}
						</span>
						<Show when={!isExpanded(DM_SCOPE) && homeBadge() > 0}>
							<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
								{homeBadge()}
							</span>
						</Show>
						<i
							class="fa-solid fa-chevron-down text-[0.6rem] text-stone-400 transition-transform shrink-0"
							classList={{ 'rotate-180': isExpanded(DM_SCOPE) }}
						/>
					</button>
					<Show when={isExpanded(DM_SCOPE)}>
						<div class="pb-2 px-2 space-y-0.5">
							<Link
								to="/app/$serverId"
								params={{ serverId: DM_SCOPE }}
								viewTransition={false}
								class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm"
								classList={{
									'bg-[#f7e26c] text-stone-900 font-medium': friendsActive(),
									'text-stone-600 dark:text-stone-400 hover:bg-[#e0d6bd] dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100':
										!friendsActive(),
								}}
							>
								<span class="w-6 h-6 rounded-full bg-stone-300/70 dark:bg-stone-700 flex items-center justify-center shrink-0">
									<i class="fa-solid fa-user-group text-[0.6rem]" />
								</span>
								<span class="truncate flex-1">{t('friends-title')}</span>
								<Show when={incomingRequests().length > 0}>
									<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
										{incomingRequests().length}
									</span>
								</Show>
							</Link>
							<For each={dmChannels()}>
								{(d) => {
									const active = () =>
										props.currentServerId() === DM_SCOPE && props.currentChannelId() === d.id;
									const other = () => dmOthers(d, currentUser()?.id)[0];
									return (
										<Link
											to="/app/$serverId/$channelId"
											params={{ serverId: DM_SCOPE, channelId: d.id }}
											viewTransition={false}
											class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm"
											classList={{
												'bg-[#f7e26c] text-stone-900 font-medium': active(),
												'text-stone-600 dark:text-stone-400 hover:bg-[#e0d6bd] dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100':
													!active(),
											}}
										>
											<Show
												when={!d.isGroup && other()}
												fallback={
													<span class="w-6 h-6 rounded-full bg-stone-300/70 dark:bg-stone-700 flex items-center justify-center shrink-0">
														<i class="fa-solid fa-user-group text-[0.6rem]" />
													</span>
												}
											>
												{(u) => (
													<Avatar
														user={u()}
														status={userPresence(u().id) ?? 'UNAVAILABLE'}
														size={24}
													/>
												)}
											</Show>
											<span class="truncate flex-1">{dmTitle(d, currentUser()?.id)}</span>
											<Show when={mentionCounts()[d.id]}>
												<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
													{mentionCounts()[d.id]}
												</span>
											</Show>
										</Link>
									);
								}}
							</For>
							<Show when={dmChannels().length === 0}>
								<div class="px-3 py-1.5 text-xs text-stone-400 italic font-display">
									{t('dms-empty')}
								</div>
							</Show>
							<button
								type="button"
								onClick={() => openGroupModal({ mode: 'create' })}
								class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-stone-500 hover:bg-[#e0d6bd] dark:hover:bg-stone-800 hover:text-stone-700 dark:hover:text-stone-200 transition-colors"
							>
								<i class="fa-solid fa-plus text-[0.6rem] shrink-0 w-3 text-center" />
								<span class="truncate pr-1 font-display italic">{t('dms-new-group')}</span>
							</button>
						</div>
					</Show>
				</div>
				<For each={guilds()}>
					{(g) => {
						const expanded = () => isExpanded(g.id);
						return (
							<div
								class="rounded-2xl transition-colors"
								classList={{
									'bg-[#e6d8a8] dark:bg-[#2c2724] shadow-inner shadow-black/[0.04] dark:shadow-black/20':
										expanded(),
								}}
							>
								<div class="relative">
									<button
										type="button"
										onClick={() => toggle(g.id)}
										class="w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-left transition-colors"
										classList={{
											'hover:bg-[#ece4cf] dark:hover:bg-stone-800/40': !expanded(),
											'pr-[4.5rem]':
												expanded() && canSettings(g.id) && !!props.onOpenServerSettings,
										}}
										title={g.name}
									>
										<span
											class="flex items-center justify-center w-7 h-7 rounded-lg font-display text-stone-900 overflow-hidden shrink-0 text-sm"
											style={{ 'background-color': avatarBackdrop(g.id, !!g.icon) }}
										>
											{g.icon ? (
												<img src={g.icon} alt="" class="w-full h-full object-cover" />
											) : (
												<DefaultAvatar id={g.id} />
											)}
										</span>
										<span class="flex-1 truncate font-display text-base text-stone-800 dark:text-stone-100">
											{g.name}
										</span>
										<Show when={!expanded() && guildMentions(g.channels) > 0}>
											<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
												{guildMentions(g.channels)}
											</span>
										</Show>
										<i
											class="fa-solid fa-chevron-down text-[0.6rem] text-stone-400 transition-transform shrink-0"
											classList={{ 'rotate-180': expanded() }}
										/>
									</button>
									<Show when={expanded() && canSettings(g.id) && props.onOpenServerSettings}>
										<button
											type="button"
											onClick={() => props.onOpenServerSettings?.(g.id)}
											title={t('server-menu-settings')}
											aria-label={t('server-menu-settings')}
											class="absolute right-9 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center text-xs text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
										>
											<i class="fa-solid fa-gear" />
										</button>
									</Show>
								</div>
								<Show when={expanded()}>
									<div class="pb-2 px-2 space-y-0.5">
										<For each={g.channels}>
											{(c) => {
												const isActiveCh = createMemo(
													() =>
														c.id === props.currentChannelId() && g.id === props.currentServerId(),
												);

												const channelType = createMemo(() => (c.type ?? 'TEXT').toUpperCase());
												const isVoice = createMemo(() => channelType() === 'VOICE');
												const channelIcon = createMemo(() =>
													isVoice() ? 'fa-volume-high' : 'fa-hashtag',
												);

												return (
													<>
														<div class="group relative">
															<Link
																to="/app/$serverId/$channelId"
																params={{ serverId: g.id, channelId: c.id }}
																viewTransition={false}
																onContextMenu={(e: MouseEvent) => {
																	e.preventDefault();
																	setChannelMenu({
																		x: e.clientX,
																		y: e.clientY,
																		channelId: c.id,
																		guildId: g.id,
																	});
																}}
																class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-sm"
																classList={{
																	'bg-[#f7e26c] text-stone-900 font-medium': isActiveCh(),
																	'text-stone-600 dark:text-stone-400 hover:bg-[#e0d6bd] dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100':
																		!isActiveCh(),
																}}
															>
																<i
																	class={`fa-solid ${channelIcon()} text-xs opacity-70 shrink-0 w-3 text-center`}
																/>
																<span class="truncate flex-1">{c.name}</span>
																<Show when={mentionCounts()[c.id]}>
																	<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
																		{mentionCounts()[c.id]}
																	</span>
																</Show>
															</Link>
															<Show when={canManage(g.id) && props.onOpenChannelSettings}>
																<button
																	type="button"
																	onClick={() => props.onOpenChannelSettings?.(c.id)}
																	title={t('channel-menu-settings')}
																	aria-label={t('channel-menu-settings')}
																	class="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
																	classList={{
																		'text-stone-700 hover:bg-black/10 hover:text-stone-900':
																			isActiveCh(),
																		'text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 hover:text-stone-900 dark:hover:text-stone-100':
																			!isActiveCh(),
																	}}
																>
																	<i class="fa-solid fa-gear" />
																</button>
															</Show>
														</div>
														<Show when={isVoice()}>
															<VoiceChannelMembers channelId={c.id} />
														</Show>
													</>
												);
											}}
										</For>
										<Show when={g.channels.length === 0}>
											<div class="px-3 py-1.5 text-xs text-stone-400 italic font-display">
												{t('app-no-channels')}
											</div>
										</Show>
										<Show
											when={
												props.onAddChannel &&
												(props.canAddChannel ? props.canAddChannel(g.id) : true)
											}
										>
											<button
												type="button"
												onClick={() => props.onAddChannel?.(g.id)}
												class="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs text-stone-500 hover:bg-[#e0d6bd] dark:hover:bg-stone-800 hover:text-stone-700 dark:hover:text-stone-200 transition-colors"
												title={t('app-create-channel')}
											>
												<i class="fa-solid fa-plus text-[0.6rem] shrink-0 w-3 text-center" />
												<span class="truncate pr-1 font-display italic">
													{t('app-create-channel')}
												</span>
											</button>
										</Show>
									</div>
								</Show>
							</div>
						);
					}}
				</For>
				<Show when={guilds().length === 0}>
					<div class="px-3 py-4 text-xs text-stone-400 italic font-display text-center">
						{t('app-no-servers')}
					</div>
				</Show>
				<div class="px-1 pt-2">
					<button
						type="button"
						onClick={props.onAddServer}
						class="w-full flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-[#f7e26c] text-stone-900 font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow"
					>
						<i class="fa-solid fa-plus text-sm" />
						<span>{t('app-new-community')}</span>
					</button>
				</div>
			</div>

			<VoiceDock />

			<Show when={currentUser()}>
				{(self) => (
					<div class="shrink-0 px-3 py-3 border-t border-stone-200/70 dark:border-stone-800/60 flex items-center gap-3">
						<button
							type="button"
							onClick={(e) => props.onOpenProfile?.(self(), e)}
							class="flex items-center gap-3 flex-1 min-w-0 rounded-xl px-1 py-1 -mx-1 hover:bg-[#ece4cf] dark:hover:bg-stone-800/40 transition-colors text-left"
							title={`${self().username}/${self().tag}`}
						>
							<div class="relative shrink-0">
								<Avatar user={self()} status={userPresence(self().id) ?? 'UNAVAILABLE'} size={36} />
								<span
									class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-[#f5efe1] dark:ring-[#211e1b]"
									style={{
										'background-color': statusColors[userPresence(self().id) ?? 'UNAVAILABLE'],
									}}
								/>
							</div>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium text-stone-800 dark:text-stone-100 truncate">
									{self().username}
								</div>
								<div class="text-xs text-stone-500 truncate font-display italic">
									{statusLabels[userPresence(self().id) ?? 'UNAVAILABLE']}
								</div>
							</div>
						</button>
						<button
							type="button"
							onClick={() => props.onOpenSettings?.()}
							class="w-9 h-9 rounded-xl text-stone-400 hover:bg-[#ece4cf] dark:hover:bg-stone-800/40 hover:text-stone-700 dark:hover:text-stone-200 flex items-center justify-center transition-colors shrink-0"
							title={t('settings-title')}
						>
							<i class="fa-solid fa-gear text-sm" />
						</button>
					</div>
				)}
			</Show>
			<Show when={channelMenu()}>
				{(m) => (
					<ChannelMenu
						menu={m()}
						onClose={() => setChannelMenu(null)}
						onSettings={
							props.onOpenChannelSettings && m().guildId && canManage(m().guildId as string)
								? () => props.onOpenChannelSettings?.(m().channelId)
								: undefined
						}
					/>
				)}
			</Show>
		</aside>
	);
}

function VoiceChannelMembers(props: { channelId: string }) {
	const participants = useVoiceParticipants(() => props.channelId);

	return (
		<Show when={participants().length > 0}>
			<div class="pl-8 pr-2 pb-1 space-y-0.5">
				<For each={participants()}>
					{(p) => {
						const user = () => getUser(p.userId);
						return (
							<div class="flex items-center gap-2 py-0.5 text-xs text-stone-600 dark:text-stone-400">
								<Show when={user()}>
									{(u) => (
										<span
											class="rounded-full"
											classList={{
												'ring-2 ring-green-500': speakingSsrcs().has(p.ssrc),
											}}
										>
											<Avatar user={u()} status={voicePresence(p.userId)} size={18} />
										</span>
									)}
								</Show>
								<span class="truncate flex-1">{user()?.username ?? p.userId}</span>
								<Show when={p.screenSharing}>
									<span class="text-[0.6rem] font-medium px-1 rounded bg-red-500 text-white">
										{t('voice-live')}
									</span>
								</Show>
								<Show when={p.selfDeaf}>
									<i class="fa-solid fa-volume-xmark text-[0.65rem] text-red-500" />
								</Show>
								<Show when={p.selfMute && !p.selfDeaf}>
									<i class="fa-solid fa-microphone-slash text-[0.65rem] text-red-500" />
								</Show>
							</div>
						);
					}}
				</For>
			</div>
		</Show>
	);
}

const guildMentions = (channels: Array<{ id: string }>) =>
	channels.reduce((sum, c) => sum + (mentionCounts()[c.id] ?? 0), 0);
