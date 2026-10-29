import { useNavigate } from '@tanstack/solid-router';
import { createResource, createSignal, Show } from 'solid-js';
import { ApiError, api } from '../../api/client';
import { joinServer } from '../../api/servers';
import { t } from '../../i18n';
import { avatarBackdrop } from '../../state/default-avatar';
import { guilds } from '../../state/gateway-data';
import { adoptServer } from '../../state/join';
import { DefaultAvatar } from '../ui/DefaultAvatar';

type InvitePreview = {
	code: string;
	inviter?: { username: string } | null;
	guild: { id: string; name: string; brief?: string | null; icon?: string | null };
	channel: { id: string; name: string };
};

export function InviteEmbed(props: { code: string }) {
	const navigate = useNavigate();
	const [invite] = createResource(
		() => props.code,
		(code) => api<InvitePreview>(`/invites/${code}`).catch(() => null),
	);
	const [joining, setJoining] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const member = (guildId: string) => guilds().some((g) => g.id === guildId);
	const open = (guildId: string) =>
		navigate({ to: '/app/$serverId', params: { serverId: guildId }, viewTransition: false });

	const join = async (guildId: string) => {
		setJoining(true);
		setError(null);
		try {
			const id = adoptServer(await joinServer({ inviteCode: props.code }));
			open(id ?? guildId);
		} catch (err) {
			setError(err instanceof ApiError ? err.message : t('server-modal-failed'));
		} finally {
			setJoining(false);
		}
	};

	return (
		<div class="mt-2 max-w-sm rounded-xl border border-stone-200 dark:border-stone-700 bg-[#fdfaf3] dark:bg-stone-900/60 p-3">
			<Show
				when={!invite.loading}
				fallback={<div class="text-xs text-stone-400 italic font-display">{t('app-loading')}</div>}
			>
				<Show
					when={invite()}
					fallback={
						<div class="flex items-center gap-2 text-sm text-stone-500">
							<i class="fa-solid fa-link-slash" />
							{t('invite-embed-invalid')}
						</div>
					}
				>
					{(inv) => (
						<>
							<div class="text-[0.65rem] uppercase tracking-wide text-stone-500 mb-2">
								{inv().inviter
									? t('invite-embed-from', { name: inv().inviter?.username ?? '' })
									: t('invite-embed-title')}
							</div>
							<div class="flex items-center gap-3">
								<span
									class="flex items-center justify-center w-12 h-12 rounded-xl font-display text-xl text-stone-900 overflow-hidden shrink-0"
									style={{
										'background-color': avatarBackdrop(inv().guild.id, !!inv().guild.icon),
									}}
								>
									{inv().guild.icon ? (
										<img src={inv().guild.icon ?? ''} alt="" class="w-full h-full object-cover" />
									) : (
										<DefaultAvatar id={inv().guild.id} />
									)}
								</span>
								<div class="flex-1 min-w-0">
									<div class="font-display text-base text-stone-800 dark:text-stone-100 truncate">
										{inv().guild.name}
									</div>
									<Show when={inv().guild.brief}>
										<div class="text-xs text-stone-500 truncate">{inv().guild.brief}</div>
									</Show>
								</div>
								<button
									type="button"
									disabled={joining()}
									onClick={() =>
										member(inv().guild.id) ? open(inv().guild.id) : join(inv().guild.id)
									}
									class="shrink-0 px-4 py-2 rounded-lg text-sm font-medium bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow disabled:opacity-60"
								>
									{member(inv().guild.id)
										? t('invite-embed-open')
										: joining()
											? t('server-modal-joining')
											: t('invite-embed-join')}
								</button>
							</div>
							<Show when={error()}>
								<div class="mt-2 text-xs text-red-600 dark:text-red-400">{error()}</div>
							</Show>
						</>
					)}
				</Show>
			</Show>
		</div>
	);
}
