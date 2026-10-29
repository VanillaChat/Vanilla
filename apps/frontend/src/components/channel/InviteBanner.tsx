import { Show } from 'solid-js';
import { t } from '../../i18n';

type Props = {
	code: () => string | null;
	error: () => string | null;
	copied: () => boolean;
	onCopy: () => void;
	onClose: () => void;
};

export function InviteBanner(props: Props) {
	return (
		<Show when={props.code() || props.error()}>
			<div class="px-4 sm:px-6 py-3 border-b border-stone-100 dark:border-stone-800 bg-[#fdfaf3] dark:bg-stone-900/40">
				<Show when={props.code()}>
					{(c) => (
						<div class="flex items-center gap-3">
							<i class="fa-solid fa-link text-stone-400" />
							<code class="flex-1 font-mono text-sm text-stone-700 dark:text-stone-200 truncate">
								{c()}
							</code>
							<button
								onClick={props.onCopy}
								class="px-3 py-1.5 rounded-lg bg-[#f7e26c] text-stone-900 text-xs font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow flex items-center gap-1.5"
							>
								<i class={props.copied() ? 'fa-solid fa-check' : 'fa-regular fa-copy'} />
								{props.copied() ? t('invite-copied') : t('invite-copy')}
							</button>
							<button
								onClick={props.onClose}
								class="text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
								title="Dismiss"
							>
								<i class="fa-solid fa-xmark" />
							</button>
						</div>
					)}
				</Show>
				<Show when={props.error()}>
					<div class="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
						<span>{props.error()}</span>
						<button
							onClick={props.onClose}
							class="ml-auto text-stone-400 hover:text-stone-700 dark:hover:text-stone-200"
						>
							<i class="fa-solid fa-xmark" />
						</button>
					</div>
				</Show>
			</div>
		</Show>
	);
}
