import { createSignal } from 'solid-js';

export type SliderProps = {
	value: number;
	min: number;
	max: number;
	step?: number;
	label: string;
	onInput: (value: number) => void;
	onCommit?: (value: number) => void;
	class?: string;
};

export function Slider(props: SliderProps) {
	const [active, setActive] = createSignal(false);
	const pct = () =>
		Math.min(100, Math.max(0, ((props.value - props.min) / (props.max - props.min)) * 100));

	return (
		<div class={`relative h-5 flex items-center ${props.class ?? ''}`}>
			<div class="absolute inset-x-0 h-1.5 rounded-full bg-stone-200 dark:bg-stone-700 overflow-hidden">
				<div class="h-full bg-[#f7e26c]" style={{ width: `${pct()}%` }} />
			</div>
			<div
				class="absolute w-4 h-4 -ml-2 rounded-full bg-white border-2 border-[#c9a800] shadow transition-transform pointer-events-none"
				classList={{ 'scale-125': active() }}
				style={{ left: `${pct()}%` }}
			/>
			<input
				type="range"
				aria-label={props.label}
				min={props.min}
				max={props.max}
				step={props.step ?? 1}
				value={props.value}
				onInput={(e) => props.onInput(Number(e.currentTarget.value))}
				onChange={(e) => props.onCommit?.(Number(e.currentTarget.value))}
				onPointerDown={() => setActive(true)}
				onPointerUp={() => setActive(false)}
				onPointerCancel={() => setActive(false)}
				onBlur={() => setActive(false)}
				class="absolute inset-0 w-full h-full m-0 opacity-0 cursor-pointer"
			/>
		</div>
	);
}
