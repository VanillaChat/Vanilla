import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { t } from '../../i18n';
import {
	closeSearch,
	runSearch,
	SEARCH_FILTERS,
	type SearchScope,
	scopeKey,
	searchPanel,
} from '../../state/search';

type Suggestion = { insert: string; label: string; hint?: string };

const MAX_SUGGESTIONS = 6;

const quoteIfNeeded = (value: string) => (/\s/.test(value) ? `"${value}"` : value);

const today = () => new Date().toISOString().slice(0, 10);

type Props = {
	scope: SearchScope;
	people: () => string[];
	channels: () => string[];
};

export function SearchBox(props: Props) {
	const [value, setValue] = createSignal('');
	const [focused, setFocused] = createSignal(false);
	const [active, setActive] = createSignal(-1);
	let inputEl: HTMLInputElement | undefined;

	createEffect(
		on(
			() => scopeKey(props.scope),
			() => {
				closeSearch();
				setValue('');
			},
			{ defer: true },
		),
	);

	const lastToken = () => /\S*$/.exec(value())?.[0] ?? '';

	const suggestions = createMemo<Suggestion[]>(() => {
		const token = lastToken();
		const colon = token.indexOf(':');
		if (colon === -1) {
			const prefix = token.toLowerCase();
			return SEARCH_FILTERS.filter((f) => f.key.startsWith(prefix)).map((f) => ({
				insert: `${f.key}:`,
				label: `${f.key}:`,
				hint: t(f.hintKey),
			}));
		}
		const key = token.slice(0, colon).toLowerCase();
		const partial = token
			.slice(colon + 1)
			.replace(/^"/, '')
			.toLowerCase();
		const names = (list: string[]) =>
			Array.from(new Set(list))
				.filter((n) => n.toLowerCase().startsWith(partial))
				.slice(0, MAX_SUGGESTIONS)
				.map((n) => ({ insert: `${key}:${quoteIfNeeded(n)} `, label: n }));
		switch (key) {
			case 'has':
				return 'link'.startsWith(partial) ? [{ insert: 'has:link ', label: 'link' }] : [];
			case 'from':
			case 'mentions':
				return names(props.people());
			case 'in':
				return names(props.channels());
			case 'before':
			case 'after':
			case 'during':
				return today().startsWith(partial)
					? [{ insert: `${key}:${today()} `, label: today(), hint: 'YYYY-MM-DD' }]
					: [];
			default:
				return [];
		}
	});

	const open = () => focused() && suggestions().length > 0;

	const pick = (s: Suggestion) => {
		setValue(value().slice(0, value().length - lastToken().length) + s.insert);
		setActive(-1);
		inputEl?.focus();
	};

	const submit = () => {
		const query = value().trim();
		if (!query) return;
		setFocused(false);
		inputEl?.blur();
		runSearch(props.scope, query);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		const list = suggestions();
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			if (!open()) return;
			e.preventDefault();
			const step = e.key === 'ArrowDown' ? 1 : -1;
			setActive((active() + step + list.length) % list.length);
		} else if (e.key === 'Tab' && open()) {
			e.preventDefault();
			pick(list[Math.max(active(), 0)]);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const chosen = active() >= 0 ? list[active()] : undefined;
			if (open() && chosen) pick(chosen);
			else submit();
		} else if (e.key === 'Escape') {
			if (open()) setFocused(false);
			else if (searchPanel()) closeSearch();
			else inputEl?.blur();
		}
	};

	return (
		<div class="relative min-w-0">
			<i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-xs text-stone-400 pointer-events-none" />
			<input
				ref={inputEl}
				type="search"
				value={value()}
				onInput={(e) => {
					setValue(e.currentTarget.value);
					setActive(-1);
				}}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				onKeyDown={onKeyDown}
				placeholder={t('search-placeholder')}
				aria-label={t('search-aria')}
				autocomplete="off"
				spellcheck={false}
				class="w-36 sm:w-64 rounded-xl bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-800 pl-8 pr-3 py-1.5 text-sm outline-none focus:border-stone-400 dark:focus:border-stone-600 placeholder:text-stone-400 dark:placeholder:text-stone-600"
			/>
			<Show when={open()}>
				<div class="absolute right-0 top-full mt-2 w-64 max-w-[80vw] rounded-xl bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 shadow-xl shadow-black/10 p-1 z-40">
					<For each={suggestions()}>
						{(s, i) => (
							<button
								type="button"
								// Keep focus in the input so the dropdown does not close before the click lands.
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => pick(s)}
								class={`w-full flex items-baseline gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left ${
									i() === active()
										? 'bg-stone-100 dark:bg-stone-800'
										: 'hover:bg-stone-100 dark:hover:bg-stone-800/60'
								}`}
							>
								<span class="font-medium truncate">{s.label}</span>
								<Show when={s.hint}>
									<span class="ml-auto text-xs text-stone-400 italic font-display shrink-0">
										{s.hint}
									</span>
								</Show>
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
