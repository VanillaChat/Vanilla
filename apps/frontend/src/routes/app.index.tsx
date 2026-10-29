import { createFileRoute } from '@tanstack/solid-router';
import { Show } from 'solid-js';
import { gatewayState } from '../api/gateway';
import { useLayout } from '../contexts/layout';
import { t } from '../i18n';
import { guilds } from '../state/gateway-data';

export const Route = createFileRoute('/app/')({
	component: AppIndex,
});

function AppIndex() {
	const layout = useLayout();
	return (
		<main
			class="relative flex-1 min-w-0 flex flex-col items-center justify-center bg-white dark:bg-[#211e1b] lg:my-3 lg:mx-3 lg:rounded-3xl lg:shadow-[0_2px_10px_rgba(0,0,0,0.04)]"
			style={layout.contentStyle()}
		>
			<button
				type="button"
				onClick={() => layout.toggleSidebar()}
				class="absolute top-3 left-3 w-9 h-9 rounded-xl text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-800 dark:hover:text-stone-100 flex items-center justify-center"
				aria-label={
					layout.isMobile()
						? t('app-open-menu')
						: layout.sidebarCollapsed()
							? t('app-show-sidebar')
							: t('app-hide-sidebar')
				}
				title={
					layout.isMobile()
						? t('app-open-menu')
						: layout.sidebarCollapsed()
							? t('app-show-sidebar')
							: t('app-hide-sidebar')
				}
			>
				<i
					class={`fa-solid text-base ${
						layout.sidebarCollapsed() ? 'fa-bars-staggered' : 'fa-bars'
					}`}
				/>
			</button>
			<Show
				when={gatewayState() === 'ready'}
				fallback={<div class="text-stone-400 font-display italic text-xl">connecting…</div>}
			>
				<Show
					when={guilds().length > 0}
					fallback={
						<div class="text-center px-8">
							<h2 class="font-display text-3xl mb-2">no servers yet</h2>
							<p class="text-sm text-stone-500 italic font-display">join one or make your own.</p>
						</div>
					}
				>
					<div class="text-center px-8">
						<h2 class="font-display text-3xl mb-2">pick a server</h2>
						<p class="text-sm text-stone-500 italic font-display">
							choose one from the rail to get started.
						</p>
					</div>
				</Show>
			</Show>
		</main>
	);
}
