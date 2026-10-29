import { createSignal, Show } from 'solid-js';
import { ApiError } from '../api/client';
import { createServer, joinServer } from '../api/servers';
import { t } from '../i18n';
import { adoptServer } from '../state/join';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

type Tab = 'create' | 'join';

export function ServerModal(props: {
	onClose: () => void;
	onCreated?: (id: string) => void;
	closing?: boolean;
	initialCode?: string;
}) {
	const [tab, setTab] = createSignal<Tab>(props.initialCode ? 'join' : 'create');
	const [name, setName] = createSignal('');
	const [brief, setBrief] = createSignal('');
	const [code, setCode] = createSignal(props.initialCode ?? '');
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);

	const onSubmit = async (e: Event) => {
		e.preventDefault();
		setError(null);
		setSubmitting(true);
		try {
			const result =
				tab() === 'create'
					? await createServer({ name: name(), brief: brief().trim() || undefined })
					: await joinServer({ inviteCode: code() });
			const id = adoptServer(result);
			if (id) props.onCreated?.(id);
			props.onClose();
		} catch (err) {
			const msg =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: t('server-modal-failed');
			setError(msg);
		} finally {
			setSubmitting(false);
		}
	};

	const tabClass = (active: boolean) =>
		`flex-1 py-2 text-sm font-display rounded-xl ${
			active
				? 'bg-[#f7e26c] text-stone-900 font-medium'
				: 'text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800'
		}`;

	return (
		<>
			<div
				class={`fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-sm ${
					props.closing ? 'animate-fade-out' : 'animate-fade-in'
				}`}
				onClick={props.onClose}
			/>
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
				<div
					class={`pointer-events-auto w-full max-w-md rounded-3xl bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 overflow-y-auto max-h-[calc(100dvh-2rem)] ${
						props.closing ? 'animate-popover-out' : 'animate-popover-in'
					}`}
				>
					<div class="px-6 pt-6 pb-4 border-b border-stone-100 dark:border-stone-800">
						<h2 class="font-display text-3xl">{t('server-modal-title')}</h2>
						<p class="text-sm text-stone-500 italic font-display mt-1">
							{t('server-modal-subtitle')}
						</p>
					</div>

					<div class="px-6 pt-4 flex gap-2">
						<button
							type="button"
							onClick={() => setTab('create')}
							class={tabClass(tab() === 'create')}
						>
							{t('server-modal-create')}
						</button>
						<button type="button" onClick={() => setTab('join')} class={tabClass(tab() === 'join')}>
							{t('server-modal-join')}
						</button>
					</div>

					<form onSubmit={onSubmit} class="p-6 space-y-3">
						<Show
							when={tab() === 'create'}
							fallback={
								<>
									<label class="block text-xs font-display italic text-stone-500 px-1">
										{t('server-modal-invite')}
									</label>
									<Input
										type="text"
										placeholder={t('server-modal-invite-placeholder')}
										required
										value={code()}
										onInput={(e) => setCode(e.currentTarget.value)}
									/>
								</>
							}
						>
							<label class="block text-xs font-display italic text-stone-500 px-1">
								{t('server-modal-name')}
							</label>
							<Input
								type="text"
								placeholder={t('server-modal-name-placeholder')}
								required
								maxLength={100}
								value={name()}
								onInput={(e) => setName(e.currentTarget.value)}
							/>
							<label class="block text-xs font-display italic text-stone-500 px-1 pt-2">
								{t('server-modal-brief')}{' '}
								<span class="text-stone-400">{t('server-modal-brief-optional')}</span>
							</label>
							<Input
								type="text"
								placeholder={t('server-modal-brief-placeholder')}
								maxLength={200}
								value={brief()}
								onInput={(e) => setBrief(e.currentTarget.value)}
							/>
						</Show>

						<Show when={error()}>
							<div class="text-sm text-red-600 dark:text-red-400 pt-1">{error()}</div>
						</Show>

						<div class="flex gap-2 pt-3">
							<Button variant="secondary" fullWidth onClick={props.onClose}>
								{t('server-modal-cancel')}
							</Button>
							<Button type="submit" fullWidth loading={submitting()}>
								{tab() === 'create' ? t('server-modal-create') : t('server-modal-join')}
							</Button>
						</div>
					</form>
				</div>
			</div>
		</>
	);
}
