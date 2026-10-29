import { createEffect, createSignal, type JSX, on, onCleanup, Show } from 'solid-js';

const EXIT_MS = 130;

/**
 * Like `Show`, but the content animates in and stays mounted while it animates out.
 * Uses the app's `animate-menu-in` / `animate-popover-out` keyframes.
 */
export function Animated(props: { when: boolean; class?: string; children: JSX.Element }) {
	const [mounted, setMounted] = createSignal(props.when);
	const [leaving, setLeaving] = createSignal(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	createEffect(
		on(
			() => props.when,
			(open) => {
				clearTimeout(timer);
				if (open) {
					setLeaving(false);
					setMounted(true);
				} else if (mounted()) {
					setLeaving(true);
					timer = setTimeout(() => {
						setMounted(false);
						setLeaving(false);
					}, EXIT_MS);
				}
			},
			{ defer: true },
		),
	);
	onCleanup(() => clearTimeout(timer));

	return (
		<Show when={mounted()}>
			<div
				class={props.class}
				classList={{ 'animate-menu-in': !leaving(), 'animate-popover-out': leaving() }}
			>
				{props.children}
			</div>
		</Show>
	);
}
