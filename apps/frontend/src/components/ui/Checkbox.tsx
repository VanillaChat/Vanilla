import { type JSX, Show } from 'solid-js';
import { Tooltip } from './Tooltip';

export type CheckboxProps = {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: JSX.Element;
	hint?: string;
	disabled?: boolean;
};

export function Checkbox(props: CheckboxProps) {
	return (
		<label
			class="w-full flex items-start gap-3 cursor-pointer"
			classList={{ 'opacity-50 cursor-not-allowed': props.disabled }}
		>
			<input
				type="checkbox"
				class="peer sr-only"
				checked={props.checked}
				disabled={props.disabled}
				onChange={(e) => props.onChange(e.currentTarget.checked)}
			/>
			<span
				class="mt-0.5 w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[#f7e26c]"
				classList={{
					'bg-[#f7e26c] border-[#f7e26c] text-stone-900': props.checked,
					'bg-[#fdfaf3] dark:bg-stone-900 border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500':
						!props.checked,
				}}
			>
				<Show when={props.checked}>
					<i class="fa-solid fa-check text-[0.65rem]" />
				</Show>
			</span>
			<span class="flex-1 min-w-0">
				<span class="flex items-center gap-1.5 text-sm text-stone-800 dark:text-stone-100">
					{props.label}
					<Show when={props.hint}>
						{(hint) => (
							<Tooltip text={hint()}>
								<i
									role="img"
									aria-label={hint()}
									class="fa-regular fa-circle-question text-[0.7rem] text-stone-400 hover:text-stone-600 dark:hover:text-stone-200"
									onClick={(e) => e.preventDefault()}
									onKeyDown={() => {}}
								/>
							</Tooltip>
						)}
					</Show>
				</span>
			</span>
		</label>
	);
}
