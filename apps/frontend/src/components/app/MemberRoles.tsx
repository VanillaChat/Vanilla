import { createMemo, createSignal, For, Show } from 'solid-js';
import { errorText } from '../../api/error-text';
import { giveRole, kickMember, takeRole } from '../../api/roles';
import { t } from '../../i18n';
import { currentUser, useGuild } from '../../state/gateway-data';
import {
	hasPerm,
	memberRoles,
	myStanding,
	Perm,
	roleCss,
	standingIn,
} from '../../state/permissions';

export function MemberRoles(props: { guildId: string; userId: string; onRemoved: () => void }) {
	const guild = useGuild(() => props.guildId);
	const me = () => myStanding(props.guildId);
	const isMember = () => !!guild()?.members.some((m) => m.userId === props.userId);
	const held = createMemo(() => memberRoles(guild(), props.userId));
	const target = () => standingIn(guild(), props.userId);

	const [picking, setPicking] = createSignal(false);
	const [confirmKick, setConfirmKick] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const manageRoles = () => hasPerm(me().permissions, Perm.MANAGE_ROLES);
	const assignable = (r: { id: string; position: number; permissions: number }) =>
		manageRoles() &&
		r.id !== props.guildId &&
		(me().isOwner || (me().rank > r.position && (r.permissions & ~me().permissions) === 0));
	const removable = (r: { id: string; position: number }) =>
		manageRoles() && r.id !== props.guildId && (me().isOwner || me().rank > r.position);
	const addable = createMemo(() =>
		(guild()?.roles ?? [])
			.filter((r) => assignable(r) && !held().some((h) => h.id === r.id))
			.sort((a, b) => b.position - a.position),
	);

	const canKick = () =>
		hasPerm(me().permissions, Perm.KICK_MEMBERS) &&
		props.userId !== currentUser()?.id &&
		!target().isOwner &&
		(me().isOwner || me().rank > target().rank);

	const attempt = async (action: () => Promise<unknown>) => {
		setError(null);
		try {
			await action();
		} catch (e) {
			setError(errorText(e, 'roles-errors-failed'));
		}
	};

	return (
		<Show when={isMember() && (held().length > 0 || manageRoles() || canKick())}>
			<div class="mt-4 pt-4 border-t border-stone-100 dark:border-stone-800">
				<div class="text-[0.7rem] uppercase tracking-wider text-stone-400 font-medium mb-2">
					{t('profile-roles')}
				</div>
				<div class="flex flex-wrap gap-1.5">
					<For each={held()}>
						{(role) => (
							<span class="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full text-xs bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700">
								<span
									class="w-2.5 h-2.5 rounded-full shrink-0"
									style={{ 'background-color': roleCss(role.color) || '#a8a29e' }}
								/>
								<span class="max-w-[8rem] truncate">{role.name}</span>
								<Show when={removable(role)}>
									<button
										type="button"
										aria-label={role.name}
										onClick={() => attempt(() => takeRole(props.guildId, props.userId, role.id))}
										class="w-4 h-4 rounded-full flex items-center justify-center text-[0.55rem] text-stone-400 hover:bg-black/10 dark:hover:bg-white/10 hover:text-stone-800 dark:hover:text-stone-100"
									>
										<i class="fa-solid fa-xmark" />
									</button>
								</Show>
							</span>
						)}
					</For>
					<Show when={held().length === 0 && !manageRoles()}>
						<span class="text-xs text-stone-400 italic">{t('profile-no-roles')}</span>
					</Show>
					<Show when={addable().length > 0}>
						<div class="relative">
							<button
								type="button"
								aria-label={t('profile-add-role')}
								title={t('profile-add-role')}
								onClick={() => setPicking(!picking())}
								class="w-6 h-6 rounded-full flex items-center justify-center text-[0.6rem] border border-dashed border-stone-300 dark:border-stone-600 text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 hover:border-stone-500"
							>
								<i class="fa-solid fa-plus" />
							</button>
							<Show when={picking()}>
								<ul class="absolute left-0 top-full mt-1 z-10 min-w-40 max-h-48 overflow-y-auto rounded-xl border border-stone-200 dark:border-stone-700 bg-white dark:bg-[#2a2622] shadow-lg p-1">
									<For each={addable()}>
										{(role) => (
											<li>
												<button
													type="button"
													onClick={() => {
														setPicking(false);
														attempt(() => giveRole(props.guildId, props.userId, role.id));
													}}
													class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left hover:bg-stone-100 dark:hover:bg-stone-800"
												>
													<span
														class="w-2.5 h-2.5 rounded-full shrink-0"
														style={{ 'background-color': roleCss(role.color) || '#a8a29e' }}
													/>
													<span class="truncate">{role.name}</span>
												</button>
											</li>
										)}
									</For>
								</ul>
							</Show>
						</div>
					</Show>
				</div>

				<Show when={canKick()}>
					<button
						type="button"
						onClick={() => {
							if (!confirmKick()) {
								setConfirmKick(true);
								return;
							}
							attempt(async () => {
								await kickMember(props.guildId, props.userId);
								props.onRemoved();
							});
						}}
						onBlur={() => setConfirmKick(false)}
						class="mt-3 w-full px-3 py-2 rounded-xl text-xs font-medium border transition-colors"
						classList={{
							'border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30':
								!confirmKick(),
							'bg-red-600 border-red-600 text-white hover:bg-red-700': confirmKick(),
						}}
					>
						<i class="fa-solid fa-user-xmark mr-2" />
						{confirmKick() ? t('profile-remove-member-confirm') : t('profile-remove-member')}
					</button>
				</Show>
				<Show when={error()}>
					<p class="mt-2 text-xs text-red-600">{error()}</p>
				</Show>
			</div>
		</Show>
	);
}
