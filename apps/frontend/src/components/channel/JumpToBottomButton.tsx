import { Show } from 'solid-js';
import { t } from '../../i18n';

type Props = {
	visible: () => boolean;
	unread: () => number;
	onClick: () => void;
};

export function JumpToBottomButton(props: Props) {
	return (
		<Show when={props.visible()}>
			<button
				type="button"
				onClick={props.onClick}
				class="absolute right-4 sm:right-6 bottom-20 sm:bottom-24 z-10 flex items-center gap-2 px-3 py-2 rounded-full bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 shadow-lg shadow-black/15 text-stone-600 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800 animate-fade-in"
				title={t('app-jump-to-present')}
			>
				<i class="fa-solid fa-arrow-down text-xs" />
				<Show when={props.unread() > 0}>
					<span class="text-xs font-medium px-1.5 py-0.5 rounded-full bg-[#f7e26c] text-stone-900 min-w-5 text-center">
						{props.unread() > 99 ? '99+' : props.unread()}
					</span>
				</Show>
			</button>
		</Show>
	);
}
