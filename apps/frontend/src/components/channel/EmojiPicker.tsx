import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { t } from '../../i18n';
import {
	allCustomEmoji,
	BUILTIN_GUILD,
	CUSTOM_EMOJI_RE,
	customEmojiById,
	customEmojiText,
	EMOJI_GROUPS,
	emojiUrl,
	loadEmoji,
	loadTone,
	type PickerEmoji,
	recentEmoji,
	rememberEmoji,
	saveTone,
	searchEmoji,
	withTone,
} from '../../state/emoji';
import { DefaultAvatar } from '../ui/DefaultAvatar';
import { Emoji } from '../ui/Emoji';

const TONE_SWATCH = ['#f7c948', '#f7dcc0', '#e8bf99', '#c99a6b', '#8f5d3b', '#4d3426'];

type Props = {
	onPick: (unicode: string, keepOpen: boolean) => void;
	onClose: () => void;
	class?: string;
	custom?: boolean;
};

function imageFor(insert: string): string {
	const custom = CUSTOM_EMOJI_RE.exec(insert);
	return custom ? (customEmojiById(custom[2])?.src ?? '') : emojiUrl(insert);
}

function EmojiButton(props: { insert: string; label: string; onPick: (e: MouseEvent) => void }) {
	return (
		<button
			type="button"
			// The editor must keep focus and its caret while picking.
			onMouseDown={(e) => e.preventDefault()}
			onClick={props.onPick}
			title={props.label}
			aria-label={props.label}
			class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800"
		>
			<Emoji char={props.insert} url={imageFor(props.insert)} />
		</button>
	);
}

export function EmojiPicker(props: Props) {
	let root: HTMLDivElement | undefined;
	let scroller: HTMLDivElement | undefined;
	const [data, setData] = createSignal<PickerEmoji[]>();
	loadEmoji().then(setData);
	const [query, setQuery] = createSignal('');
	const [tone, setTone] = createSignal(loadTone());
	const [toneOpen, setToneOpen] = createSignal(false);
	const useCustom = () => props.custom !== false;
	const liveRecent = () =>
		recentEmoji().filter((u) => {
			const c = CUSTOM_EMOJI_RE.exec(u);
			return c ? useCustom() && !!customEmojiById(c[2]) : true;
		});
	const [recent, setRecent] = createSignal(liveRecent());
	const [active, setActive] = createSignal<number | string>(-1);

	onMount(() => {
		const down = (e: MouseEvent) => {
			const target = e.target as Element;
			// The toggle button handles its own click; closing here would just reopen it.
			if (root && !root.contains(target) && !target.closest('[data-emoji-toggle]')) props.onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') props.onClose();
		};
		document.addEventListener('mousedown', down);
		document.addEventListener('keydown', key);
		onCleanup(() => {
			document.removeEventListener('mousedown', down);
			document.removeEventListener('keydown', key);
		});
	});

	const byGroup = createMemo(() => {
		const map = new Map<number, PickerEmoji[]>();
		for (const e of data() ?? []) {
			const list = map.get(e.group);
			if (list) list.push(e);
			else map.set(e.group, [e]);
		}
		return map;
	});
	const results = createMemo(() => searchEmoji(data() ?? [], query()));
	const customGroups = createMemo(() => {
		if (!useCustom()) return [];
		const groups = new Map<
			string,
			{ guildId: string; name: string; emojis: ReturnType<typeof allCustomEmoji> }
		>();
		for (const e of allCustomEmoji()) {
			const g = groups.get(e.guildId);
			if (g) g.emojis.push(e);
			else groups.set(e.guildId, { guildId: e.guildId, name: e.guildName, emojis: [e] });
		}
		return Array.from(groups.values());
	});
	const customResults = createMemo(() => {
		const q = query().trim().toLowerCase();
		if (!q || !useCustom()) return [];
		return allCustomEmoji()
			.filter((e) => e.name.toLowerCase().includes(q))
			.slice(0, 60);
	});
	const labelOf = (unicode: string) => {
		const c = CUSTOM_EMOJI_RE.exec(unicode);
		if (c) return `:${c[1]}:`;
		return labelOfUnicode(unicode);
	};
	const labelOfUnicode = (unicode: string) =>
		data()?.find((e) => e.unicode === unicode || e.skins.includes(unicode))?.label ?? unicode;

	const pick = (unicode: string, e: MouseEvent) => {
		rememberEmoji(unicode);
		setRecent(liveRecent());
		props.onPick(unicode, e.shiftKey);
	};

	const jump = (id: number | string) => {
		setQuery('');
		setActive(id);
		queueMicrotask(() => {
			const el = scroller?.querySelector<HTMLElement>(`[data-group="${id}"]`);
			if (el && scroller) scroller.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' });
		});
	};

	return (
		<div
			ref={root}
			class={`${props.class ?? 'absolute right-3 sm:right-6 bottom-full mb-2 z-30 w-[22rem] max-w-[calc(100vw-1.5rem)]'} rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 flex flex-col animate-menu-in origin-bottom-right`}
		>
			<div class="flex items-center gap-2 p-2.5 pb-1.5">
				<input
					autofocus
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					placeholder={t('emoji-search')}
					aria-label={t('emoji-search')}
					class="flex-1 min-w-0 rounded-lg bg-stone-100 dark:bg-stone-800 px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#f7e26c]"
				/>
				<div class="relative">
					<button
						type="button"
						onClick={() => setToneOpen(!toneOpen())}
						title={t('emoji-skin-tone')}
						aria-label={t('emoji-skin-tone')}
						class="w-8 h-8 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800 flex items-center justify-center"
					>
						<span
							class="w-4 h-4 rounded-full ring-1 ring-black/10"
							style={{ 'background-color': TONE_SWATCH[tone()] }}
						/>
					</button>
					<Show when={toneOpen()}>
						<div class="absolute right-0 top-full mt-1 z-10 flex gap-1 p-1.5 rounded-xl bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 shadow-lg">
							<For each={TONE_SWATCH}>
								{(color, i) => (
									<button
										type="button"
										onClick={() => {
											setTone(i());
											saveTone(i());
											setToneOpen(false);
										}}
										aria-label={t('emoji-skin-tone')}
										class="w-5 h-5 rounded-full ring-1 ring-black/10"
										classList={{ 'ring-2 ring-stone-900 dark:ring-stone-100': tone() === i() }}
										style={{ 'background-color': color }}
									/>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>

			<Show when={!query()}>
				<div class="flex px-2 gap-0.5 border-b border-stone-100 dark:border-stone-800">
					<For each={customGroups()}>
						{(g) => (
							<button
								type="button"
								onClick={() => jump(`g${g.guildId}`)}
								title={g.name}
								aria-label={g.name}
								class="flex-1 h-8 flex items-center justify-center text-xs font-display rounded-t-lg transition-colors"
								classList={{
									'text-stone-900 dark:text-stone-100 border-b-2 border-[#f7e26c]':
										active() === `g${g.guildId}`,
									'text-stone-400 hover:text-stone-700 dark:hover:text-stone-200':
										active() !== `g${g.guildId}`,
								}}
							>
								<span class="w-5 h-5 rounded-md overflow-hidden block">
									<Show
										when={g.guildId === BUILTIN_GUILD}
										fallback={<DefaultAvatar id={g.guildId} />}
									>
										<img src={g.emojis[0]?.src} alt="" class="w-full h-full object-contain" />
									</Show>
								</span>
							</button>
						)}
					</For>
					<For each={EMOJI_GROUPS}>
						{(g) => (
							<button
								type="button"
								onClick={() => jump(g.id)}
								title={t(`emoji-group-${g.key}`)}
								aria-label={t(`emoji-group-${g.key}`)}
								class="flex-1 h-8 flex items-center justify-center text-sm rounded-t-lg transition-colors"
								classList={{
									'text-stone-900 dark:text-stone-100 border-b-2 border-[#f7e26c]':
										active() === g.id,
									'text-stone-400 hover:text-stone-700 dark:hover:text-stone-200':
										active() !== g.id,
								}}
							>
								<i class={g.icon} />
							</button>
						)}
					</For>
				</div>
			</Show>

			<div ref={scroller} class="h-72 overflow-y-auto p-2 relative">
				<Show when={data()} fallback={<p class="p-4 text-xs text-stone-400">…</p>}>
					<Show
						when={!query()}
						fallback={
							<Show
								when={results().length > 0 || customResults().length > 0}
								fallback={<p class="p-4 text-xs text-stone-400 italic">{t('emoji-none')}</p>}
							>
								<div class="flex flex-wrap">
									<For each={customResults()}>
										{(e) => (
											<EmojiButton
												insert={customEmojiText(e)}
												label={`:${e.name}:`}
												onPick={(ev) => pick(customEmojiText(e), ev)}
											/>
										)}
									</For>
									<For each={results()}>
										{(e) => (
											<EmojiButton
												insert={withTone(e, tone())}
												label={e.label}
												onPick={(ev) => pick(withTone(e, tone()), ev)}
											/>
										)}
									</For>
								</div>
							</Show>
						}
					>
						<Show when={recent().length > 0}>
							<div class="px-1 pb-1 text-[0.65rem] uppercase tracking-wider text-stone-400 font-medium">
								{t('emoji-recent')}
							</div>
							<div class="flex flex-wrap pb-2">
								<For each={recent()}>
									{(u) => (
										<EmojiButton insert={u} label={labelOf(u)} onPick={(ev) => pick(u, ev)} />
									)}
								</For>
							</div>
						</Show>
						<For each={customGroups()}>
							{(g) => (
								<div data-group={`g${g.guildId}`}>
									<div class="px-1 py-1 text-[0.65rem] uppercase tracking-wider text-stone-400 font-medium truncate">
										{g.name}
									</div>
									<div class="flex flex-wrap pb-2">
										<For each={g.emojis}>
											{(e) => (
												<EmojiButton
													insert={customEmojiText(e)}
													label={`:${e.name}:`}
													onPick={(ev) => pick(customEmojiText(e), ev)}
												/>
											)}
										</For>
									</div>
								</div>
							)}
						</For>
						<For each={EMOJI_GROUPS}>
							{(g) => (
								<div data-group={g.id}>
									<div class="px-1 py-1 text-[0.65rem] uppercase tracking-wider text-stone-400 font-medium">
										{t(`emoji-group-${g.key}`)}
									</div>
									<div class="flex flex-wrap pb-2" style={{ 'content-visibility': 'auto' }}>
										<For each={byGroup().get(g.id) ?? []}>
											{(e) => (
												<EmojiButton
													insert={withTone(e, tone())}
													label={e.label}
													onPick={(ev) => pick(withTone(e, tone()), ev)}
												/>
											)}
										</For>
									</div>
								</div>
							)}
						</For>
					</Show>
				</Show>
			</div>
		</div>
	);
}
