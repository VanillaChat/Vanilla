import { useRouter, useRouterState } from '@tanstack/solid-router';
import { Show } from 'solid-js';
import { t } from '../../i18n';
import { MARK_LEFT, MARK_RIGHT, MARK_TRANSFORM } from '../../state/default-avatar';
import { DM_SCOPE, dmTitle, getDm } from '../../state/dms';
import { currentUser, findChannel, guilds } from '../../state/gateway-data';
import { requestUpdatesView, updatePill } from '../../state/updater';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke = (cmd: string) =>
	(window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__
		.invoke(`plugin:window|${cmd}`, { label: 'main' })
		.catch(() => {});

export function TitleBar(props: { solid: boolean }) {
	const router = useRouter();
	const routerState = useRouterState();
	const title = () => {
		const [area, serverId, channelId] = routerState().location.pathname.split('/').filter(Boolean);
		if (area !== 'app' || !serverId) return 'Vanilla';
		if (serverId === DM_SCOPE) {
			const dm = getDm(channelId);
			return dm ? dmTitle(dm, currentUser()?.id) : 'Vanilla';
		}
		const guild = guilds().find((g) => g.id === serverId);
		if (!guild) return 'Vanilla';
		const channel = findChannel(channelId);
		return channel ? `#${channel.name} · ${guild.name}` : guild.name;
	};

	return (
		<div
			data-tauri-drag-region
			class="fixed top-0 inset-x-0 z-[100] h-[var(--titlebar)] flex items-center select-none"
			classList={{ 'bg-[#fdfaf3] dark:bg-[#1a1816]': props.solid }}
		>
			<div class="flex items-center h-full pl-2">
				<Nav icon="fa-solid fa-arrow-left" label="Back" onClick={() => router.history.back()} />
				<Nav
					icon="fa-solid fa-arrow-right"
					label="Forward"
					onClick={() => router.history.forward()}
				/>
			</div>
			<div
				data-tauri-drag-region
				class="absolute inset-x-28 flex items-center justify-center gap-2 pointer-events-none"
			>
				<svg
					viewBox="0 0 100 100"
					class="w-4 h-4 shrink-0 text-stone-500 dark:text-stone-400"
					aria-hidden="true"
				>
					<g transform="translate(50 52) scale(0.62) translate(-81 -67.5)">
						<g transform={MARK_TRANSFORM} fill="currentColor">
							<path d={MARK_LEFT} />
							<path d={MARK_RIGHT} />
						</g>
					</g>
				</svg>
				<span class="truncate text-xs font-medium text-stone-600 dark:text-stone-300">
					{title()}
				</span>
			</div>
			<Show when={props.solid ? updatePill() : null}>
				{(pill) => (
					<button
						type="button"
						onClick={requestUpdatesView}
						class="ml-auto mr-2 self-center flex items-center gap-1.5 rounded-full pl-2 pr-3 py-1 text-xs font-semibold bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow relative"
					>
						<i class="fa-solid fa-download text-[10px]" />
						{t(pill().key, { percent: pill().percent ?? 0 })}
					</button>
				)}
			</Show>
			<div class="h-full flex relative" classList={{ 'ml-auto': !(props.solid && updatePill()) }}>
				<Control icon="fa-solid fa-minus" label="Minimize" onClick={() => invoke('minimize')} />
				<Control
					icon="fa-regular fa-square"
					label="Maximize"
					onClick={() => invoke('toggle_maximize')}
				/>
				<Control icon="fa-solid fa-xmark" label="Close" danger onClick={() => invoke('close')} />
			</div>
		</div>
	);
}

function Nav(props: { icon: string; label: string; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-label={props.label}
			onClick={props.onClick}
			class="w-8 h-full flex items-center justify-center text-xs text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
		>
			<i class={props.icon} />
		</button>
	);
}

function Control(props: { icon: string; label: string; danger?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-label={props.label}
			onClick={props.onClick}
			class="w-12 h-full flex items-center justify-center text-xs text-stone-500 dark:text-stone-400 transition-colors"
			classList={{
				'hover:bg-stone-900/8 dark:hover:bg-white/8 hover:text-stone-900 dark:hover:text-stone-100':
					!props.danger,
				'hover:bg-red-500 hover:text-white': props.danger,
			}}
		>
			<i class={props.icon} />
		</button>
	);
}
