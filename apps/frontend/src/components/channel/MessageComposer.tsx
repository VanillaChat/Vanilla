import { createEffect, createMemo, createSignal, For, lazy, Show, Suspense } from 'solid-js';
import type { GatewayChannel } from '../../api/gateway';
import type { Message } from '../../api/messages';
import { t } from '../../i18n';
import { addFiles, isUploading, readyIds } from '../../state/attachments';
import {
	customShortcodes,
	emojiUrl,
	loadShortcodes,
	matchShortcodes,
	rememberEmoji,
	type Shortcode,
} from '../../state/emoji';
import { getUser } from '../../state/gateway-data';
import { prefs } from '../../state/prefs';
import { MessageBody } from '../message/MessageBody';
import { Emoji } from '../ui/Emoji';
import { AttachmentTray } from './AttachmentTray';
import { EmojiPicker } from './EmojiPicker';
import type { EditorHandle } from './editor';
import { formatCooldown, previewText } from './utils';

const LiveEditor = lazy(() => import('./LiveEditor'));

type Props = {
	channelId: () => string;
	channel: () => GatewayChannel | undefined;
	draft: () => string;
	onDraftInput: (value: string) => void;
	onSend: (e: Event) => void;
	sending: () => boolean;
	cooldown: () => number;
	replyingTo: () => Message | null;
	onCancelReply: () => void;
	composerRef: (h: { focus(): void }) => void;
	mentionCandidates: () => string[];
};

export function MessageComposer(props: Props) {
	let editor: EditorHandle | undefined;
	let picker: HTMLInputElement | undefined;
	const [dragging, setDragging] = createSignal(false);
	const attach = (files: File[]) => {
		if (files.length) addFiles(props.channelId(), files);
	};
	const canSend = () =>
		(!!props.draft().trim() || readyIds(props.channelId()).length > 0) &&
		!isUploading(props.channelId()) &&
		!props.sending() &&
		props.cooldown() <= 0;
	const [query, setQuery] = createSignal<string | null>(null);
	const [picked, setPicked] = createSignal(0);
	const [emojiOpen, setEmojiOpen] = createSignal(false);

	const [emojiQuery, setEmojiQuery] = createSignal<string | null>(null);
	// A plain signal, not a resource: a pending resource would trip the editor's Suspense
	// boundary and remount (unfocus) the input mid-typing.
	const [shortcodes, setShortcodes] = createSignal<Shortcode[]>();
	createEffect(() => {
		if (emojiQuery() !== null && !shortcodes()) loadShortcodes().then(setShortcodes);
	});
	const emojiMatches = createMemo<Shortcode[]>(() => {
		const q = emojiQuery();
		const all = shortcodes();
		if (q === null || !all) return [];
		return [...matchShortcodes(customShortcodes(), q, 5), ...matchShortcodes(all, q)].slice(0, 8);
	});

	const matches = createMemo(() => {
		const q = query();
		if (q === null) return [];
		const lower = q.toLowerCase();
		return ['everyone', 'here', ...props.mentionCandidates()]
			.filter((name, i, all) => all.indexOf(name) === i && name.toLowerCase().startsWith(lower))
			.slice(0, 6);
	});

	const trackMention = (text: string, caret: number) => {
		const before = text.slice(0, caret);
		const m = /(^|\s)@([\w.-]*)$/.exec(before);
		setQuery(m ? m[2] : null);
		const e = /(^|\s):([\w+-]{2,})$/.exec(before);
		setEmojiQuery(e ? e[2] : null);
		setPicked(0);
	};

	const acceptEmoji = (unicode: string) => {
		if (!editor) return;
		const caret = editor.caret();
		const typed = /:[\w+-]{2,}$/.exec(props.draft().slice(0, caret));
		if (!typed) return;
		setEmojiQuery(null);
		rememberEmoji(unicode);
		editor.replace(caret - typed[0].length, caret, `${unicode} `);
	};

	const accept = (name: string) => {
		if (!editor) return;
		const caret = editor.caret();
		const typed = /@[\w.-]*$/.exec(props.draft().slice(0, caret));
		if (!typed) return;
		setQuery(null);
		editor.replace(caret - typed[0].length, caret, `@${name} `);
	};

	const setEditor = (h: EditorHandle) => {
		editor = h;
		props.composerRef(h);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (emojiMatches().length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const n = emojiMatches().length;
				setPicked((picked() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				acceptEmoji(emojiMatches()[picked()].unicode);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setEmojiQuery(null);
				return;
			}
		}
		if (matches().length > 0) {
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const n = matches().length;
				setPicked((picked() + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				accept(matches()[picked()]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				setQuery(null);
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			props.onSend(e);
		}
		if (e.key === 'Escape' && props.replyingTo() && !props.draft()) {
			e.preventDefault();
			props.onCancelReply();
		}
	};

	// Leaving the input dismisses the suggestion lists (clicking one doesn't blur: see onMouseDown).
	const dismissSuggestions = () => {
		setQuery(null);
		setEmojiQuery(null);
	};

	const onPaste = (e: ClipboardEvent) => {
		const files = Array.from(e.clipboardData?.files ?? []);
		if (!files.length) return;
		e.preventDefault();
		attach(files);
	};

	const placeholder = () => t('composer-placeholder', { name: props.channel()?.name ?? '' });

	return (
		<form
			onSubmit={props.onSend}
			onDragOver={(e) => {
				if (!e.dataTransfer?.types.includes('Files')) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(e) => {
				if (!e.dataTransfer?.files.length) return;
				e.preventDefault();
				setDragging(false);
				attach(Array.from(e.dataTransfer.files));
			}}
			class="relative px-3 sm:px-6 pb-3 sm:pb-5 pt-2 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-5"
		>
			<Show when={matches().length > 0}>
				<div class="absolute left-3 right-3 sm:left-6 sm:right-6 bottom-full mb-1 z-20 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/10 p-1">
					<For each={matches()}>
						{(name, i) => (
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									accept(name);
								}}
								class="w-full text-left rounded-lg px-2.5 py-1.5 text-sm"
								classList={{
									'bg-[#f7e26c]/40 text-stone-900 dark:text-stone-100': picked() === i(),
									'text-stone-700 dark:text-stone-300': picked() !== i(),
								}}
							>
								@{name}
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={emojiMatches().length > 0}>
				<div class="absolute left-3 right-3 sm:left-6 sm:right-6 bottom-full mb-1 z-20 rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/10 p-1">
					<For each={emojiMatches()}>
						{(s, i) => (
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									acceptEmoji(s.unicode);
								}}
								class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-left"
								classList={{
									'bg-[#f7e26c]/40 text-stone-900 dark:text-stone-100': picked() === i(),
									'text-stone-700 dark:text-stone-300': picked() !== i(),
								}}
							>
								<Emoji char={s.unicode} url={s.src ?? emojiUrl(s.unicode)} />
								<span class="truncate">:{s.code}:</span>
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={emojiOpen()}>
				<EmojiPicker
					onClose={() => setEmojiOpen(false)}
					onPick={(unicode, keepOpen) => {
						const at = editor?.caret() ?? props.draft().length;
						editor?.replace(at, at, unicode);
						if (!keepOpen) setEmojiOpen(false);
					}}
				/>
			</Show>
			<Show when={props.replyingTo()}>
				{(r) => {
					const refUser = () => getUser(r().authorId);
					const refName = () =>
						r().author?.member?.nickname ?? refUser()?.username ?? r().author?.username ?? '?';
					return (
						<div class="flex items-center gap-2 px-3 py-1.5 -mb-1 rounded-t-2xl bg-[#fdfaf3] dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 text-xs text-stone-500 dark:text-stone-400">
							<i class="fa-solid fa-reply text-[#a37b00] dark:text-[#f7e26c]" />
							<span class="truncate">
								{t('reply-to', { name: refName() })}
								<span class="opacity-70">
									{' · '}
									<MessageBody text={previewText(r())} mode="inline" />
								</span>
							</span>
							<button
								type="button"
								onClick={props.onCancelReply}
								class="ml-auto w-6 h-6 flex items-center justify-center rounded-md hover:bg-stone-200 dark:hover:bg-stone-800 text-stone-500 hover:text-stone-800 dark:hover:text-stone-100 shrink-0"
								title={t('reply-cancel')}
								aria-label={t('reply-cancel')}
							>
								<i class="fa-solid fa-xmark text-xs" />
							</button>
						</div>
					);
				}}
			</Show>
			<div
				class="flex flex-col bg-[#fdfaf3] dark:bg-stone-900 px-3 py-2 focus-within:bg-white dark:focus-within:bg-stone-800 transition-colors shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] focus-within:shadow-[inset_0_0_0_1px_rgba(247,226,108,0.5)]"
				classList={{
					'rounded-2xl': !props.replyingTo(),
					'rounded-b-2xl': !!props.replyingTo(),
					'ring-2 ring-[#f7e26c]': dragging(),
				}}
			>
				<AttachmentTray channelId={props.channelId} />
				<Show when={dragging()}>
					<div class="text-xs text-stone-500 italic font-display pb-1">
						{t('composer-drop-hint')}
					</div>
				</Show>
				<div class="flex items-stretch gap-2">
					<input
						ref={picker}
						type="file"
						multiple
						class="hidden"
						onChange={(e) => {
							attach(Array.from(e.currentTarget.files ?? []));
							e.currentTarget.value = '';
						}}
					/>
					<button
						type="button"
						onClick={() => picker?.click()}
						class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 px-2 self-start mt-2"
						title={t('composer-attach')}
						aria-label={t('composer-attach')}
					>
						<i class="fa-solid fa-paperclip" />
					</button>
					<Show
						when={prefs().liveFormatting}
						fallback={
							<textarea
								ref={(el) => {
									setEditor({
										focus: () => el.focus(),
										caret: () => el.selectionStart,
										replace: (from, to, insert) => {
											el.setRangeText(insert, from, to, 'end');
											props.onDraftInput(el.value);
											el.focus();
										},
									});
								}}
								placeholder={placeholder()}
								value={props.draft()}
								rows={1}
								onInput={(e) => {
									const el = e.currentTarget;
									el.style.height = 'auto';
									el.style.height = `${Math.min(200, el.scrollHeight)}px`;
									props.onDraftInput(el.value);
									trackMention(el.value, el.selectionStart);
								}}
								onPaste={onPaste}
								onBlur={dismissSuggestions}
								onKeyDown={onKeyDown}
								class="flex-1 bg-transparent outline-none text-sm placeholder:text-stone-400 placeholder:italic placeholder:font-display resize-none py-2 leading-relaxed"
							/>
						}
					>
						<Suspense fallback={<div class="flex-1 min-h-10" />}>
							<LiveEditor
								value={props.draft}
								placeholder={placeholder()}
								onInput={props.onDraftInput}
								onKeyDown={onKeyDown}
								onPaste={onPaste}
								onBlur={dismissSuggestions}
								onCursor={trackMention}
								handle={setEditor}
							/>
						</Suspense>
					</Show>
					<button
						type="button"
						data-emoji-toggle
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => setEmojiOpen(!emojiOpen())}
						class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200 px-2 self-start mt-2"
						classList={{ 'text-stone-700 dark:text-stone-200': emojiOpen() }}
						title={t('composer-emoji')}
						aria-label={t('composer-emoji')}
						aria-expanded={emojiOpen()}
					>
						<i class="fa-regular fa-face-smile" />
					</button>
					<button
						type="submit"
						class="self-end w-9 h-9 rounded-xl bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow disabled:opacity-50 disabled:hover:shadow-none flex items-center justify-center shrink-0"
						disabled={!canSend()}
						title={
							props.cooldown() > 0
								? t('slowmode-left', { time: formatCooldown(props.cooldown()) })
								: t('composer-send')
						}
					>
						<i
							class={
								props.cooldown() > 0
									? 'fa-solid fa-stopwatch text-xs'
									: props.sending()
										? 'fa-solid fa-spinner fa-spin text-xs'
										: 'fa-solid fa-paper-plane text-xs'
							}
						/>
					</button>
				</div>
			</div>
		</form>
	);
}
