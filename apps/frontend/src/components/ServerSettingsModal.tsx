import { createMemo, createSignal, For, Show } from 'solid-js';
import {
	deleteEmoji,
	emojiSrc,
	MAX_EMOJI_BYTES,
	MAX_EMOJIS_PER_SERVER,
	renameEmoji,
	uploadEmoji,
} from '../api/emoji';
import { errorText } from '../api/error-text';
import { updateGuildDetails } from '../api/gateway';
import { deleteServer, updateServer } from '../api/servers';
import { t } from '../i18n';
import { useGuild } from '../state/gateway-data';
import { can, myStanding, Perm } from '../state/permissions';
import { AuditLogPanel } from './AuditLogPanel';
import { ConfirmDialog } from './ConfirmDialog';
import { RolesPanel } from './RolesPanel';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';

type Tab = 'overview' | 'roles' | 'emoji' | 'audit';

const nameFromFile = (file: string) =>
	file
		.replace(/\.[^.]+$/, '')
		.replace(/[^A-Za-z0-9_]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 32);

function Overview(props: { guildId: string; onClose: () => void }) {
	const guild = useGuild(() => props.guildId);
	const [name, setName] = createSignal(guild()?.name ?? '');
	const [brief, setBrief] = createSignal(guild()?.brief ?? '');
	const [saving, setSaving] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [confirmDelete, setConfirmDelete] = createSignal(false);

	const dirty = () => name().trim() !== guild()?.name || brief().trim() !== (guild()?.brief ?? '');

	const save = async (e: Event) => {
		e.preventDefault();
		if (!dirty()) return;
		setSaving(true);
		setError(null);
		try {
			const updated = await updateServer(props.guildId, {
				name: name().trim(),
				brief: brief().trim() || null,
			});
			updateGuildDetails(updated);
			props.onClose();
		} catch (err) {
			setError(errorText(err, 'server-settings-failed'));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form onSubmit={save} class="p-8 space-y-4">
			<div class="block text-sm font-display italic text-stone-500 px-1">
				{t('server-settings-name')}
				<div class="mt-1 not-italic">
					<Input
						aria-label={t('server-settings-name')}
						type="text"
						required
						minLength={2}
						maxLength={64}
						value={name()}
						onInput={(e) => setName(e.currentTarget.value)}
					/>
				</div>
			</div>
			<div class="block text-sm font-display italic text-stone-500 px-1 pt-1">
				{t('server-settings-brief')}
				<div class="mt-1 not-italic">
					<Input
						aria-label={t('server-settings-brief')}
						type="text"
						maxLength={36}
						value={brief()}
						placeholder={t('server-settings-brief-placeholder')}
						onInput={(e) => setBrief(e.currentTarget.value)}
					/>
				</div>
			</div>
			<Show when={error()}>
				<div class="text-sm text-red-600 dark:text-red-400">{error()}</div>
			</Show>
			<div class="flex gap-2 pt-2">
				<Button variant="secondary" fullWidth onClick={props.onClose}>
					{t('channel-modal-cancel')}
				</Button>
				<Button type="submit" fullWidth loading={saving()} disabled={!dirty() || !name().trim()}>
					{t('settings-save-changes')}
				</Button>
			</div>

			<Show when={myStanding(props.guildId).isOwner}>
				<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
					<div class="text-[0.7rem] uppercase tracking-wider text-red-500/80 font-medium mb-2">
						{t('settings-danger')}
					</div>
					<Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
						<i class="fa-solid fa-trash mr-2" />
						{t('server-settings-delete')}
					</Button>
				</div>
			</Show>

			<Show when={confirmDelete()}>
				<ConfirmDialog
					title={t('server-delete-title', { name: guild()?.name ?? '' })}
					description={t('server-delete-sub')}
					confirmLabel={t('server-delete-confirm')}
					busyLabel={t('server-delete-confirming')}
					errorText={t('server-delete-failed')}
					onClose={() => setConfirmDelete(false)}
					onConfirm={async () => {
						await deleteServer(props.guildId);
						props.onClose();
					}}
				/>
			</Show>
		</form>
	);
}

function EmojiRow(props: { guildId: string; emoji: { id: string; name: string; url: string } }) {
	const [name, setName] = createSignal(props.emoji.name);
	const [error, setError] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);

	const rename = async () => {
		const next = name().trim();
		if (next === props.emoji.name) return;
		setBusy(true);
		setError(null);
		try {
			await renameEmoji(props.guildId, props.emoji.id, next);
		} catch (e) {
			setName(props.emoji.name);
			setError(errorText(e, 'emoji-errors-failed'));
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		setBusy(true);
		try {
			await deleteEmoji(props.guildId, props.emoji.id);
		} catch (e) {
			setError(errorText(e, 'emoji-errors-failed'));
			setBusy(false);
		}
	};

	return (
		<li class="py-3">
			<div class="flex items-center gap-3">
				<img src={emojiSrc(props.emoji)} alt="" class="w-10 h-10 object-contain shrink-0" />
				<div class="flex-1 min-w-0 flex items-center rounded-lg bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-800 px-3 text-base focus-within:border-stone-400">
					<span class="text-stone-400">:</span>
					<input
						value={name()}
						maxLength={32}
						disabled={busy()}
						aria-label={t('emoji-name')}
						onInput={(e) => setName(e.currentTarget.value)}
						onBlur={rename}
						onKeyDown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
						class="flex-1 min-w-0 bg-transparent outline-none py-1.5"
					/>
					<span class="text-stone-400">:</span>
				</div>
				<button
					type="button"
					disabled={busy()}
					onClick={remove}
					title={t('emoji-delete')}
					aria-label={t('emoji-delete')}
					class="w-8 h-8 rounded-lg text-stone-400 hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 flex items-center justify-center shrink-0 disabled:opacity-50"
				>
					<i class="fa-solid fa-trash text-xs" />
				</button>
			</div>
			<Show when={error()}>
				<div class="text-xs text-red-600 dark:text-red-400 pl-11 pt-1">{error()}</div>
			</Show>
		</li>
	);
}

function Emojis(props: { guildId: string }) {
	const guild = useGuild(() => props.guildId);
	const emojis = () => guild()?.emojis ?? [];
	const [uploading, setUploading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	let picker: HTMLInputElement | undefined;

	const upload = async (files: File[]) => {
		setError(null);
		setUploading(true);
		try {
			for (const file of files) {
				if (file.size > MAX_EMOJI_BYTES) {
					setError(t('emoji-errors-tooLarge'));
					continue;
				}
				// The gateway event adds it to the list; here we only surface a failure.
				await uploadEmoji(props.guildId, nameFromFile(file.name) || 'emoji', file);
			}
		} catch (e) {
			setError(errorText(e, 'emoji-errors-failed'));
		} finally {
			setUploading(false);
		}
	};

	return (
		<div class="p-8">
			<div class="flex items-center gap-3 mb-4">
				<p class="flex-1 text-base text-stone-500 font-display italic">{t('emoji-settings-sub')}</p>
				<span class="text-xs text-stone-400 tabular-nums shrink-0">
					{emojis().length}/{MAX_EMOJIS_PER_SERVER}
				</span>
			</div>
			<input
				ref={picker}
				type="file"
				multiple
				accept="image/png,image/jpeg,image/gif,image/webp"
				class="hidden"
				onChange={(e) => {
					upload(Array.from(e.currentTarget.files ?? []));
					e.currentTarget.value = '';
				}}
			/>
			<Button
				size="sm"
				loading={uploading()}
				disabled={emojis().length >= MAX_EMOJIS_PER_SERVER}
				onClick={() => picker?.click()}
			>
				<i class="fa-solid fa-plus mr-2" />
				{t('emoji-upload')}
			</Button>
			<Show when={error()}>
				<div class="text-sm text-red-600 dark:text-red-400 pt-2">{error()}</div>
			</Show>
			<ul class="mt-3 divide-y divide-stone-100 dark:divide-stone-800">
				<For each={emojis()}>{(e) => <EmojiRow guildId={props.guildId} emoji={e} />}</For>
			</ul>
			<Show when={emojis().length === 0}>
				<p class="text-sm text-stone-400 italic font-display py-4 text-center">
					{t('emoji-settings-empty')}
				</p>
			</Show>
		</div>
	);
}

export function ServerSettingsModal(props: {
	guildId: string;
	closing?: boolean;
	onClose: () => void;
}) {
	const guild = useGuild(() => props.guildId);
	const tabs = createMemo<Array<{ id: Tab; label: string; icon: string }>>(() => {
		const all: Array<{ id: Tab; label: string; icon: string; allowed: boolean }> = [
			{
				id: 'overview',
				label: t('server-settings-overview'),
				icon: 'fa-solid fa-sliders',
				allowed: can(props.guildId, Perm.MANAGE_GUILD),
			},
			{
				id: 'roles',
				label: t('server-settings-roles'),
				icon: 'fa-solid fa-user-shield',
				allowed: can(props.guildId, Perm.MANAGE_ROLES),
			},
			{
				id: 'emoji',
				label: t('server-settings-emoji'),
				icon: 'fa-regular fa-face-smile',
				allowed: can(props.guildId, Perm.MANAGE_EMOJIS),
			},
			{
				id: 'audit',
				label: t('server-settings-audit'),
				icon: 'fa-solid fa-clock-rotate-left',
				allowed: can(props.guildId, Perm.VIEW_AUDIT_LOG),
			},
		];
		return all.filter((tab) => tab.allowed);
	});
	const [picked, setPicked] = createSignal<Tab | null>(null);
	const tab = (): Tab | undefined => {
		const id = picked();
		return tabs().find((x) => x.id === id)?.id ?? tabs()[0]?.id;
	};
	const setTab = setPicked;

	return (
		<Show when={guild()}>
			<Modal
				title={t('server-settings-title')}
				subtitle={guild()?.name}
				closing={props.closing}
				wide
				fixedHeight
				onClose={props.onClose}
			>
				<div class="flex gap-1 px-8 pt-4 border-b border-stone-100 dark:border-stone-800">
					<For each={tabs()}>
						{(item) => (
							<button
								type="button"
								onClick={() => setTab(item.id)}
								class="px-4 py-2.5 text-base rounded-t-lg flex items-center gap-2.5 transition-colors"
								classList={{
									'text-stone-900 dark:text-stone-100 border-b-2 border-[#f7e26c] font-medium':
										tab() === item.id,
									'text-stone-500 hover:text-stone-800 dark:hover:text-stone-200':
										tab() !== item.id,
								}}
							>
								<i class={`${item.icon} text-sm`} />
								{item.label}
							</button>
						)}
					</For>
				</div>
				<Show when={tab() === 'overview'}>
					<Overview guildId={props.guildId} onClose={props.onClose} />
				</Show>
				<Show when={tab() === 'roles'}>
					<RolesPanel guildId={props.guildId} />
				</Show>
				<Show when={tab() === 'emoji'}>
					<Emojis guildId={props.guildId} />
				</Show>
				<Show when={tab() === 'audit'}>
					<AuditLogPanel guildId={props.guildId} />
				</Show>
			</Modal>
		</Show>
	);
}
