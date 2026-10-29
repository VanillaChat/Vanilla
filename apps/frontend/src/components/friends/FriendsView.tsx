import { useNavigate } from '@tanstack/solid-router';
import { createSignal, For, type JSX, Show } from 'solid-js';
import { errorText } from '../../api/error-text';
import { useLayout } from '../../contexts/layout';
import { t } from '../../i18n';
import { DM_SCOPE, openDm } from '../../state/dms';
import {
	acceptFriend,
	incomingRequests,
	parseFriendTag,
	type Relationship,
	relationshipsOf,
	removeFriend,
	sendFriendRequest,
	unblockUser,
} from '../../state/friends';
import { userPresence } from '../../state/gateway-data';
import { openGroupModal } from '../../state/group-modal';
import { Avatar, statusLabels } from '../Avatar';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

type Tab = 'all' | 'pending' | 'blocked' | 'add';

const TABS: { id: Tab; labelKey: string }[] = [
	{ id: 'all', labelKey: 'friends-tab-all' },
	{ id: 'pending', labelKey: 'friends-tab-pending' },
	{ id: 'blocked', labelKey: 'friends-tab-blocked' },
];

function IconButton(props: {
	icon: string;
	label: string;
	onClick: () => void;
	tone?: 'accept' | 'danger';
}) {
	return (
		<button
			type="button"
			title={props.label}
			aria-label={props.label}
			onClick={props.onClick}
			class="w-9 h-9 rounded-full flex items-center justify-center bg-stone-100 dark:bg-stone-800 text-stone-500 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
			classList={{
				'hover:bg-[#f7e26c]': props.tone === 'accept',
				'hover:!text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40': props.tone === 'danger',
				'hover:bg-stone-200 dark:hover:bg-stone-700': !props.tone,
			}}
		>
			<i class={`fa-solid ${props.icon} text-sm`} />
		</button>
	);
}

function Row(props: { rel: Relationship; subtitle: string; children: JSX.Element }) {
	return (
		<div class="flex items-center gap-3 px-3 py-2.5 rounded-2xl hover:bg-stone-50 dark:hover:bg-stone-800/40">
			<Avatar
				user={props.rel.user}
				size={40}
				status={
					props.rel.kind === 'FRIEND'
						? (userPresence(props.rel.user.id) ?? 'UNAVAILABLE')
						: undefined
				}
			/>
			<div class="flex-1 min-w-0">
				<div class="truncate">
					<span class="font-display text-lg">{props.rel.user.username}</span>
					<span class="font-display text-sm text-stone-400">/{props.rel.user.tag}</span>
				</div>
				<div class="text-xs font-display italic text-stone-500 truncate">{props.subtitle}</div>
			</div>
			<div class="flex gap-2 shrink-0">{props.children}</div>
		</div>
	);
}

function Empty(props: { icon: string; text: string }) {
	return (
		<div class="flex-1 flex flex-col items-center justify-center text-center px-8 py-16">
			<i class={`fa-solid ${props.icon} text-3xl text-stone-300 dark:text-stone-600 mb-4`} />
			<p class="text-sm text-stone-500 italic font-display">{props.text}</p>
		</div>
	);
}

export function FriendsView() {
	const layout = useLayout();
	const navigate = useNavigate();
	const [tab, setTab] = createSignal<Tab>('all');
	const [notice, setNotice] = createSignal<string | null>(null);
	const [removing, setRemoving] = createSignal<Relationship | null>(null);
	const [handle, setHandle] = createSignal('');
	const [sending, setSending] = createSignal(false);
	const [sent, setSent] = createSignal<string | null>(null);

	const pickTab = (next: Tab) => {
		setTab(next);
		setNotice(null);
		setSent(null);
	};

	const run = async (action: () => Promise<unknown>) => {
		setNotice(null);
		try {
			await action();
		} catch (e) {
			setNotice(errorText(e, 'dialog-failed'));
		}
	};

	const message = (userId: string) =>
		run(async () => {
			const dm = await openDm(userId);
			navigate({
				to: '/app/$serverId/$channelId',
				params: { serverId: DM_SCOPE, channelId: dm.id },
			});
		});

	const submit = async (e: SubmitEvent) => {
		e.preventDefault();
		const target = parseFriendTag(handle());
		setSent(null);
		if (!target) {
			setNotice(t('friends-add-invalid'));
			return;
		}
		setNotice(null);
		setSending(true);
		try {
			const rel = await sendFriendRequest(target);
			setHandle('');
			setSent(
				t(rel.kind === 'FRIEND' ? 'friends-add-now-friends' : 'friends-add-sent', {
					name: rel.user.username,
				}),
			);
		} catch (err) {
			setNotice(errorText(err, 'dialog-failed'));
		} finally {
			setSending(false);
		}
	};

	const friends = () => relationshipsOf('FRIEND');
	const outgoing = () => relationshipsOf('OUTGOING');
	const blocked = () => relationshipsOf('BLOCKED');

	return (
		<main
			class="flex-1 min-w-0 flex flex-col bg-white dark:bg-[#211e1b] lg:my-3 lg:mx-3 lg:rounded-3xl lg:shadow-[0_2px_10px_rgba(0,0,0,0.04)] overflow-hidden"
			style={layout.contentStyle()}
		>
			<header class="px-5 sm:px-8 pt-6 pb-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-stone-100 dark:border-stone-800">
				<h2 class="font-display text-3xl mr-auto">{t('friends-title')}</h2>
				<Button variant="secondary" size="sm" onClick={() => openGroupModal({ mode: 'create' })}>
					{t('dms-new-group')}
				</Button>
				<nav class="w-full flex gap-1 overflow-x-auto">
					<For each={TABS}>
						{(item) => (
							<button
								type="button"
								onClick={() => pickTab(item.id)}
								class={`shrink-0 flex items-center gap-2 px-3.5 py-1.5 rounded-xl text-sm ${
									tab() === item.id
										? 'bg-[#f7e26c] text-stone-900 font-medium'
										: 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800/40'
								}`}
							>
								{t(item.labelKey)}
								<Show when={item.id === 'pending' && incomingRequests().length > 0}>
									<span class="min-w-5 h-5 px-1 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold flex items-center justify-center">
										{incomingRequests().length}
									</span>
								</Show>
							</button>
						)}
					</For>
					<Button
						size="sm"
						class="shrink-0"
						variant={tab() === 'add' ? 'secondary' : 'primary'}
						onClick={() => pickTab('add')}
					>
						<i class="fa-solid fa-user-plus mr-2 text-xs" />
						{t('friends-tab-add')}
					</Button>
				</nav>
			</header>

			<Show when={notice()}>
				<p class="mx-5 sm:mx-8 mt-4 px-4 py-2.5 rounded-xl text-sm bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">
					{notice()}
				</p>
			</Show>

			<div class="flex-1 min-h-0 overflow-y-auto px-2 sm:px-5 py-3 flex flex-col">
				<Show when={tab() === 'all'}>
					<Show
						when={friends().length > 0}
						fallback={<Empty icon="fa-user-group" text={t('friends-empty')} />}
					>
						<For each={friends()}>
							{(rel) => (
								<Row rel={rel} subtitle={statusLabels[userPresence(rel.user.id) ?? 'UNAVAILABLE']}>
									<IconButton
										icon="fa-paper-plane"
										label={t('profile-message')}
										onClick={() => message(rel.user.id)}
									/>
									<IconButton
										icon="fa-user-minus"
										label={t('friends-remove')}
										tone="danger"
										onClick={() => setRemoving(rel)}
									/>
								</Row>
							)}
						</For>
					</Show>
				</Show>

				<Show when={tab() === 'pending'}>
					<Show
						when={incomingRequests().length + outgoing().length > 0}
						fallback={<Empty icon="fa-envelope-open" text={t('friends-pending-empty')} />}
					>
						<For each={incomingRequests()}>
							{(rel) => (
								<Row rel={rel} subtitle={t('friends-incoming')}>
									<IconButton
										icon="fa-check"
										label={t('friends-accept')}
										tone="accept"
										onClick={() => run(() => acceptFriend(rel.user.id))}
									/>
									<IconButton
										icon="fa-xmark"
										label={t('friends-decline')}
										tone="danger"
										onClick={() => run(() => removeFriend(rel.user.id))}
									/>
								</Row>
							)}
						</For>
						<For each={outgoing()}>
							{(rel) => (
								<Row rel={rel} subtitle={t('friends-outgoing')}>
									<IconButton
										icon="fa-xmark"
										label={t('friends-cancel')}
										tone="danger"
										onClick={() => run(() => removeFriend(rel.user.id))}
									/>
								</Row>
							)}
						</For>
					</Show>
				</Show>

				<Show when={tab() === 'blocked'}>
					<Show
						when={blocked().length > 0}
						fallback={<Empty icon="fa-ban" text={t('friends-blocked-empty')} />}
					>
						<For each={blocked()}>
							{(rel) => (
								<Row rel={rel} subtitle={t('friends-blocked-label')}>
									<IconButton
										icon="fa-lock-open"
										label={t('friends-unblock')}
										onClick={() => run(() => unblockUser(rel.user.id))}
									/>
								</Row>
							)}
						</For>
					</Show>
				</Show>

				<Show when={tab() === 'add'}>
					<form onSubmit={submit} class="max-w-lg w-full mx-auto px-3 py-6">
						<h3 class="font-display text-2xl mb-1">{t('friends-add-title')}</h3>
						<p class="text-sm text-stone-500 italic font-display mb-4">{t('friends-add-sub')}</p>
						<div class="flex gap-2">
							<div class="flex-1 min-w-0">
								<Input
									value={handle()}
									onInput={(e) => setHandle(e.currentTarget.value)}
									placeholder={t('friends-add-placeholder')}
									autocomplete="off"
									spellcheck={false}
								/>
							</div>
							<Button type="submit" disabled={sending() || !handle().trim()}>
								{t('friends-add-send')}
							</Button>
						</div>
						<Show when={sent()}>
							<p class="mt-3 text-sm text-green-700 dark:text-green-400">{sent()}</p>
						</Show>
					</form>
				</Show>
			</div>

			<Show when={removing()}>
				{(rel) => (
					<ConfirmDialog
						title={t('friends-remove-title', { name: rel().user.username })}
						description={t('friends-remove-sub')}
						confirmLabel={t('friends-remove-confirm')}
						busyLabel={t('friends-remove-confirming')}
						onClose={() => setRemoving(null)}
						onConfirm={() => removeFriend(rel().user.id)}
					/>
				)}
			</Show>
		</main>
	);
}
