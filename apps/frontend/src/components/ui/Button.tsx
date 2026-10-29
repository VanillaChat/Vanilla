import { type JSX, mergeProps, splitProps } from 'solid-js';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: ButtonVariant;
	size?: ButtonSize;
	fullWidth?: boolean;
	loading?: boolean;
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
	primary:
		'bg-[#f7e26c] text-stone-900 font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:shadow-none',
	secondary:
		'bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 font-medium hover:bg-stone-200 dark:hover:bg-stone-700 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 transition-colors disabled:opacity-60',
	danger:
		'bg-red-600 text-white font-medium hover:bg-red-700 transition-colors disabled:opacity-60',
	ghost:
		'text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
	sm: 'py-2 px-3 text-xs rounded-lg',
	md: 'py-2.5 px-4 text-sm rounded-xl',
};

export function Button(props: ButtonProps) {
	const merged = mergeProps(
		{ variant: 'primary' as ButtonVariant, size: 'md' as ButtonSize },
		props,
	);
	const [local, rest] = splitProps(merged, [
		'variant',
		'size',
		'fullWidth',
		'loading',
		'class',
		'children',
		'disabled',
		'type',
	]);
	const className = () =>
		[
			SIZE_CLASS[local.size],
			VARIANT_CLASS[local.variant],
			local.fullWidth ? 'w-full' : '',
			local.class ?? '',
		]
			.filter(Boolean)
			.join(' ');
	return (
		<button
			{...rest}
			type={local.type ?? 'button'}
			class={className()}
			disabled={local.disabled || local.loading}
		>
			{local.loading ? '…' : local.children}
		</button>
	);
}
