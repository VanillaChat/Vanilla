import { type JSX, onCleanup, onMount, Show } from 'solid-js';

export function Modal(props: {
	title: string;
	subtitle?: string;
	closing?: boolean;
	wide?: boolean;
	fixedHeight?: boolean;
	onClose: () => void;
	children: JSX.Element;
}) {
	onMount(() => {
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') props.onClose();
		};
		document.addEventListener('keydown', key);
		onCleanup(() => document.removeEventListener('keydown', key));
	});
	return (
		<>
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close"
				class={`fixed inset-0 z-50 w-full h-full cursor-default bg-stone-900/40 backdrop-blur-sm ${
					props.closing ? 'animate-fade-out' : 'animate-fade-in'
				}`}
				onClick={props.onClose}
			/>
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
				<div
					role="dialog"
					aria-modal="true"
					aria-label={props.title}
					class={`pointer-events-auto w-full ${
						props.wide ? 'max-w-5xl' : 'max-w-md'
					} rounded-3xl bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 max-h-[calc(100dvh-2rem)] ${
						props.fixedHeight ? 'h-[min(50rem,calc(100dvh-2rem))] flex flex-col' : 'overflow-y-auto'
					} ${props.closing ? 'animate-popover-out' : 'animate-popover-in'}`}
				>
					<div class="px-6 pt-6 pb-4 shrink-0 border-b border-stone-100 dark:border-stone-800 flex items-start gap-3">
						<div class="flex-1 min-w-0">
							<h2 class="font-display text-3xl truncate">{props.title}</h2>
							<Show when={props.subtitle}>
								<p class="text-sm text-stone-500 italic font-display mt-1">{props.subtitle}</p>
							</Show>
						</div>
						<button
							type="button"
							onClick={props.onClose}
							class="w-8 h-8 rounded-lg text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-700 dark:hover:text-stone-200 flex items-center justify-center shrink-0"
							aria-label="Close"
						>
							<i class="fa-solid fa-xmark" />
						</button>
					</div>
					<div classList={{ 'flex-1 min-h-0 overflow-y-auto': props.fixedHeight }}>
						{props.children}
					</div>
				</div>
			</div>
		</>
	);
}
