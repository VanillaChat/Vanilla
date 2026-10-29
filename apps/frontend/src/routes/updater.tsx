import { createFileRoute } from '@tanstack/solid-router';
import { Switch as Branch, createSignal, Match, onMount, Show } from 'solid-js';
import { t } from '../i18n';
import { MARK_LEFT, MARK_RIGHT, MARK_TRANSFORM } from '../state/default-avatar';

export const Route = createFileRoute('/updater')({
	component: Splash,
});

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke: Invoke = (cmd, args) => {
	const call = (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } })
		.__TAURI_INTERNALS__?.invoke;
	return call ? call(cmd, args) : Promise.reject(new Error('not the desktop app'));
};

type Status = {
	state: string;
	downloaded?: number;
	total?: number | null;
};

const MIN_SHOWN_MS = 1200;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Small startup window: looks for an update, installs it, then opens the app. */
function Splash() {
	const [phase, setPhase] = createSignal<'checking' | 'downloading' | 'starting' | 'failed'>(
		'checking',
	);
	const [percent, setPercent] = createSignal(0);
	const [detail, setDetail] = createSignal('');

	const start = () =>
		invoke('start_app').catch((e) => setDetail(e instanceof Error ? e.message : String(e)));

	const run = async () => {
		setPhase('checking');
		const began = Date.now();
		try {
			const found = (await invoke('update_check')) as Status;
			if (found.state !== 'available') {
				// Long enough to read, short enough not to feel like a delay.
				await wait(Math.max(0, MIN_SHOWN_MS - (Date.now() - began)));
				return start();
			}
			setPhase('downloading');
			await invoke('update_install');
			for (;;) {
				await wait(300);
				const s = (await invoke('update_status')) as Status;
				if (s.state === 'downloading' && s.total) {
					setPercent(Math.min(100, Math.round(((s.downloaded ?? 0) / s.total) * 100)));
				}
				if (s.state === 'ready') break;
				if (s.state === 'error') throw new Error('download failed');
			}
			setPhase('starting');
			await invoke('update_apply');
		} catch (e) {
			setDetail(e instanceof Error ? e.message : String(e));
			setPhase('failed');
		}
	};

	onMount(run);

	return (
		<div
			data-tauri-drag-region
			class="fixed inset-0 flex flex-col items-center justify-center gap-5 px-10 text-center bg-[#fdfaf3] dark:bg-[#1a1816] text-stone-900 dark:text-stone-100 select-none"
		>
			<div class="w-20 h-20 rounded-3xl bg-[#f7e26c] grid place-items-center pointer-events-none">
				<svg viewBox="0 0 100 100" class="w-12 h-12 text-stone-900" aria-hidden="true">
					<g transform="translate(50 52) scale(0.62) translate(-81 -67.5)">
						<g transform={MARK_TRANSFORM} fill="currentColor">
							<path d={MARK_LEFT} />
							<path d={MARK_RIGHT} />
						</g>
					</g>
				</svg>
			</div>

			<Branch>
				<Match when={phase() === 'checking'}>
					<p class="font-display text-xl">{t('updater-checking')}</p>
					<Bar />
				</Match>
				<Match when={phase() === 'downloading'}>
					<p class="font-display text-xl">{t('updater-downloading')}</p>
					<Bar value={percent()} />
					<p class="text-sm text-stone-500 tabular-nums">{percent()}%</p>
				</Match>
				<Match when={phase() === 'starting'}>
					<p class="font-display text-xl">{t('updater-starting')}</p>
					<Bar value={100} />
				</Match>
				<Match when={phase() === 'failed'}>
					<p class="font-display text-xl">{t('updater-failed')}</p>
					<p class="text-sm text-stone-500">{t('updater-failed-body')}</p>
					<Show when={detail()}>
						<p class="text-xs text-stone-400 break-words max-w-full">{detail()}</p>
					</Show>
					<div class="flex gap-2.5 pt-1">
						<button
							type="button"
							onClick={run}
							class="px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#f7e26c] text-stone-900"
						>
							{t('updater-retry')}
						</button>
						<button
							type="button"
							onClick={start}
							class="px-5 py-2.5 rounded-xl text-sm font-medium bg-white dark:bg-transparent text-stone-600 dark:text-stone-300 shadow-[inset_0_0_0_1px_var(--color-stone-200)] dark:shadow-[inset_0_0_0_1px_var(--color-stone-700)]"
						>
							{t('updater-continue')}
						</button>
					</div>
				</Match>
			</Branch>
		</div>
	);
}

/** Without a value the bar sweeps, for steps whose length is unknown. */
function Bar(props: { value?: number }) {
	return (
		<div class="w-48 h-2 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden relative pointer-events-none">
			<Show
				when={props.value !== undefined}
				fallback={
					<div class="absolute inset-y-0 w-1/3 rounded-full bg-[#f7e26c] animate-[splash-sweep_1.2s_ease-in-out_infinite]" />
				}
			>
				<div
					class="h-full rounded-full bg-[#f7e26c] transition-[width] duration-300"
					style={{ width: `${props.value}%` }}
				/>
			</Show>
		</div>
	);
}
