import { useNavigate } from '@tanstack/solid-router';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { ApiError } from '../api/client';
import { ready } from '../api/gateway';
import { t } from '../i18n';
import { addToGroup, createGroup, DM_SCOPE, getDm } from '../state/dms';
import { currentUser, getUser, userPresence } from '../state/gateway-data';
import type { GroupModal as GroupModalState } from '../state/group-modal';
import { Avatar } from './Avatar';
import { Button } from './ui/Button';
import { Checkbox } from './ui/Checkbox';
import { Input } from './ui/Input';

const ANIM_MS = 130;

export function GroupModal(props: { modal: GroupModalState; onClose: () => void }) {
	const navigate = useNavigate();
	const [name, setName] = createSignal('');
	const [picked, setPicked] = createSignal<string[]>([]);
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	const [closing, setClosing] = createSignal(false);

	const adding = () => props.modal.mode === 'add';
	const channelId = () => (props.modal.mode === 'add' ? props.modal.channelId : undefined);

	// Only people you share a server with can be added; the server enforces the same.
	const candidates = createMemo(() => {
		const me = currentUser()?.id;
		const inGroup = new Set(getDm(channelId())?.members.map((m) => m.id) ?? []);
		return Object.values(ready()?.users ?? {})
			.filter((u) => u.id !== me && !inGroup.has(u.id) && !u.bot)
			.sort((a, b) => a.username.localeCompare(b.username));
	});

	const close = () => {
		if (closing()) return;
		setClosing(true);
		setTimeout(props.onClose, ANIM_MS);
	};

	const toggle = (id: string, on: boolean) =>
		setPicked(on ? [...picked(), id] : picked().filter((x) => x !== id));

	const minimum = () => (adding() ? 1 : 2);

	const submit = async (e: Event) => {
		e.preventDefault();
		if (picked().length < minimum()) return;
		setError(null);
		setSubmitting(true);
		try {
			const id = channelId();
			const dm = id ? await addToGroup(id, picked()) : await createGroup(picked(), name());
			close();
			navigate({
				to: '/app/$serverId/$channelId',
				params: { serverId: DM_SCOPE, channelId: dm.id },
				viewTransition: false,
			});
		} catch (err) {
			setError(err instanceof ApiError || err instanceof Error ? err.message : t('group-failed'));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<>
			<div
				class={`fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-sm ${
					closing() ? 'animate-fade-out' : 'animate-fade-in'
				}`}
				onClick={close}
			/>
			<div class="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
				<div
					class={`pointer-events-auto w-full max-w-md rounded-3xl bg-white dark:bg-[#211e1b] shadow-2xl shadow-black/15 overflow-y-auto max-h-[calc(100dvh-2rem)] ${
						closing() ? 'animate-popover-out' : 'animate-popover-in'
					}`}
				>
					<div class="px-6 pt-6 pb-4 border-b border-stone-100 dark:border-stone-800">
						<h2 class="font-display text-3xl">
							{adding() ? t('group-modal-add-title') : t('group-modal-title')}
						</h2>
						<p class="text-sm text-stone-500 italic font-display mt-1">
							{adding() ? t('group-modal-pick-add') : t('group-modal-pick')}
						</p>
					</div>

					<form onSubmit={submit} class="p-6 space-y-3">
						<Show when={!adding()}>
							<Input
								type="text"
								placeholder={t('group-modal-name')}
								maxLength={100}
								value={name()}
								leftIcon={<i class="fa-solid fa-user-group" />}
								onInput={(e) => setName(e.currentTarget.value)}
							/>
						</Show>

						<div class="max-h-64 overflow-y-auto -mx-2 px-2 space-y-1">
							<For
								each={candidates()}
								fallback={
									<div class="py-6 text-center text-sm text-stone-400 italic font-display">
										{t('group-modal-none')}
									</div>
								}
							>
								{(u) => (
									<div class="flex items-center gap-3 px-2 py-1.5 rounded-xl hover:bg-stone-50 dark:hover:bg-stone-800/40">
										<Avatar user={u} status={userPresence(u.id) ?? 'UNAVAILABLE'} size={28} />
										<div class="flex-1 min-w-0">
											<Checkbox
												checked={picked().includes(u.id)}
												onChange={(on) => toggle(u.id, on)}
												label={getUser(u.id)?.username ?? u.username}
											/>
										</div>
									</div>
								)}
							</For>
						</div>

						<Show when={error()}>
							<div class="text-sm text-red-600 dark:text-red-400 pt-1">{error()}</div>
						</Show>

						<div class="flex gap-2 pt-3">
							<Button variant="secondary" fullWidth onClick={close}>
								{t('channel-modal-cancel')}
							</Button>
							<Button
								type="submit"
								fullWidth
								loading={submitting()}
								disabled={picked().length < minimum()}
							>
								{adding() ? t('group-modal-add') : t('group-modal-create')}
							</Button>
						</div>
					</form>
				</div>
			</div>
		</>
	);
}
