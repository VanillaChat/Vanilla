import { createFileRoute, Outlet, useMatch } from '@tanstack/solid-router';
import { createMemo, For, Show } from 'solid-js';
import type { GatewayMember } from '../api/gateway';
import { Avatar } from '../components/Avatar';
import { StatusEmoji } from '../components/ui/StatusEmoji';
import { useLayout } from '../contexts/layout';
import { useProfile } from '../contexts/profile';
import { t } from '../i18n';
import { DM_SCOPE, getDm } from '../state/dms';
import {
	currentUser,
	type GuildMemberView,
	guilds,
	useGuildUsers,
	userPresence,
} from '../state/gateway-data';
import { openGroupModal } from '../state/group-modal';
import { memberColor, roleCss, splitByHoist } from '../state/permissions';

export const Route = createFileRoute('/app/$serverId')({
	component: ServerLayout,
});

function ServerLayout() {
	const params = Route.useParams();
	const profile = useProfile();
	const layout = useLayout();
	const serverUsers = useGuildUsers(() => params().serverId);
	const dmMatch = useMatch({ from: '/app/$serverId/$channelId', shouldThrow: false });
	const dmChannel = createMemo(() => getDm(dmMatch()?.params.channelId));
	const isHome = () => params().serverId === DM_SCOPE;
	const guildUsers = createMemo<GuildMemberView[]>(() => {
		if (!isHome()) return serverUsers();
		const people = dmChannel()?.members ?? [];
		return people.flatMap((user) =>
			user
				? [
						{
							id: 0,
							nickname: null,
							userId: user.id,
							joinedAt: '',
							user,
							status: userPresence(user.id) ?? 'UNAVAILABLE',
						} satisfies GatewayMember & Pick<GuildMemberView, 'user' | 'status'>,
					]
				: [],
		);
	});
	const onlineMembers = () => guildUsers().filter((u) => u.status !== 'UNAVAILABLE');
	const split = createMemo(() =>
		splitByHoist(
			isHome() ? undefined : guilds().find((g) => g.id === params().serverId),
			onlineMembers(),
		),
	);
	const offlineMembers = () => guildUsers().filter((u) => u.status === 'UNAVAILABLE');

	return (
		<>
			<Outlet />

			<Show when={!isHome() || dmMatch()}>
				<aside
					class="w-64 max-w-[85vw] shrink-0 bg-[#f5efe1] dark:bg-[#211e1b] flex flex-col shadow-[0_2px_10px_rgba(0,0,0,0.04)] overflow-hidden fixed top-[var(--titlebar,0px)] bottom-0 right-0 z-40 pt-safe pb-safe lg:pt-0 lg:pb-0 lg:my-3 lg:mr-3 lg:ml-0 lg:rounded-3xl"
					style={layout.rightStyle()}
					onMouseLeave={() => {
						if (!layout.isMobile() && layout.membersCollapsed()) {
							layout.setMembersPeeking(false);
						}
					}}
				>
					<div class="px-5 h-14 flex items-center gap-2 shrink-0">
						<span class="font-display text-lg">{t('members-room')}</span>
						<span class="text-xs text-stone-400 font-display italic">{guildUsers().length}</span>
						<div class="flex-1" />
						<Show when={dmChannel()?.isGroup}>
							<button
								type="button"
								onClick={() => openGroupModal({ mode: 'add', channelId: dmChannel()?.id ?? '' })}
								class="w-9 h-9 rounded-xl text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center"
								title={t('group-modal-add-title')}
							>
								<i class="fa-solid fa-user-plus text-sm" />
							</button>
						</Show>
						<button
							type="button"
							onClick={() => layout.setMembersOpen(false)}
							class="lg:hidden w-9 h-9 -mr-1 rounded-xl text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center"
							aria-label={t('app-close-menu')}
						>
							<i class="fa-solid fa-xmark text-base" />
						</button>
					</div>
					<div class="flex-1 overflow-y-auto px-3 py-1">
						<For each={split().groups}>
							{(g) => (
								<MemberGroup
									label={g.role.name}
									labelColor={roleCss(g.role.color)}
									items={g.items}
									onSelect={(m, e) => profile.open(m.user, e)}
								/>
							)}
						</For>
						<Show when={split().rest.length > 0}>
							<MemberGroup
								label={t('members-online')}
								items={split().rest}
								onSelect={(m, e) => profile.open(m.user, e)}
							/>
						</Show>
						<Show when={offlineMembers().length > 0}>
							<MemberGroup
								label={t('members-offline')}
								items={offlineMembers()}
								muted
								onSelect={(m, e) => profile.open(m.user, e)}
							/>
						</Show>
					</div>
				</aside>
			</Show>
		</>
	);
}

function MemberGroup(props: {
	label: string;
	labelColor?: string;
	items: GuildMemberView[];
	muted?: boolean;
	onSelect: (u: GuildMemberView, e: MouseEvent) => void;
}) {
	const params = Route.useParams();
	return (
		<div class="mb-4">
			<div
				class="px-3 mb-1.5 text-xs font-display italic text-stone-500 truncate"
				style={{ color: props.labelColor || undefined }}
			>
				{props.label} · {props.items.length}
			</div>
			<div class="space-y-0.5">
				<For each={props.items}>
					{(m) => (
						<button
							type="button"
							onClick={(e) => props.onSelect(m, e)}
							class="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm hover:bg-stone-100 dark:hover:bg-stone-800/40 cursor-pointer transition-colors text-left"
							classList={{ 'opacity-50': props.muted }}
						>
							<Avatar user={m.user} status={m.status} size={30} />
							<div class="flex-1 min-w-0">
								<div
									class="truncate"
									style={{
										color: memberColor(
											guilds().find((g) => g.id === params().serverId),
											m.userId,
										),
									}}
								>
									{m.nickname ?? m.user.username}
								</div>
								<Show
									when={m.user.customStatus?.text || m.user.customStatus?.emoji}
									fallback={
										<Show when={m.user.bio}>
											<div class="text-xs text-stone-500 italic font-display truncate">
												{m.user.bio}
											</div>
										</Show>
									}
								>
									<div class="text-xs text-stone-500 italic font-display truncate">
										<Show when={m.user.customStatus?.emoji}>
											<StatusEmoji emoji={m.user.customStatus?.emoji ?? ''} />{' '}
										</Show>
										{m.user.customStatus?.text}
									</div>
								</Show>
							</div>
						</button>
					)}
				</For>
			</div>
		</div>
	);
}
