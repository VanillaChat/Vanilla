import { createSignal, For, type JSX, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { errorText } from '../../api/error-text';
import { ownStatusUntil, type UserStatus, updatePresence } from '../../api/gateway';
import { setCustomStatus } from '../../api/status';
import { t } from '../../i18n';
import { currentUser, userPresence } from '../../state/gateway-data';
import { statusColors, statusLabels } from '../Avatar';
import { EmojiPicker } from '../channel/EmojiPicker';
import { Animated } from '../ui/Animated';
import { StatusEmoji } from '../ui/StatusEmoji';

const STATUSES: UserStatus[] = ['ONLINE', 'IDLE', 'DND', 'LOOKING_TO_PLAY', 'UNAVAILABLE'];
const TIMED = new Set<UserStatus>(['IDLE', 'DND', 'LOOKING_TO_PLAY']);

const MINUTE = 60_000;
const DURATIONS: Array<{ ms: number; key: string }> = [
	{ ms: 0, key: 'status-duration-forever' },
	{ ms: 15 * MINUTE, key: 'status-duration-15m' },
	{ ms: 60 * MINUTE, key: 'status-duration-1h' },
	{ ms: 8 * 60 * MINUTE, key: 'status-duration-8h' },
	{ ms: 24 * 60 * MINUTE, key: 'status-duration-24h' },
];

function DurationChips(props: { value: number; onPick: (ms: number) => void }) {
	return (
		<div class="flex flex-wrap gap-1 px-2.5 pb-2">
			<For each={DURATIONS}>
				{(d) => (
					<button
						type="button"
						onClick={() => props.onPick(d.ms)}
						class="px-2 py-1 rounded-md text-[0.7rem] border transition-colors"
						classList={{
							'bg-[#f7e26c] border-[#f7e26c] text-stone-900': props.value === d.ms,
							'border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800':
								props.value !== d.ms,
						}}
					>
						{t(d.key)}
					</button>
				)}
			</For>
		</div>
	);
}

const formatUntil = (ms: number) =>
	new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function StatusPicker(props: { open: () => boolean; setOpen: (v: boolean) => void }) {
	const me = () => currentUser();
	const status = () => userPresence(me()?.id ?? '') ?? 'UNAVAILABLE';
	const until = () => (TIMED.has(status()) ? ownStatusUntil() : null);

	const [timing, setTiming] = createSignal<UserStatus | null>(null);
	const [editing, setEditing] = createSignal(false);
	const [emoji, setEmoji] = createSignal('');
	const [text, setText] = createSignal('');
	const [clearAfter, setClearAfter] = createSignal(0);
	const [error, setError] = createSignal<string | null>(null);
	const [saving, setSaving] = createSignal(false);
	const [emojiOpen, setEmojiOpen] = createSignal(false);
	const [emojiPos, setEmojiPos] = createSignal<JSX.CSSProperties>({});
	let emojiButton: HTMLButtonElement | undefined;

	// The popover clips its children, so the picker floats in the page, anchored to the button.
	const openEmojiPicker = () => {
		const r = emojiButton?.getBoundingClientRect();
		if (!r) return;
		const left = Math.max(8, Math.min(r.left, window.innerWidth - 352 - 8));
		const below = window.innerHeight - r.bottom;
		setEmojiPos(
			below >= 400 || below >= r.top
				? { left: `${left}px`, top: `${r.bottom + 6}px` }
				: { left: `${left}px`, bottom: `${window.innerHeight - r.top + 6}px` },
		);
		setEmojiOpen(true);
	};

	const custom = () => me()?.customStatus;
	const hasCustom = () => !!(custom()?.text || custom()?.emoji);

	const close = () => {
		props.setOpen(false);
		setTiming(null);
		setEditing(false);
		setEmojiOpen(false);
		setError(null);
	};

	const pick = (s: UserStatus) => {
		if (TIMED.has(s)) {
			setTiming(timing() === s ? null : s);
			return;
		}
		updatePresence(s);
		close();
	};

	const openEditor = () => {
		setEmoji(custom()?.emoji ?? '');
		setText(custom()?.text ?? '');
		setClearAfter(0);
		setError(null);
		setEditing(true);
	};

	const save = async (clear: boolean) => {
		if (saving()) return;
		setSaving(true);
		setError(null);
		try {
			await setCustomStatus(
				clear ? {} : { text: text(), emoji: emoji(), durationMs: clearAfter() || undefined },
			);
			close();
		} catch (e) {
			setError(errorText(e, 'dialog-failed'));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div class="relative mt-1">
			<button
				type="button"
				onClick={() => (props.open() ? close() : props.setOpen(true))}
				class="flex items-center gap-2 px-2 py-1 -ml-2 rounded-lg hover:bg-stone-100 dark:hover:bg-stone-800/60 text-xs font-display italic text-stone-500"
			>
				<span class="w-2 h-2 rounded-full" style={{ 'background-color': statusColors[status()] }} />
				<span>{statusLabels[status()]}</span>
				<Show when={until()}>
					{(ms) => (
						<span class="opacity-70">· {t('status-until', { time: formatUntil(ms()) })}</span>
					)}
				</Show>
				<i
					class="fa-solid fa-chevron-down text-[0.55rem] opacity-60 transition-transform"
					classList={{ 'rotate-180': props.open() }}
				/>
			</button>

			<Animated
				when={props.open()}
				class="mt-1 w-full origin-top rounded-xl bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 p-1"
			>
				<Show
					when={!editing()}
					fallback={
						<div class="p-2 space-y-2">
							<div class="flex gap-2">
								<button
									type="button"
									data-emoji-toggle
									ref={emojiButton}
									onClick={() => (emojiOpen() ? setEmojiOpen(false) : openEmojiPicker())}
									title={t('status-custom-emoji')}
									aria-label={t('status-custom-emoji')}
									aria-expanded={emojiOpen()}
									class="w-10 h-9 shrink-0 flex items-center justify-center rounded-lg bg-stone-100 dark:bg-stone-800 text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700 focus:outline-none focus:ring-2 focus:ring-[#f7e26c]"
								>
									<Show when={emoji()} fallback={<i class="fa-regular fa-face-smile" />}>
										<StatusEmoji emoji={emoji()} />
									</Show>
								</button>
								<input
									value={text()}
									onInput={(e) => setText(e.currentTarget.value)}
									placeholder={t('status-custom-placeholder')}
									maxLength={60}
									aria-label={t('status-custom-placeholder')}
									class="flex-1 min-w-0 rounded-lg bg-stone-100 dark:bg-stone-800 px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#f7e26c]"
								/>
							</div>
							<div class="text-[0.7rem] text-stone-500">{t('status-custom-clear-after')}</div>
							<div class="-mx-2.5">
								<DurationChips value={clearAfter()} onPick={setClearAfter} />
							</div>
							<Show when={error()}>
								<p class="text-xs text-red-600 dark:text-red-400">{error()}</p>
							</Show>
							<div class="flex gap-1.5">
								<button
									type="button"
									disabled={saving()}
									onClick={() => save(false)}
									class="flex-1 px-3 py-1.5 rounded-lg bg-[#f7e26c] text-stone-900 text-xs font-medium disabled:opacity-60"
								>
									{t('status-custom-save')}
								</button>
								<Show when={hasCustom()}>
									<button
										type="button"
										disabled={saving()}
										onClick={() => save(true)}
										class="px-3 py-1.5 rounded-lg text-xs text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
									>
										{t('status-custom-clear')}
									</button>
								</Show>
								<button
									type="button"
									onClick={() => setEditing(false)}
									class="px-3 py-1.5 rounded-lg text-xs text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
								>
									{t('status-custom-cancel')}
								</button>
							</div>
						</div>
					}
				>
					<For each={STATUSES}>
						{(s) => (
							<>
								<button
									type="button"
									onClick={() => pick(s)}
									class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left"
								>
									<span
										class="w-2.5 h-2.5 rounded-full shrink-0"
										style={{ 'background-color': statusColors[s] }}
									/>
									<span class="flex-1">{statusLabels[s]}</span>
									<Show when={TIMED.has(s)}>
										<i
											class="fa-solid fa-chevron-right text-[0.55rem] text-stone-400 transition-transform"
											classList={{ 'rotate-90': timing() === s }}
										/>
									</Show>
									<Show when={s === status() && timing() !== s}>
										<i class="fa-solid fa-check text-xs text-stone-500" />
									</Show>
								</button>
								<Show when={timing() === s}>
									<DurationChips
										value={-1}
										onPick={(ms) => {
											updatePresence(s, ms || undefined);
											close();
										}}
									/>
								</Show>
							</>
						)}
					</For>
					<div class="my-1 border-t border-stone-100 dark:border-stone-800" />
					<button
						type="button"
						onClick={openEditor}
						class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left"
					>
						<span class="w-2.5 text-center shrink-0">{custom()?.emoji || '✎'}</span>
						<span class="flex-1 truncate">
							{hasCustom() ? custom()?.text || t('status-custom-edit') : t('status-custom-set')}
						</span>
					</button>
				</Show>
			</Animated>
			<Show when={emojiOpen()}>
				<Portal>
					<div data-popover-child class="fixed z-[70]" style={emojiPos()}>
						<EmojiPicker
							class="relative w-[22rem] max-w-[calc(100vw-1rem)]"
							onClose={() => setEmojiOpen(false)}
							onPick={(unicode) => {
								setEmoji(unicode);
								setEmojiOpen(false);
							}}
						/>
					</div>
				</Portal>
			</Show>
		</div>
	);
}
