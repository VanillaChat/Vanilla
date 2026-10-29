import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../../i18n';
import { copyText, createInviteLink } from '../../state/invite';

export type ChannelMenuState = { x: number; y: number; channelId: string; guildId?: string };

type Status = 'idle' | 'busy' | 'copied' | 'failed';

export function ChannelMenu(props: {
	menu: ChannelMenuState;
	onClose: () => void;
	onSettings?: () => void;
}) {
	const [status, setStatus] = createSignal<Status>('idle');
	let el: HTMLDivElement | undefined;

	onMount(() => {
		const down = (e: MouseEvent) => {
			if (!el?.contains(e.target as Node)) props.onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') props.onClose();
		};
		document.addEventListener('mousedown', down);
		document.addEventListener('keydown', key);
		onCleanup(() => {
			document.removeEventListener('mousedown', down);
			document.removeEventListener('keydown', key);
		});
	});

	const invite = async () => {
		if (status() === 'busy') return;
		setStatus('busy');
		try {
			const link = await createInviteLink(props.menu.channelId);
			setStatus((await copyText(link)) ? 'copied' : 'failed');
		} catch {
			setStatus('failed');
		}
		setTimeout(props.onClose, 900);
	};

	const W = 208;
	const left = () => Math.max(8, Math.min(props.menu.x, window.innerWidth - W - 8));
	const top = () =>
		Math.max(8, Math.min(props.menu.y, window.innerHeight - (props.onSettings ? 104 : 64)));

	return (
		<Portal>
			<div
				ref={el}
				role="menu"
				style={{ left: `${left()}px`, top: `${top()}px`, width: `${W}px` }}
				class="fixed z-[80] rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/15 p-1 animate-popover-in"
			>
				<button
					type="button"
					role="menuitem"
					onClick={invite}
					class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-left text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/60"
				>
					<i
						class="w-4 text-center"
						classList={{
							'fa-solid fa-link': status() === 'idle',
							'fa-solid fa-spinner fa-spin': status() === 'busy',
							'fa-solid fa-check text-green-600': status() === 'copied',
							'fa-solid fa-triangle-exclamation text-red-500': status() === 'failed',
						}}
					/>
					<span>
						<Show when={status() === 'copied'} fallback={t('channel-menu-invite')}>
							{t('invite-copied')}
						</Show>
					</span>
				</button>
				<Show when={props.onSettings}>
					<button
						type="button"
						role="menuitem"
						onClick={() => {
							props.onSettings?.();
							props.onClose();
						}}
						class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-left text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800/60"
					>
						<i class="fa-solid fa-gear w-4 text-center" />
						<span>{t('channel-menu-settings')}</span>
					</button>
				</Show>
			</div>
		</Portal>
	);
}
