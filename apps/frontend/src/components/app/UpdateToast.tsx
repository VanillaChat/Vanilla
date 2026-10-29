import { Show } from 'solid-js';
import { t } from '../../i18n';
import { dismissToast, restartToUpdate, toastVersion } from '../../state/updater';

export function UpdateToast() {
	return (
		<Show when={toastVersion()}>
			{(version) => (
				<div
					role="status"
					class="fixed left-6 bottom-28 z-50 w-64 rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/10 p-3.5 flex flex-col gap-2.5 animate-popover-in"
				>
					<div class="flex items-center gap-2.5">
						<div class="w-8 h-8 rounded-[10px] bg-[#f7e26c] grid place-items-center text-stone-900 shrink-0">
							<i class="fa-solid fa-download text-xs" />
						</div>
						<div class="min-w-0">
							<div class="text-sm font-bold">
								{t('updates-toast-title', { version: version() })}
							</div>
							<div class="text-xs text-stone-500">{t('updates-toast-body')}</div>
						</div>
					</div>
					<div class="flex gap-2">
						<button
							type="button"
							onClick={() => restartToUpdate()}
							class="flex-1 rounded-[10px] py-2 text-[13px] font-semibold bg-[#f7e26c] text-stone-900"
						>
							{t('updates-toast-restart')}
						</button>
						<button
							type="button"
							onClick={dismissToast}
							class="rounded-[10px] px-3.5 py-2 text-[13px] font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300"
						>
							{t('updates-later')}
						</button>
					</div>
				</div>
			)}
		</Show>
	);
}
