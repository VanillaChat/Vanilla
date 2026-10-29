import { type JSX, Show } from 'solid-js';
import type { GatewayChannel } from '../../api/gateway';
import { useLayout } from '../../contexts/layout';
import { t } from '../../i18n';

type Props = {
	channel: () => GatewayChannel | undefined;
	onGenerateInvite: () => void;
	inviteLoading: () => boolean;
	dm?: boolean;
	group?: boolean;
	onLeave?: () => void;
	search?: JSX.Element;
};

export function ChannelHeader(props: Props) {
	const layout = useLayout();
	return (
		<header class="pt-safe box-content px-4 sm:px-6 h-14 flex items-center gap-3 border-b border-stone-100 dark:border-stone-800 shrink-0">
			<button
				type="button"
				onClick={() => layout.toggleSidebar()}
				class="-ml-1 w-9 h-9 rounded-xl text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center shrink-0"
				aria-label={
					layout.isMobile()
						? t('app-open-menu')
						: layout.sidebarCollapsed()
							? t('app-show-sidebar')
							: t('app-hide-sidebar')
				}
				title={
					layout.isMobile()
						? t('app-open-menu')
						: layout.sidebarCollapsed()
							? t('app-show-sidebar')
							: t('app-hide-sidebar')
				}
			>
				<i
					class={`fa-solid text-base ${
						layout.sidebarCollapsed() ? 'fa-bars-staggered' : 'fa-bars'
					}`}
				/>
			</button>
			<Show
				when={props.channel()}
				fallback={
					<span class="text-sm text-stone-400 italic font-display">
						{t('app-channel-not-found')}
					</span>
				}
			>
				{(ch) => (
					<>
						<i
							class={`fa-solid ${props.dm ? (props.group ? 'fa-user-group' : 'fa-at') : (ch().type ?? 'TEXT').toUpperCase() === 'VOICE' ? 'fa-volume-high' : 'fa-hashtag'} text-stone-400 text-lg`}
						/>
						<h2 class="font-display text-xl sm:text-2xl truncate min-w-0">{ch().name}</h2>
						<div class="flex-1" />
						{props.search}
						<Show when={props.group}>
							<button
								type="button"
								onClick={props.onLeave}
								class="text-stone-400 hover:text-red-500 transition-colors flex items-center gap-1.5 text-sm"
								title={t('group-leave')}
							>
								<i class="fa-solid fa-right-from-bracket" />
								<span class="hidden sm:inline font-display italic">{t('group-leave')}</span>
							</button>
						</Show>
						<Show when={!props.dm}>
							<button
								onClick={props.onGenerateInvite}
								disabled={props.inviteLoading()}
								class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 transition-colors flex items-center gap-1.5 text-sm disabled:opacity-50"
								title={t('invite-button')}
							>
								<i class="fa-solid fa-link" />
								<span class="hidden sm:inline font-display italic">{t('invite-button')}</span>
							</button>
						</Show>
						<button
							type="button"
							onClick={() => layout.toggleMembers()}
							class="w-9 h-9 -mr-1 rounded-xl text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center shrink-0"
							aria-label={
								layout.isMobile()
									? t('members-room')
									: layout.membersCollapsed()
										? t('app-show-members')
										: t('app-hide-members')
							}
							title={
								layout.isMobile()
									? t('members-room')
									: layout.membersCollapsed()
										? t('app-show-members')
										: t('app-hide-members')
							}
						>
							<i
								class={`fa-solid text-md ${
									layout.membersCollapsed() ? 'fa-bars-staggered' : 'fa-bars'
								}`}
							/>
						</button>
					</>
				)}
			</Show>
		</header>
	);
}
