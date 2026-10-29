import { type JSX, Show, splitProps } from 'solid-js';

export const inputBaseClass =
	'w-full rounded-xl bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-800 px-4 py-3 text-sm outline-none focus:border-stone-400 dark:focus:border-stone-600 transition-colors placeholder:text-stone-400 dark:placeholder:text-stone-600';

export type InputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
	leftIcon?: JSX.Element;
};

export function Input(props: InputProps) {
	const [local, rest] = splitProps(props, ['leftIcon', 'class']);
	return (
		<Show
			when={local.leftIcon}
			fallback={<input {...rest} class={`${inputBaseClass} ${local.class ?? ''}`} />}
		>
			<div class="relative">
				<span class="absolute left-4 top-1/2 -translate-y-1/2 text-stone-400 text-xs pointer-events-none flex items-center">
					{local.leftIcon}
				</span>
				<input {...rest} class={`${inputBaseClass} pl-9 ${local.class ?? ''}`} />
			</div>
		</Show>
	);
}
