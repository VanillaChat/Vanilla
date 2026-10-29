import { createMemo, createSignal, For, Show } from 'solid-js';
import { errorText } from '../api/error-text';
import { createRole, deleteRole, reorderRoles, updateRole } from '../api/roles';
import { t } from '../i18n';
import { useGuild } from '../state/gateway-data';
import { myStanding, PERM_LIST, roleCss } from '../state/permissions';
import { ConfirmDialog } from './ConfirmDialog';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

const SWATCHES = [
	0xe74c3c, 0xe67e22, 0xf1c40f, 0x2ecc71, 0x1abc9c, 0x3498db, 0x9b59b6, 0xe91e63, 0x95a5a6,
];

function Toggle(props: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={props.on}
			disabled={props.disabled}
			onClick={() => props.onChange(!props.on)}
			class="relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
			classList={{
				'bg-[#f7e26c]': props.on,
				'bg-stone-300 dark:bg-stone-700': !props.on,
			}}
		>
			<span
				class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform"
				style={{ transform: props.on ? 'translateX(20px)' : 'translateX(0)' }}
			/>
		</button>
	);
}

function RoleDot(props: { color: number }) {
	return (
		<span
			class="w-3 h-3 rounded-full shrink-0 border border-black/10 dark:border-white/10"
			style={{ 'background-color': roleCss(props.color) || 'transparent' }}
		/>
	);
}

export function RolesPanel(props: { guildId: string }) {
	const guild = useGuild(() => props.guildId);
	const me = () => myStanding(props.guildId);
	const roles = createMemo(() =>
		[...(guild()?.roles ?? [])].sort((a, b) => b.position - a.position),
	);
	const [pickedId, setPickedId] = createSignal<string | null>(null);
	const selectedId = createMemo(() => {
		const id = pickedId();
		return roles().some((r) => r.id === id) ? id : (roles()[0]?.id ?? null);
	});
	const [error, setError] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);

	const run = async (action: () => Promise<unknown>) => {
		setError(null);
		setBusy(true);
		try {
			await action();
		} catch (e) {
			setError(errorText(e, 'roles-errors-failed'));
		} finally {
			setBusy(false);
		}
	};

	const add = () =>
		run(async () => {
			const role = await createRole(props.guildId, { name: t('roles-new-name') });
			setPickedId(role.id);
		});

	const customAscending = () =>
		roles()
			.filter((r) => r.id !== props.guildId)
			.reverse();

	const movable = (id: string) => {
		const role = roles().find((r) => r.id === id);
		return !!role && role.id !== props.guildId && (me().isOwner || me().rank > role.position);
	};

	const move = (id: string, by: 1 | -1) =>
		run(() => {
			const ids = customAscending().map((r) => r.id);
			const from = ids.indexOf(id);
			const to = from + by;
			if (from < 0 || to < 0 || to >= ids.length) return Promise.resolve();
			[ids[from], ids[to]] = [ids[to], ids[from]];
			return reorderRoles(props.guildId, ids);
		});

	return (
		<div class="p-8 flex flex-col sm:flex-row gap-8">
			<div class="sm:w-72 shrink-0">
				<Button size="sm" fullWidth loading={busy()} onClick={add}>
					<i class="fa-solid fa-plus mr-2" />
					{t('roles-new')}
				</Button>
				<ul class="mt-4 space-y-1">
					<For each={roles()}>
						{(role) => (
							<li
								class="flex items-center rounded-lg transition-colors"
								classList={{
									'bg-[#f7e26c]/25': selectedId() === role.id,
									'hover:bg-stone-100 dark:hover:bg-stone-800/50': selectedId() !== role.id,
								}}
							>
								<button
									type="button"
									onClick={() => setPickedId(role.id)}
									class="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 text-base text-left"
									classList={{ 'font-medium': selectedId() === role.id }}
								>
									<RoleDot color={role.color} />
									<span class="flex-1 truncate">{role.name}</span>
								</button>
								<Show when={selectedId() === role.id && movable(role.id)}>
									<span class="flex shrink-0 pr-1">
										<button
											type="button"
											aria-label={t('roles-move-up')}
											title={t('roles-move-up')}
											onClick={() => move(role.id, 1)}
											class="w-6 h-6 rounded-md flex items-center justify-center text-[0.65rem] text-stone-500 hover:bg-black/5 dark:hover:bg-white/10"
										>
											<i class="fa-solid fa-chevron-up" />
										</button>
										<button
											type="button"
											aria-label={t('roles-move-down')}
											title={t('roles-move-down')}
											onClick={() => move(role.id, -1)}
											class="w-6 h-6 rounded-md flex items-center justify-center text-[0.65rem] text-stone-500 hover:bg-black/5 dark:hover:bg-white/10"
										>
											<i class="fa-solid fa-chevron-down" />
										</button>
									</span>
								</Show>
							</li>
						)}
					</For>
				</ul>
			</div>

			<div class="flex-1 min-w-0">
				<Show when={selectedId()} keyed>
					{(id) => <RoleEditor guildId={props.guildId} roleId={id} onError={setError} />}
				</Show>
				<Show when={error()}>
					<div class="mt-3 text-sm text-red-600 dark:text-red-400">{error()}</div>
				</Show>
			</div>
		</div>
	);
}

function RoleEditor(props: {
	guildId: string;
	roleId: string;
	onError: (message: string | null) => void;
}) {
	const guild = useGuild(() => props.guildId);
	const me = () => myStanding(props.guildId);
	const role = () => guild()?.roles?.find((r) => r.id === props.roleId);
	const everyone = () => props.roleId === props.guildId;
	// Roles at or above your own rank are read-only; `@everyone` always takes permissions.
	const editable = () => {
		const r = role();
		return !!r && (me().isOwner || everyone() || me().rank > r.position);
	};
	const cosmetic = () => editable() && !everyone();

	const [name, setName] = createSignal(role()?.name ?? '');
	const [color, setColor] = createSignal(role()?.color ?? 0);
	const [hoist, setHoist] = createSignal(role()?.hoist ?? false);
	const [perms, setPerms] = createSignal(role()?.permissions ?? 0);
	const [saving, setSaving] = createSignal(false);
	const [confirmDelete, setConfirmDelete] = createSignal(false);

	const dirty = () =>
		name().trim() !== role()?.name ||
		color() !== role()?.color ||
		hoist() !== role()?.hoist ||
		perms() !== role()?.permissions;

	const canToggle = (bit: number) =>
		editable() && (me().isOwner || (perms() & bit) !== 0 || (me().permissions & bit) !== 0);

	const toggle = (bit: number, on: boolean) => setPerms((p) => (on ? p | bit : p & ~bit));

	const save = async (e: Event) => {
		e.preventDefault();
		setSaving(true);
		props.onError(null);
		try {
			await updateRole(props.guildId, props.roleId, {
				...(cosmetic() ? { name: name().trim(), color: color(), hoist: hoist() } : {}),
				permissions: perms(),
			});
		} catch (err) {
			props.onError(errorText(err, 'roles-errors-failed'));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Show when={role()}>
			<form onSubmit={save} class="space-y-6">
				<div>
					<div class="text-sm font-display italic text-stone-500 px-1 mb-1.5">
						{t('roles-name')}
					</div>
					<Input
						aria-label={t('roles-name')}
						type="text"
						maxLength={32}
						required
						disabled={!cosmetic()}
						value={name()}
						onInput={(e) => setName(e.currentTarget.value)}
					/>
				</div>

				<Show when={!everyone()}>
					<div>
						<div class="text-sm font-display italic text-stone-500 px-1 mb-1.5">
							{t('roles-color')}
						</div>
						<div class="flex flex-wrap items-center gap-2">
							<button
								type="button"
								disabled={!cosmetic()}
								onClick={() => setColor(0)}
								aria-label={t('roles-color-none')}
								title={t('roles-color-none')}
								class="w-7 h-7 rounded-full border border-stone-300 dark:border-stone-600 flex items-center justify-center text-stone-400 text-[0.65rem] disabled:opacity-50"
								classList={{ 'ring-2 ring-[#f7e26c]': color() === 0 }}
							>
								<i class="fa-solid fa-slash" />
							</button>
							<For each={SWATCHES}>
								{(c) => (
									<button
										type="button"
										disabled={!cosmetic()}
										onClick={() => setColor(c)}
										aria-label={roleCss(c)}
										class="w-8 h-8 rounded-full disabled:opacity-50"
										classList={{ 'ring-2 ring-offset-2 ring-[#f7e26c]': color() === c }}
										style={{ 'background-color': roleCss(c) }}
									/>
								)}
							</For>
							<label
								class="relative w-7 h-7 rounded-full overflow-hidden border border-stone-300 dark:border-stone-600 cursor-pointer"
								classList={{ 'opacity-50 pointer-events-none': !cosmetic() }}
								title={t('roles-color-custom')}
							>
								<input
									type="color"
									disabled={!cosmetic()}
									value={roleCss(color()) || '#99aab5'}
									onInput={(e) => setColor(Number.parseInt(e.currentTarget.value.slice(1), 16))}
									class="absolute -inset-2 w-12 h-12 cursor-pointer"
								/>
							</label>
						</div>
					</div>
				</Show>

				<Show when={!everyone()}>
					<div class="flex items-center gap-4">
						<div class="flex-1 min-w-0">
							<div class="text-base font-medium">{t('roles-hoist')}</div>
							<div class="text-sm text-stone-500">{t('roles-hoist-hint')}</div>
						</div>
						<Toggle on={hoist()} disabled={!cosmetic()} onChange={setHoist} />
					</div>
				</Show>

				<div>
					<div class="text-sm font-display italic text-stone-500 px-1 mb-1.5">
						{t('roles-permissions')}
					</div>
					<ul class="divide-y divide-stone-100 dark:divide-stone-800">
						<For each={PERM_LIST}>
							{(p) => (
								<li class="flex items-center gap-4 py-3.5">
									<div class="flex-1 min-w-0">
										<div class="text-base font-medium">{t(`perm-${p.key}`)}</div>
										<div class="text-sm text-stone-500">{t(`perm-${p.key}-hint`)}</div>
									</div>
									<Toggle
										on={(perms() & p.bit) !== 0}
										disabled={!canToggle(p.bit)}
										onChange={(on) => toggle(p.bit, on)}
									/>
								</li>
							)}
						</For>
					</ul>
				</div>

				<Show when={!editable()}>
					<p class="text-xs text-stone-500 italic font-display">{t('roles-read-only')}</p>
				</Show>

				<div class="flex gap-2 pt-1">
					<Show when={editable() && !everyone()}>
						<Button variant="danger" onClick={() => setConfirmDelete(true)}>
							<i class="fa-solid fa-trash" />
						</Button>
					</Show>
					<Button
						type="submit"
						fullWidth
						loading={saving()}
						disabled={!editable() || !dirty() || (cosmetic() && !name().trim())}
					>
						{t('settings-save-changes')}
					</Button>
				</div>
			</form>

			<Show when={confirmDelete()}>
				<ConfirmDialog
					title={t('roles-delete-title', { name: role()?.name ?? '' })}
					description={t('roles-delete-sub')}
					confirmLabel={t('roles-delete-confirm')}
					busyLabel={t('roles-delete-confirming')}
					errorText={t('roles-errors-failed')}
					onClose={() => setConfirmDelete(false)}
					onConfirm={async () => {
						await deleteRole(props.guildId, props.roleId);
						setConfirmDelete(false);
					}}
				/>
			</Show>
		</Show>
	);
}
