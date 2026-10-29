import { useMatch, useNavigate } from '@tanstack/solid-router';
import { createEffect, createSignal, For, Show } from 'solid-js';
import { errorText } from '../../api/error-text';
import { type UserStatus, updatePresence } from '../../api/gateway';
import type { ProfilePopoverApi } from '../../hooks/useProfilePopover';
import { t } from '../../i18n';
import { BADGES, knownBadges } from '../../state/badges';
import { avatarBackdrop } from '../../state/default-avatar';
import { DM_SCOPE, openDm } from '../../state/dms';
import {
	acceptFriend,
	blockUser,
	relationshipKind,
	sendFriendRequest,
	unblockUser,
} from '../../state/friends';
import { colorForId, currentUser, userPresence } from '../../state/gateway-data';
import { voiceSettings } from '../../voice/settings';
import { statusColors, statusLabels } from '../Avatar';
import { DefaultAvatar } from '../ui/DefaultAvatar';
import { StatusEmoji } from '../ui/StatusEmoji';
import { MemberRoles } from './MemberRoles';
import { StatusPicker } from './StatusPicker';

const STATUSES: UserStatus[] = ['ONLINE', 'IDLE', 'DND', 'LOOKING_TO_PLAY', 'UNAVAILABLE'];

type Props = {
	api: ProfilePopoverApi;
};

export function ProfilePopover(props: Props) {
	const navigate = useNavigate();
	const server = useMatch({ from: '/app/$serverId', shouldThrow: false });
	const guildId = () => {
		const id = server()?.params.serverId;
		return id && id !== DM_SCOPE ? id : undefined;
	};
	const [opening, setOpening] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	createEffect(() => {
		props.api.user();
		setError(null);
	});
	const attempt = async (action: () => Promise<unknown>) => {
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(errorText(e, 'dialog-failed'));
		}
	};
	const message = async (userId: string) => {
		if (opening()) return;
		setOpening(true);
		setError(null);
		try {
			const dm = await openDm(userId);
			props.api.close();
			navigate({
				to: '/app/$serverId/$channelId',
				params: { serverId: DM_SCOPE, channelId: dm.id },
			});
		} catch (e) {
			setError(errorText(e, 'dialog-failed'));
		} finally {
			setOpening(false);
		}
	};
	return (
		<Show when={props.api.user()}>
			{(u) => (
				<div
					ref={props.api.setPopoverEl}
					class={`fixed z-50 w-72 rounded-2xl bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 overflow-hidden border border-stone-200 dark:border-stone-800 ${
						props.api.closing() ? 'animate-popover-out' : 'animate-popover-in'
					}`}
					style={{
						left: `${props.api.pos().x}px`,
						...(props.api.pinBottom() !== null
							? { bottom: `${props.api.pinBottom()}px` }
							: { top: `${props.api.pos().y}px` }),
						'transform-origin': props.api.origin(),
					}}
				>
					<div
						class="h-20"
						style={{
							'background-color': colorForId(u().id),
							...(u().banner
								? {
										'background-image': `url(${u().banner})`,
										'background-size': 'cover',
										'background-position': 'center',
									}
								: {}),
						}}
					/>
					<div class="px-5 -mt-10 pb-5">
						<div class="relative inline-flex">
							<div
								class="w-20 h-20 rounded-full flex items-center justify-center font-display text-stone-900 ring-4 ring-white dark:ring-[#211e1b] overflow-hidden"
								style={{
									'background-color': avatarBackdrop(u().id, !!u().avatar),
									'font-size': '2rem',
								}}
							>
								{u().avatar ? (
									<img src={u().avatar!} alt="" class="w-full h-full object-cover" />
								) : (
									<DefaultAvatar id={u().id} />
								)}
							</div>
							<span
								class="absolute bottom-1 right-1 w-4 h-4 rounded-full ring-[3px] ring-white dark:ring-[#211e1b]"
								style={{
									'background-color': statusColors[userPresence(u().id) ?? 'UNAVAILABLE'],
								}}
							/>
						</div>
						<div class="mt-3 flex items-baseline gap-1">
							<h3 class="font-display text-2xl">{u().username}</h3>
							<span class="font-display text-base text-stone-400">/{u().tag}</span>
							<Show when={u().bot}>
								<span class="ml-1 px-1.5 py-0.5 rounded-md bg-stone-900 text-white text-[0.6rem] font-medium uppercase tracking-wider">
									bot
								</span>
							</Show>
						</div>
						<Show
							when={u().id === currentUser()?.id}
							fallback={
								<div class="text-xs font-display italic text-stone-500 mt-0.5">
									{statusLabels[userPresence(u().id) ?? 'UNAVAILABLE']}
								</div>
							}
						>
							<StatusPicker
								open={props.api.statusPickerOpen}
								setOpen={props.api.setStatusPickerOpen}
							/>
						</Show>

						<Show when={u().customStatus?.text || u().customStatus?.emoji}>
							<div class="mt-2 flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-300">
								<Show when={u().customStatus?.emoji}>
									<StatusEmoji emoji={u().customStatus?.emoji ?? ''} />
								</Show>
								<span class="break-words min-w-0">{u().customStatus?.text}</span>
							</div>
						</Show>
						<Show when={knownBadges(u().badges).length > 0}>
							<div class="mt-2 flex flex-wrap gap-1.5">
								<For each={knownBadges(u().badges)}>
									{(id) => (
										<span
											class="w-6 h-6 rounded-md flex items-center justify-center bg-stone-100 dark:bg-stone-800 text-xs"
											style={{ color: BADGES[id].color }}
											title={t(`badge-${id}`)}
											role="img"
											aria-label={t(`badge-${id}`)}
										>
											<i class={`fa-solid ${BADGES[id].icon}`} />
										</span>
									)}
								</For>
							</div>
						</Show>

						<Show when={u().bio}>
							<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
								<div class="text-[0.7rem] uppercase tracking-wider text-stone-400 font-medium mb-1">
									{t('profile-about')}
								</div>
								<p class="text-sm text-stone-600 dark:text-stone-400 italic font-display">
									{u().bio}
								</p>
							</div>
						</Show>

						<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
							<div class="text-[0.7rem] uppercase tracking-wider text-stone-400 font-medium mb-1">
								{t('profile-member-since')}
							</div>
							<p class="text-sm text-stone-600 dark:text-stone-400 font-display italic">
								{new Date(u().createdAt).toLocaleDateString(undefined, {
									year: 'numeric',
									month: 'long',
									day: 'numeric',
								})}
							</p>
						</div>

						<Show when={voiceSettings().developerMode}>
							<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
								<div class="text-[0.7rem] uppercase tracking-wider text-stone-400 font-medium mb-1">
									{t('profile-id')}
								</div>
								<p class="font-mono text-xs text-stone-500 dark:text-stone-400 break-all">
									{u().id}
								</p>
							</div>
						</Show>

						<div class="mt-4 flex gap-2">
							<button
								type="button"
								disabled={opening()}
								onClick={() => message(u().id)}
								class="flex-1 px-3 py-2 rounded-xl bg-[#f7e26c] text-stone-900 text-sm font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow flex items-center justify-center gap-2"
							>
								<i class="fa-solid fa-paper-plane text-xs" />
								{t('profile-message')}
							</button>
							<Show when={u().id !== currentUser()?.id && !u().bot}>
								{(() => {
									const kind = () => relationshipKind(u().id);
									const action = () => {
										switch (kind()) {
											case 'INCOMING':
												return {
													icon: 'fa-user-check',
													label: 'friends-accept',
													run: () => acceptFriend(u().id),
												};
											case 'OUTGOING':
												return { icon: 'fa-user-clock', label: 'friends-request-pending' };
											case 'FRIEND':
												return { icon: 'fa-user-check', label: 'friends-are-friends' };
											case 'BLOCKED':
												return {
													icon: 'fa-lock-open',
													label: 'friends-unblock',
													run: () => unblockUser(u().id),
												};
											default:
												return {
													icon: 'fa-user-plus',
													label: 'profile-add-friend',
													run: () => sendFriendRequest({ userId: u().id }),
												};
										}
									};
									return (
										<button
											type="button"
											disabled={!action().run}
											onClick={() => {
												const run = action().run;
												if (run) attempt(run);
											}}
											class="px-3 py-2 rounded-xl bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 transition-colors disabled:opacity-60 disabled:hover:bg-stone-100 dark:disabled:hover:bg-stone-800"
											title={t(action().label)}
											aria-label={t(action().label)}
										>
											<i class={`fa-solid ${action().icon}`} />
										</button>
									);
								})()}
							</Show>
						</div>
						<Show when={guildId()}>
							{(id) => (
								<MemberRoles guildId={id()} userId={u().id} onRemoved={() => props.api.close()} />
							)}
						</Show>
						<Show when={error()}>
							<p class="mt-3 text-xs text-red-600">{error()}</p>
						</Show>
						<Show
							when={
								u().id !== currentUser()?.id && !u().bot && relationshipKind(u().id) !== 'BLOCKED'
							}
						>
							<button
								type="button"
								onClick={() => attempt(() => blockUser(u().id))}
								class="mt-3 text-xs text-stone-400 hover:text-red-500 transition-colors"
							>
								{t('friends-block')}
							</button>
						</Show>
					</div>
				</div>
			)}
		</Show>
	);
}
