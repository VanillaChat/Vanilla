import { createEffect, createSignal, Show } from 'solid-js';
import { gatewayState } from '../../api/gateway';
import { t } from '../../i18n';

export function ConnectionBar() {
	const [visible, setVisible] = createSignal(gatewayState() !== 'ready');
	const [closing, setClosing] = createSignal(false);
	let timer: number | null = null;

	createEffect(() => {
		const s = gatewayState();
		if (s !== 'ready') {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			setClosing(false);
			setVisible(true);
		} else if (visible() && !closing()) {
			setClosing(true);
			timer = window.setTimeout(() => {
				setVisible(false);
				setClosing(false);
				timer = null;
			}, 200);
		}
	});

	return (
		<Show when={visible()}>
			<div
				class={`fixed top-4 left-1/2 z-[60] flex items-center gap-2 px-4 py-2 rounded-full bg-[#fdf6cc] dark:bg-[#3a3624] text-[#7a5a00] dark:text-[#e8d27a] border border-[#f0d96b]/60 dark:border-[#5a5028] shadow-lg shadow-black/10 backdrop-blur-sm text-sm font-medium ${
					closing() ? 'animate-slide-up-out' : 'animate-slide-down-in'
				}`}
				style={{ transform: 'translateX(-50%)' }}
			>
				<i class="fa-solid fa-circle-notch fa-spin text-xs" />
				<span>{t('app-connecting')}</span>
			</div>
		</Show>
	);
}
