import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { errorText } from '../../api/error-text';
import type { Message } from '../../api/messages';
import { t } from '../../i18n';
import {
	closeSearch,
	highlightTerms,
	loadMoreResults,
	searchError,
	searchLoading,
	searchPanel,
	searchResults,
	searchTotal,
} from '../../state/search';
import { Avatar } from '../Avatar';
import { previewText } from '../channel/utils';
import { MessageBody } from '../message/MessageBody';

const SNIPPET = 320;

type Props = {
	label: (m: Message) => string;
	onPick: (m: Message) => void;
};

export function SearchPanel(props: Props) {
	const terms = () => highlightTerms(searchPanel()?.query ?? '');

	const groups = createMemo(() => {
		const byChannel = new Map<string, Message[]>();
		for (const m of searchResults()) {
			const list = byChannel.get(m.channelId);
			if (list) list.push(m);
			else byChannel.set(m.channelId, [m]);
		}
		return Array.from(byChannel, ([channelId, messages]) => ({ channelId, messages }));
	});

	const [collapsed, setCollapsed] = createSignal<string[]>([]);
	createEffect(
		on(
			() => searchPanel()?.query,
			() => setCollapsed([]),
		),
	);
	const isCollapsed = (channelId: string) => collapsed().includes(channelId);
	const toggle = (channelId: string) =>
		setCollapsed(
			isCollapsed(channelId)
				? collapsed().filter((id) => id !== channelId)
				: [...collapsed(), channelId],
		);
	return (
		<Show when={searchPanel()}>
			<aside class="absolute inset-y-0 right-0 z-30 w-full sm:w-96 flex flex-col bg-white dark:bg-[#211e1b] border-l border-stone-200 dark:border-stone-800 shadow-2xl shadow-black/10 animate-fade-in">
				<div class="px-4 h-12 flex items-center gap-2 border-b border-stone-100 dark:border-stone-800 shrink-0">
					<h3 class="font-display text-lg">{t('search-results-title')}</h3>
					<Show when={!searchLoading() || searchResults().length > 0}>
						<span class="text-xs text-stone-400 italic font-display">
							{t('search-results-count', { count: searchTotal() })}
						</span>
					</Show>
					<div class="flex-1" />
					<button
						type="button"
						onClick={closeSearch}
						aria-label={t('search-close')}
						title={t('search-close')}
						class="w-9 h-9 -mr-2 rounded-xl text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center"
					>
						<i class="fa-solid fa-xmark" />
					</button>
				</div>

				<div class="flex-1 min-h-0 overflow-y-auto p-2">
					<Show when={searchError()}>
						<p class="m-2 px-4 py-2.5 rounded-xl text-sm bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">
							{errorText(searchError(), 'search-failed')}
						</p>
					</Show>
					<Show when={!searchError() && !searchLoading() && searchResults().length === 0}>
						<p class="text-center text-stone-400 italic font-display py-16">
							{t('search-no-results')}
						</p>
					</Show>
					<For each={groups()}>
						{(group) => (
							<section class="mb-1">
								<button
									type="button"
									onClick={() => toggle(group.channelId)}
									aria-expanded={!isCollapsed(group.channelId)}
									class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-stone-500 hover:bg-stone-50 dark:hover:bg-stone-800/40"
								>
									<i
										class="fa-solid fa-chevron-down text-[0.6rem] transition-transform"
										classList={{ '-rotate-90': isCollapsed(group.channelId) }}
									/>
									<span class="flex-1 min-w-0 truncate font-display italic">
										{props.label(group.messages[0])}
									</span>
									<span class="text-xs text-stone-400 shrink-0">{group.messages.length}</span>
								</button>
								<Show when={!isCollapsed(group.channelId)}>
									<For each={group.messages}>
										{(m) => (
											<button
												type="button"
												onClick={() => props.onPick(m)}
												class="w-full text-left px-3 py-2.5 rounded-2xl hover:bg-stone-50 dark:hover:bg-stone-800/40 flex gap-3"
											>
												<Avatar user={m.author ?? { id: m.authorId, username: '?' }} size={36} />
												<div class="min-w-0 flex-1">
													<div class="flex items-baseline gap-2">
														<span class="font-display text-base truncate">
															{m.author?.username ?? '?'}
														</span>
														<span class="text-xs text-stone-400 shrink-0">
															{new Date(m.createdAt).toLocaleString([], {
																dateStyle: 'medium',
																timeStyle: 'short',
															})}
														</span>
													</div>
													<p class="mt-1 text-sm text-stone-700 dark:text-stone-300 whitespace-pre-wrap break-words">
														<MessageBody
															text={previewText(m)}
															mode="inline"
															highlight={terms()}
															maxLength={SNIPPET}
														/>
													</p>
												</div>
											</button>
										)}
									</For>
								</Show>
							</section>
						)}
					</For>
					<Show when={searchLoading()}>
						<p class="text-center text-xs text-stone-400 italic font-display py-4">
							{t('search-loading')}
						</p>
					</Show>
					<Show when={!searchLoading() && searchResults().length < searchTotal()}>
						<div class="flex justify-center py-3">
							<button
								type="button"
								onClick={loadMoreResults}
								class="px-4 py-2 rounded-xl text-sm bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
							>
								{t('search-more')}
							</button>
						</div>
					</Show>
				</div>
			</aside>
		</Show>
	);
}
