import { createSignal, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../i18n';

const ANIM_MS = 130;

type Props = {
	title: string;
	description?: string;
	confirmLabel: string;
	busyLabel: string;
	errorText?: string;
	onClose: () => void;
	onConfirm: () => Promise<void>;
	children?: JSX.Element;
};

export function ConfirmDialog(props: Props) {
	const [closing, setClosing] = createSignal(false);
	const [submitting, setSubmitting] = createSignal(false);
	const [failed, setFailed] = createSignal(false);
	let timer: number | undefined;

	const close = () => {
		if (closing() || submitting()) return;
		setClosing(true);
		timer = window.setTimeout(props.onClose, ANIM_MS);
	};

	const confirm = async () => {
		setSubmitting(true);
		setFailed(false);
		try {
			await props.onConfirm();
			setSubmitting(false);
			close();
		} catch (err) {
			console.error('confirm failed', err);
			setSubmitting(false);
			setFailed(true);
		}
	};

	onMount(() => {
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
		document.addEventListener('keydown', onKey);
		onCleanup(() => document.removeEventListener('keydown', onKey));
	});
	onCleanup(() => clearTimeout(timer));

	return (
		<Portal>
			<div
				class={`fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-sm ${
					closing() ? 'animate-fade-out' : 'animate-fade-in'
				}`}
				onClick={close}
			/>
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
				<div
					role="alertdialog"
					aria-modal="true"
					class={`pointer-events-auto w-full max-w-md rounded-3xl bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 overflow-y-auto max-h-[calc(100dvh-2rem)] ${
						closing() ? 'animate-popover-out' : 'animate-popover-in'
					}`}
				>
					<div class="px-6 pt-6 pb-2">
						<h2 class="font-display text-2xl">{props.title}</h2>
						<Show when={props.description}>
							<p class="text-sm text-stone-500 italic font-display mt-1">{props.description}</p>
						</Show>
					</div>
					<Show when={props.children}>
						<div class="mx-6 my-4">{props.children}</div>
					</Show>
					<Show when={failed()}>
						<p class="px-6 pt-2 text-sm text-red-600">{props.errorText ?? t('dialog-failed')}</p>
					</Show>
					<div class="px-6 pb-6 pt-2 flex gap-2">
						<button
							type="button"
							onClick={close}
							disabled={submitting()}
							class="flex-1 py-2.5 rounded-xl text-sm font-medium bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 transition-colors disabled:opacity-60"
						>
							{t('dialog-cancel')}
						</button>
						<button
							type="button"
							onClick={confirm}
							disabled={submitting()}
							class="flex-1 py-2.5 rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
						>
							{submitting() ? props.busyLabel : props.confirmLabel}
						</button>
					</div>
				</div>
			</div>
		</Portal>
	);
}
