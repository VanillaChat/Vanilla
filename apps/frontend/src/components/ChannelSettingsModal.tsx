import { createMemo, createSignal, Show } from 'solid-js';
import { deleteChannel, updateChannel } from '../api/channels';
import { errorText } from '../api/error-text';
import { updateGuildChannel } from '../api/gateway';
import { t } from '../i18n';
import { findChannel } from '../state/gateway-data';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Select, type SelectOption } from './ui/Select';

const SLOWMODE: { value: number; key: string }[] = [
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

export function ChannelSettingsModal(props: {
	channelId: string;
	closing?: boolean;
	onClose: () => void;
}) {
	const channel = () => findChannel(props.channelId);
	const isVoice = () => (channel()?.type ?? 'TEXT').toUpperCase() === 'VOICE';

	const [name, setName] = createSignal(channel()?.name ?? '');
	const [slowmode, setSlowmode] = createSignal(channel()?.rateLimitPerUser ?? 0);
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [confirmDelete, setConfirmDelete] = createSignal(false);

	const options = createMemo<SelectOption<number>[]>(() =>
		SLOWMODE.map(({ value, key }) => ({ value, label: t(key) })),
	);
	const dirty = () =>
		name().trim() !== channel()?.name ||
		(!isVoice() && slowmode() !== (channel()?.rateLimitPerUser ?? 0));

	const save = async (e: Event) => {
		e.preventDefault();
		if (!dirty() || !name().trim()) return;
		setSaving(true);
		setError(null);
		try {
			const updated = await updateChannel(props.channelId, {
				name: name().trim(),
				rateLimitPerUser: isVoice() ? undefined : slowmode(),
			});
			updateGuildChannel(updated);
			props.onClose();
		} catch (err) {
			setError(errorText(err, 'channel-settings-failed'));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Show when={channel()}>
			<Modal
				title={t('channel-settings-title')}
				subtitle={`#${channel()?.name}`}
				closing={props.closing}
				onClose={props.onClose}
			>
				<form onSubmit={save} class="p-6 space-y-3">
					<div class="block text-xs font-display italic text-stone-500 px-1">
						{t('channel-modal-name')}
						<div class="mt-1 not-italic">
							<Input
								aria-label={t('channel-modal-name')}
								type="text"
								required
								maxLength={100}
								value={name()}
								leftIcon={<i class="fa-solid fa-hashtag" />}
								onInput={(e) => setName(e.currentTarget.value.toLowerCase().replace(/\s+/g, '-'))}
							/>
						</div>
					</div>

					<Show when={!isVoice()}>
						<div class="block text-xs font-display italic text-stone-500 px-1 pt-2">
							{t('channel-modal-slowmode')}
						</div>
						<Select
							options={options()}
							value={slowmode()}
							onChange={setSlowmode}
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
						<Button
							type="submit"
							fullWidth
							loading={saving()}
							disabled={!dirty() || !name().trim()}
						>
							{t('settings-save-changes')}
						</Button>
					</div>

					<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
						<div class="text-[0.7rem] uppercase tracking-wider text-red-500/80 font-medium mb-2">
							{t('settings-danger')}
						</div>
						<Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
							<i class="fa-solid fa-trash mr-2" />
							{t('channel-settings-delete')}
						</Button>
					</div>
				</form>
			</Modal>
			<Show when={confirmDelete()}>
				<ConfirmDialog
					title={t('channel-delete-title', { name: channel()?.name ?? '' })}
					description={t('channel-delete-sub')}
					confirmLabel={t('channel-delete-confirm')}
					busyLabel={t('channel-delete-confirming')}
					errorText={t('channel-delete-failed')}
					onClose={() => setConfirmDelete(false)}
					onConfirm={async () => {
						await deleteChannel(props.channelId);
						props.onClose();
					}}
				/>
			</Show>
		</Show>
	);
}
