import { createEffect, createSignal, For, type JSX, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { inputBaseClass } from './Input';

export type SelectOption<T> = { value: T; label: string };

export type SelectProps<T> = {
	options: SelectOption<T>[];
	value: T;
	onChange: (v: T) => void;
	leftIcon?: JSX.Element;
	placeholder?: string;
};

export function Select<T>(props: SelectProps<T>) {
	const [open, setOpen] = createSignal(false);
	const [rect, setRect] = createSignal({ x: 0, y: 0, w: 0, above: false });
	let triggerEl: HTMLDivElement | undefined;
	let panelEl: HTMLDivElement | undefined;

	const currentLabel = () =>
		props.options.find((o) => o.value === props.value)?.label ?? props.placeholder ?? '';

	const compute = () => {
		if (!triggerEl) return;
		const r = triggerEl.getBoundingClientRect();
		const PANEL_H = 280;
		const GAP = 8;
		const spaceBelow = window.innerHeight - r.bottom - GAP;
		const above = spaceBelow < Math.min(PANEL_H, 200) && r.top > spaceBelow;
		setRect({
			x: r.left,
			y: above ? r.top - GAP : r.bottom + GAP,
			w: r.width,
			above,
		});
	};

	const openSelect = () => {
		compute();
		setOpen(true);
	};

	createEffect(() => {
		if (!open()) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (triggerEl?.contains(t)) return;
			if (panelEl?.contains(t)) return;
			setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				setOpen(false);
			}
		};
		const onResize = () => compute();
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		window.addEventListener('resize', onResize);
		onCleanup(() => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('resize', onResize);
		});
	});

	return (
		<>
			<div ref={triggerEl} class="relative">
				<button
					type="button"
					onClick={() => (open() ? setOpen(false) : openSelect())}
					class={`${inputBaseClass} flex items-center text-left pr-10`}
				>
					<span class="flex-1 flex items-center gap-2">
						<Show when={props.leftIcon}>{props.leftIcon}</Show>
						<span>{currentLabel()}</span>
					</span>
				</button>
				<i
					class={`fa-solid fa-chevron-down absolute right-4 top-1/2 -translate-y-1/2 text-stone-400 text-xs pointer-events-none transition-transform ${
						open() ? 'rotate-180' : ''
					}`}
				/>
			</div>
			<Show when={open()}>
				<Portal>
					<div
						ref={panelEl}
						class="fixed z-[60] max-h-64 overflow-y-auto rounded-xl bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 shadow-xl shadow-black/15 p-1 animate-popover-in"
						style={{
							left: `${rect().x}px`,
							top: `${rect().y}px`,
							width: `${rect().w}px`,
							transform: rect().above ? 'translateY(-100%)' : undefined,
							'transform-origin': rect().above ? 'bottom center' : 'top center',
						}}
					>
						<For each={props.options}>
							{(opt) => {
								const selected = () => opt.value === props.value;
								return (
									<button
										type="button"
										onClick={() => {
											props.onChange(opt.value);
											setOpen(false);
										}}
										class={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left ${
											selected()
												? 'bg-[#f7e26c]/40 text-stone-900 dark:text-stone-100'
												: 'hover:bg-stone-100 dark:hover:bg-stone-800/60 text-stone-700 dark:text-stone-200'
										}`}
									>
										<span class="flex-1">{opt.label}</span>
										<Show when={selected()}>
											<i class="fa-solid fa-check text-xs text-stone-600 dark:text-stone-300" />
										</Show>
									</button>
								);
							}}
						</For>
					</div>
				</Portal>
			</Show>
		</>
	);
}
