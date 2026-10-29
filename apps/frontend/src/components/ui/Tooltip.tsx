import { createSignal, createUniqueId, type JSX, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';

export type TooltipProps = {
	text: string;
	children: JSX.Element;
	placement?: 'top' | 'bottom';
	delay?: number;
	class?: string;
};

const GAP = 8;
const EDGE = 8;

export function Tooltip(props: TooltipProps) {
	const id = createUniqueId();
	const [anchor, setAnchor] = createSignal<{ x: number; y: number; above: boolean } | null>(null);
	let wrap: HTMLSpanElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const open = () => {
		if (!wrap) return;
		const r = wrap.getBoundingClientRect();
		const preferTop = (props.placement ?? 'top') === 'top';
		const above = preferTop ? r.top > 56 : r.bottom + 56 > window.innerHeight;
		setAnchor({ x: r.left + r.width / 2, y: above ? r.top - GAP : r.bottom + GAP, above });
	};

	const show = (immediate: boolean) => {
		clearTimeout(timer);
		// Touch browsers emulate mouseenter on tap, which would leave the bubble stuck open.
		if (!immediate && !window.matchMedia('(hover: hover)').matches) return;
		if (immediate) open();
		else timer = setTimeout(open, props.delay ?? 350);
	};

	const hide = () => {
		clearTimeout(timer);
		setAnchor(null);
	};

	onCleanup(() => clearTimeout(timer));

	// Places the bubble from its measured size and only then reveals it, so it never
	// shows up at an intermediate spot.
	const place = (el: HTMLDivElement) => {
		const a = anchor();
		const run = () => {
			if (!a) return;
			if (!el.isConnected) {
				requestAnimationFrame(run);
				return;
			}
			const r = el.getBoundingClientRect();
			let left = a.x - r.width / 2;
			left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - r.width));
			const top = a.above ? a.y - r.height : a.y;
			el.style.left = `${left}px`;
			el.style.top = `${top}px`;
			el.style.visibility = 'visible';
		};
		queueMicrotask(run);
	};

	return (
		<>
			<span
				ref={wrap}
				class={props.class ?? 'inline-flex'}
				aria-describedby={anchor() ? id : undefined}
				onMouseEnter={() => show(false)}
				onMouseLeave={hide}
				onFocusIn={() => show(true)}
				onFocusOut={hide}
				onPointerDown={hide}
			>
				{props.children}
			</span>
			<Show when={anchor()}>
				<Portal>
					<div
						ref={place}
						id={id}
						role="tooltip"
						class="fixed left-0 top-0 z-[70] pointer-events-none max-w-[16rem]"
						style={{ visibility: 'hidden' }}
					>
						{/* The entrance animation owns `transform`, so it lives on an inner element. */}
						<div class="rounded-lg bg-stone-900 dark:bg-stone-100 text-stone-50 dark:text-stone-900 px-2.5 py-1.5 text-xs leading-snug shadow-lg shadow-black/20 animate-popover-in">
							{props.text}
						</div>
					</div>
				</Portal>
			</Show>
		</>
	);
}

export function InfoTip(props: { text: string }) {
	return (
		<Tooltip text={props.text}>
			<button
				type="button"
				aria-label={props.text}
				class="text-stone-400 hover:text-stone-600 dark:hover:text-stone-200 text-[0.7rem] leading-none"
			>
				<i class="fa-regular fa-circle-question" />
			</button>
		</Tooltip>
	);
}
