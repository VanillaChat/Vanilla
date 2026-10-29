import { Show } from 'solid-js';

type Props = {
	text: () => string | null;
};

export function TypingIndicator(props: Props) {
	return (
		<Show when={props.text()}>
			<div class="px-4 sm:px-6 pt-1 pb-0.5 text-xs text-stone-500 italic font-display flex items-center gap-2">
				<span class="inline-flex gap-0.5">
					<span class="typing-dot" />
					<span class="typing-dot" />
					<span class="typing-dot" />
				</span>
				<span>{props.text()}…</span>
			</div>
		</Show>
	);
}
