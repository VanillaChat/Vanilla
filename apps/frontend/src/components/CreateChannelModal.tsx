import { createMemo, createSignal, Show } from 'solid-js';
import { createChannel } from '../api/channels';
import { ApiError } from '../api/client';
import type { ChannelType, GatewayChannel } from '../api/gateway';
import { addGuildChannel } from '../api/gateway';
import { t } from '../i18n';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select, type SelectOption } from './ui/Select';

const RATE_LIMIT_KEYS: { value: number; key: string }[] = [
	{ value: 0, key: 'slowmode-off' },
	{ value: 5, key: 'slowmode-5s' },
	{ value: 10, key: 'slowmode-10s' },
	{ value: 15, key: 'slowmode-15s' },
	{ value: 30, key: 'slowmode-30s' },
	{ value: 60, key: 'slowmode-1m' },
	{ value: 120, key: 'slowmode-2m' },
	{ value: 300, key: 'slowmode-5m' },
	{ value: 600, key: 'slowmode-10m' },
	{ value: 900, key: 'slowmode-15m' },
	{ value: 1800, key: 'slowmode-30m' },
	{ value: 3600, key: 'slowmode-1h' },
	{ value: 7200, key: 'slowmode-2h' },
	{ value: 21600, key: 'slowmode-6h' },
];

export function CreateChannelModal(props: {
	guildId: string;
	onClose: () => void;
	onCreated?: (channel: GatewayChannel) => void;
	closing?: boolean;
}) {
	const [name, setName] = createSignal('');
	const [rateLimit, setRateLimit] = createSignal(0);
	const [channelType, setChannelType] = createSignal<ChannelType>('TEXT');
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);

	const rateLimitOptions = createMemo<SelectOption<number>[]>(() =>
		RATE_LIMIT_KEYS.map(({ value, key }) => ({ value, label: t(key) })),
	);

	const channelTypeOptions = createMemo<SelectOption<ChannelType>[]>(() => [
		{ value: 'TEXT', label: t('channel-modal-type-text') },
		{ value: 'VOICE', label: t('channel-modal-type-voice') },
	]);

	const onSubmit = async (e: Event) => {
		e.preventDefault();
		const trimmed = name().trim();
		if (!trimmed) return;
		setError(null);
		setSubmitting(true);
		try {
			const channel = await createChannel(props.guildId, {
				name: trimmed,
				type: channelType(),
				rateLimitPerUser: channelType() === 'TEXT' && rateLimit() > 0 ? rateLimit() : undefined,
			});
			if (channel?.id) {
				addGuildChannel(props.guildId, channel);
				props.onCreated?.(channel);
			}
			props.onClose();
		} catch (err) {
			const msg =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: t('channel-modal-failed');
			setError(msg);
		} finally {
			setSubmitting(false);
		}
	};

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
						<h2 class="font-display text-3xl">{t('channel-modal-title')}</h2>
						<p class="text-sm text-stone-500 italic font-display mt-1">
							{t('channel-modal-subtitle')}
						</p>
					</div>

					<form onSubmit={onSubmit} class="p-6 space-y-3">
						<label class="block text-xs font-display italic text-stone-500 px-1">
							{t('channel-modal-name')}
						</label>
						<Input
							type="text"
							placeholder={t('channel-modal-name-placeholder')}
							required
							maxLength={100}
							value={name()}
							leftIcon={<i class="fa-solid fa-hashtag" />}
							onInput={(e) => setName(e.currentTarget.value.toLowerCase().replace(/\s+/g, '-'))}
						/>

						<label class="block text-xs font-display italic text-stone-500 px-1 pt-2">
							{t('channel-modal-type')}
						</label>
						<Select
							options={channelTypeOptions()}
							value={channelType()}
							onChange={setChannelType}
							leftIcon={
								<i
									class={`fa-solid ${
										channelType() === 'VOICE' ? 'fa-volume-high' : 'fa-hashtag'
									} text-stone-400 text-xs`}
								/>
							}
						/>

						<Show when={channelType() === 'TEXT'}>
							<label class="block text-xs font-display italic text-stone-500 px-1 pt-2">
								{t('channel-modal-slowmode')}{' '}
								<span class="text-stone-400">({t('channel-modal-slowmode-hint')})</span>
							</label>
							<Select
								options={rateLimitOptions()}
								value={rateLimit()}
								onChange={setRateLimit}
								leftIcon={<i class="fa-solid fa-stopwatch text-stone-400 text-xs" />}
							/>
						</Show>

						<Show when={error()}>
							<div class="text-sm text-red-600 dark:text-red-400 pt-1">{error()}</div>
						</Show>

						<div class="flex gap-2 pt-3">
							<Button variant="secondary" fullWidth onClick={props.onClose}>
								{t('channel-modal-cancel')}
							</Button>
							<Button type="submit" fullWidth loading={submitting()} disabled={!name().trim()}>
								{t('channel-modal-create')}
							</Button>
						</div>
					</form>
				</div>
			</div>
		</>
	);
}
