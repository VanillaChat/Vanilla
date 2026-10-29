import { Link } from '@tanstack/solid-router';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../../i18n';
import { DM_SCOPE, dmTitle, getDm } from '../../state/dms';
import { currentUser, getUser, guilds } from '../../state/gateway-data';
import {
	clearMentions,
	markAllPingsRead,
	type Ping,
	pingLog,
	unreadPingTotal,
} from '../../state/mentions';
import { MessageBody } from '../message/MessageBody';

export function InboxBell() {
	const [open, setOpen] = createSignal(false);
	const [pos, setPos] = createSignal({ x: 0, y: 0 });
	let root: HTMLDivElement | undefined;
	let panel: HTMLDivElement | undefined;

	// The sidebar clips overflow, so the list lives in a portal above everything else.
	const toggle = () => {
		if (!open() && root) {
			const r = root.getBoundingClientRect();
			setPos({
				x: Math.max(8, Math.min(r.left, window.innerWidth - 288 - 8)),
				y: r.bottom + 8,
			});
		}
		setOpen(!open());
	};

	const onDocDown = (e: MouseEvent) => {
		const target = e.target as Node;
		if (root?.contains(target) || panel?.contains(target)) return;
		setOpen(false);
	};
	document.addEventListener('mousedown', onDocDown);
	onCleanup(() => document.removeEventListener('mousedown', onDocDown));

	const where = (ping: Ping) => {
		const dm = getDm(ping.channelId);
		if (dm)
			return {
				guildId: DM_SCOPE,
				guildName: '',
				channelName: dmTitle(dm, currentUser()?.id),
				dm: true,
			};
		for (const g of guilds()) {
			const c = g.channels.find((ch) => ch.id === ping.channelId);
			if (c) return { guildId: g.id, guildName: g.name, channelName: c.name };
		}
		return null;
	};

	const entries = createMemo(() =>
		[...pingLog()]
			.reverse()
			.map((p) => ({ ping: p, place: where(p) }))
			.filter((e) => e.place),
	);

	return (
		<div ref={root} class="relative ml-auto flex items-center">
			<button
				type="button"
				aria-label={t('inbox-title')}
				aria-expanded={open()}
				onClick={toggle}
				class="relative w-9 h-9 rounded-xl flex items-center justify-center text-stone-500 hover:bg-[#ece4cf] dark:hover:bg-stone-800/40 hover:text-stone-800 dark:hover:text-stone-100 transition-colors"
				classList={{ 'bg-[#ece4cf] dark:bg-stone-800/40': open() }}
			>
				<i class="fa-regular fa-bell text-base" />
				<Show when={unreadPingTotal() > 0}>
					<span class="absolute -top-0.5 -right-0.5 min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center ring-2 ring-[#f5efe1] dark:ring-[#211e1b]">
						{unreadPingTotal() > 99 ? '99+' : unreadPingTotal()}
					</span>
				</Show>
			</button>

			<Show when={open()}>
				<Portal>
					<div
						ref={panel}
						style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
						class="fixed z-[80] w-72 max-h-96 overflow-y-auto rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/15 animate-popover-in"
					>
						<div class="flex items-center px-3 py-2 border-b border-stone-100 dark:border-stone-800">
							<span class="font-display text-base">{t('inbox-title')}</span>
							<Show when={unreadPingTotal() > 0}>
								<button
									type="button"
									onClick={markAllPingsRead}
									class="ml-auto text-xs text-stone-500 hover:text-stone-800 dark:hover:text-stone-100"
								>
									{t('inbox-mark-read')}
								</button>
							</Show>
						</div>
						<Show
							when={entries().length > 0}
							fallback={
								<div class="px-4 py-8 text-center text-sm text-stone-400 italic font-display">
									{t('inbox-empty')}
								</div>
							}
						>
							<For each={entries()}>
								{(e) => (
									<Link
										to="/app/$serverId/$channelId"
										params={{ serverId: e.place?.guildId ?? '', channelId: e.ping.channelId }}
										viewTransition={false}
										onClick={() => {
											clearMentions(e.ping.channelId);
											setOpen(false);
										}}
										class="block px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800/40 transition-colors"
									>
										<div class="flex items-center gap-1.5 text-xs text-stone-500">
											<Show when={!e.ping.read}>
												<span class="w-2 h-2 rounded-full bg-red-500 shrink-0" />
											</Show>
											<span class="truncate">
												{getUser(e.ping.authorId)?.username ?? '?'}
												{e.place?.dm ? '' : ` · #${e.place?.channelName} / ${e.place?.guildName}`}
											</span>
										</div>
										<div class="text-sm text-stone-700 dark:text-stone-200 line-clamp-2 break-words">
											<MessageBody text={e.ping.content} mode="inline" />
										</div>
									</Link>
								)}
							</For>
						</Show>
					</div>
				</Portal>
			</Show>
		</div>
	);
}
