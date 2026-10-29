import { Switch as Branch, Match, Show } from 'solid-js';
import { t } from '../i18n';
import { MARK_LEFT, MARK_RIGHT, MARK_TRANSFORM } from '../state/default-avatar';
import { prefs, updatePrefs } from '../state/prefs';
import {
	appVersion,
	checkForUpdate,
	installUpdate,
	restartToUpdate,
	updateStatus,
} from '../state/updater';

export const formatMb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}`;

export function UpdatesPanel() {
	const s = updateStatus;
	return (
		<div class="flex flex-col gap-6">
			<div class="flex items-center gap-3.5">
				<div class="w-12 h-12 rounded-2xl bg-[#f7e26c] grid place-items-center text-stone-900">
					<svg viewBox="0 0 100 100" class="w-8 h-8" aria-hidden="true">
						<g transform="translate(50 52) scale(0.62) translate(-81 -67.5)">
							<g transform={MARK_TRANSFORM} fill="currentColor">
								<path d={MARK_LEFT} />
								<path d={MARK_RIGHT} />
							</g>
						</g>
					</svg>
				</div>
				<div class="flex-1 min-w-0">
					<div class="font-display text-lg">{t('updates-app')}</div>
					<div class="text-sm text-stone-500">
						{t('updates-version', { version: appVersion() })}
					</div>
				</div>
				<button
					type="button"
					disabled={s().state === 'checking' || s().state === 'downloading'}
					onClick={() => checkForUpdate()}
					class="px-3.5 py-2 rounded-xl text-xs font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-50 transition-colors"
				>
					{t('updates-check')}
				</button>
			</div>

			<Branch>
				<Match when={s().state === 'checking'}>
					<Card>
						<p class="text-sm text-stone-500">{t('updates-checking')}</p>
					</Card>
				</Match>
				<Match when={s().state === 'upToDate'}>
					<Card>
						<p class="text-sm text-stone-600 dark:text-stone-300">{t('updates-up-to-date')}</p>
					</Card>
				</Match>
				<Match when={s().state === 'available' ? (s() as AvailableStatus) : null}>
					{(a) => (
						<Card highlight>
							<div class="flex items-center gap-3">
								<span class="w-2.5 h-2.5 rounded-full bg-[#f7e26c] ring-4 ring-[#f7e26c]/40" />
								<div class="flex-1 font-display text-lg">
									{t('updates-available', { version: a().version })}
								</div>
							</div>
							<Show when={a().notes}>
								{(notes) => (
									<>
										<div class="text-[11px] uppercase tracking-widest font-semibold text-stone-400">
											{t('updates-notes')}
										</div>
										<div class="text-sm text-stone-600 dark:text-stone-300 whitespace-pre-line">
											{notes()}
										</div>
									</>
								)}
							</Show>
							<div class="flex gap-2.5 pt-1">
								<button
									type="button"
									onClick={() => installUpdate()}
									class="px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow"
								>
									{t('updates-install')}
								</button>
							</div>
						</Card>
					)}
				</Match>
				<Match when={s().state === 'downloading' ? (s() as DownloadingStatus) : null}>
					{(d) => {
						const pct = () =>
							d().total
								? Math.min(100, Math.round((d().downloaded / (d().total as number)) * 100))
								: 0;
						return (
							<Card>
								<div class="flex items-baseline gap-3">
									<div class="flex-1 font-display text-lg">
										{t('updates-downloading', { version: d().version })}
									</div>
									<Show when={d().total}>
										<div class="text-xl font-semibold tabular-nums">{pct()}%</div>
									</Show>
								</div>
								<div
									role="progressbar"
									aria-valuenow={pct()}
									aria-valuemin={0}
									aria-valuemax={100}
									class="h-2.5 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden"
								>
									<div
										class="h-full rounded-full bg-[#f7e26c] transition-[width] duration-300"
										style={{ width: `${pct()}%` }}
									/>
								</div>
								<Show when={d().total}>
									{(total) => (
										<div class="text-xs text-stone-500 tabular-nums">
											{formatMb(d().downloaded)} / {formatMb(total())} MB
										</div>
									)}
								</Show>
								<p class="text-sm text-stone-500">{t('updates-keep-chatting')}</p>
							</Card>
						);
					}}
				</Match>
				<Match when={s().state === 'ready' ? (s() as ReadyStatus) : null}>
					{(r) => (
						<Card highlight>
							<div class="flex items-center gap-3">
								<span class="w-9 h-9 rounded-full bg-[#f7e26c] grid place-items-center text-stone-900">
									<i class="fa-solid fa-check text-sm" />
								</span>
								<div class="font-display text-lg">{t('updates-ready-title')}</div>
							</div>
							<div class="text-sm text-stone-600 dark:text-stone-300">
								<p>{t('updates-ready-body', { version: r().version })}</p>
								<p>{t('updates-ready-voice')}</p>
							</div>
							<div class="flex gap-2.5">
								<button
									type="button"
									onClick={() => restartToUpdate()}
									class="px-5 py-2.5 rounded-xl text-sm font-semibold bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow"
								>
									{t('updates-restart')}
								</button>
							</div>
						</Card>
					)}
				</Match>
				<Match when={s().state === 'error' ? (s() as ErrorStatus) : null}>
					{(e) => (
						<Card>
							<p class="text-sm text-red-600 dark:text-red-400">
								{e().message
									? t('updates-error', { message: e().message })
									: t('updates-error-plain')}
							</p>
						</Card>
					)}
				</Match>
			</Branch>

			<div class="flex items-center gap-4 pt-2 border-t border-stone-100 dark:border-stone-800">
				<div class="flex-1 pt-3">
					<div class="text-sm font-medium">{t('updates-auto')}</div>
					<div class="text-xs text-stone-500">{t('updates-auto-hint')}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={prefs().autoUpdate}
					aria-label={t('updates-auto')}
					onClick={() => updatePrefs({ autoUpdate: !prefs().autoUpdate })}
					class={`relative w-11 h-6 rounded-full transition-colors shrink-0 mt-3 ${
						prefs().autoUpdate ? 'bg-[#f7e26c]' : 'bg-stone-300 dark:bg-stone-700'
					}`}
				>
					<span
						class={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${
							prefs().autoUpdate ? 'left-[22px]' : 'left-0.5'
						}`}
					/>
				</button>
			</div>
		</div>
	);
}

type AvailableStatus = Extract<ReturnType<typeof updateStatus>, { state: 'available' }>;
type DownloadingStatus = Extract<ReturnType<typeof updateStatus>, { state: 'downloading' }>;
type ReadyStatus = Extract<ReturnType<typeof updateStatus>, { state: 'ready' }>;
type ErrorStatus = Extract<ReturnType<typeof updateStatus>, { state: 'error' }>;

function Card(props: { highlight?: boolean; children: import('solid-js').JSX.Element }) {
	return (
		<div
			class={`rounded-2xl border p-5 flex flex-col gap-3.5 ${
				props.highlight
					? 'border-[#f1dd6a] bg-[#fffbe6] dark:bg-[#f7e26c]/10 dark:border-[#f7e26c]/30'
					: 'border-stone-200 dark:border-stone-800 bg-[#fdfaf3] dark:bg-stone-900/40'
			}`}
		>
			{props.children}
		</div>
	);
}
