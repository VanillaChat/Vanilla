import { createSignal, For, onCleanup, Show } from 'solid-js';
import { type Attachment, attachmentUrl, formatBytes, isInlineImage } from '../../api/attachments';
import { t } from '../../i18n';

const MAX_W = 400;
const MAX_H = 320;

function ImageAttachment(props: { a: Attachment; onOpen: () => void }) {
	const size = () => {
		const w = props.a.width ?? MAX_W;
		const h = props.a.height ?? MAX_H;
		const scale = Math.min(1, MAX_W / w, MAX_H / h);
		return { width: Math.round(w * scale), height: Math.round(h * scale) };
	};
	return (
		<button
			type="button"
			onClick={props.onOpen}
			class="block rounded-xl overflow-hidden bg-stone-200/60 dark:bg-stone-800/60 cursor-zoom-in max-w-full"
			style={{ width: `${size().width}px`, 'aspect-ratio': `${size().width} / ${size().height}` }}
			title={props.a.filename}
		>
			<img
				src={attachmentUrl(props.a)}
				alt={props.a.filename}
				loading="lazy"
				width={size().width}
				height={size().height}
				class="w-full h-full object-cover"
			/>
		</button>
	);
}

function FileAttachment(props: { a: Attachment }) {
	return (
		<a
			href={attachmentUrl(props.a)}
			download={props.a.filename}
			rel="noopener noreferrer"
			class="flex items-center gap-3 max-w-sm rounded-xl border border-stone-200 dark:border-stone-700 bg-[#fdfaf3] dark:bg-stone-900/60 px-3 py-2.5 hover:bg-white dark:hover:bg-stone-900 transition-colors"
		>
			<i class="fa-regular fa-file text-xl text-stone-400 shrink-0" />
			<span class="min-w-0">
				<span class="block text-sm text-sky-700 dark:text-sky-400 truncate">
					{props.a.filename}
				</span>
				<span class="block text-xs text-stone-500">{formatBytes(props.a.size)}</span>
			</span>
			<i class="fa-solid fa-download text-stone-400 ml-auto shrink-0" />
		</a>
	);
}

const FADE_MS = 150;

function Lightbox(props: { a: Attachment; onClose: () => void }) {
	// Mounted hidden, then flipped on the next frame so the CSS transition has a start state.
	const [shown, setShown] = createSignal(false);
	// One frame is not enough: the hidden state must be painted once before it can animate.
	let frame = requestAnimationFrame(() => {
		frame = requestAnimationFrame(() => setShown(true));
	});
	let closing: ReturnType<typeof setTimeout> | undefined;
	const close = () => {
		if (closing) return;
		setShown(false);
		closing = setTimeout(props.onClose, FADE_MS);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') close();
	};
	document.addEventListener('keydown', onKey);
	onCleanup(() => {
		cancelAnimationFrame(frame);
		clearTimeout(closing);
		document.removeEventListener('keydown', onKey);
	});
	return (
		<div
			class="fixed inset-0 z-50 flex flex-col items-center justify-center p-4 gap-3 transition-colors duration-150 ease-out motion-reduce:transition-none"
			classList={{ 'bg-black/80': shown(), 'bg-black/0': !shown() }}
			role="dialog"
			aria-modal="true"
			aria-label={props.a.filename}
		>
			<button
				type="button"
				class="absolute inset-0 cursor-zoom-out"
				onClick={close}
				aria-label={t('attachment-close')}
			/>
			<div
				class="relative flex flex-col items-center gap-3 max-w-full transition duration-150 ease-out motion-reduce:transition-none"
				classList={{ 'opacity-100 scale-100': shown(), 'opacity-0 scale-95': !shown() }}
			>
				<img
					src={attachmentUrl(props.a)}
					alt={props.a.filename}
					class="max-w-full max-h-[85vh] object-contain rounded-lg"
				/>
				<div class="flex items-center gap-4 text-sm text-stone-200">
					<span class="truncate max-w-xs">{props.a.filename}</span>
					<a
						href={attachmentUrl(props.a)}
						target="_blank"
						rel="noopener noreferrer"
						class="hover:underline"
					>
						{t('attachment-open-original')}
					</a>
				</div>
			</div>
		</div>
	);
}

export function MessageAttachments(props: { attachments?: Attachment[] }) {
	const [open, setOpen] = createSignal<Attachment | null>(null);
	const images = () => (props.attachments ?? []).filter(isInlineImage);
	const files = () => (props.attachments ?? []).filter((a) => !isInlineImage(a));
	return (
		<Show when={props.attachments?.length}>
			<div class="mt-1.5 flex flex-col gap-1.5 items-start">
				<Show when={images().length}>
					<div class="flex flex-wrap gap-1.5">
						<For each={images()}>{(a) => <ImageAttachment a={a} onOpen={() => setOpen(a)} />}</For>
					</div>
				</Show>
				<For each={files()}>{(a) => <FileAttachment a={a} />}</For>
			</div>
			<Show when={open()}>{(a) => <Lightbox a={a()} onClose={() => setOpen(null)} />}</Show>
		</Show>
	);
}
