import { createMemo, onCleanup, Show } from 'solid-js';
import type { GatewayUser } from '../../api/gateway';
import type { Message } from '../../api/messages';
import { useProfile } from '../../contexts/profile';
import { t } from '../../i18n';
import { compactMode, currentUser, getUser, guilds, userPresence } from '../../state/gateway-data';
import { mentionsUser } from '../../state/mentions';
import { can, memberColor, Perm } from '../../state/permissions';
import { Avatar } from '../Avatar';
import { MessageAttachments } from '../message/MessageAttachments';
import { MessageBody } from '../message/MessageBody';
import { previewText } from './utils';

type Props = {
	m: Message;
	prev: () => Message | undefined;
	highlighted: () => boolean;
	editing: () => boolean;
	editDraft: () => string;
	setEditDraft: (v: string) => void;
	saveEdit: () => void;
	cancelEdit: () => void;
	onStartReply: (m: Message) => void;
	onStartEdit: (id: string, content: string) => void;
	onDelete: (id: string, preview: string) => void;
	onJumpToMessage: (id: string) => void;
	onContextMenu: (
		e: MouseEvent,
		messageId: string,
		content: string,
		mine: boolean,
		canDelete: boolean,
	) => void;
};

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

export function MessageItem(props: Props) {
	const profile = useProfile();
	const m = props.m;
	const author = m.author;
	const cachedUser = () => getUser(m.authorId);
	const displayName = () =>
		author?.member?.nickname ?? cachedUser()?.username ?? author?.username ?? '?';
	const pinged = () => !isMine() && mentionsUser(m.content, currentUser()?.username);
	const liveStatus = () => userPresence(m.authorId) ?? 'UNAVAILABLE';
	const avatarUser = () => ({
		id: m.authorId,
		username: cachedUser()?.username ?? author?.username ?? '?',
		avatar: cachedUser()?.avatar ?? author?.avatar ?? null,
	});
	const profileUser = (): GatewayUser =>
		cachedUser() ?? {
			id: m.authorId,
			username: author?.username ?? '?',
			tag: author?.tag ?? '',
			createdAt: new Date(0),
			bot: author?.bot ?? false,
			flags: author?.flags ?? 0,
			bio: null,
			avatar: author?.avatar ?? null,
			banner: null,
		};
	const fullTime = new Date(m.createdAt).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
	});
	const hasReply = () => !!m.referencedMessage || !!m.messageReference?.messageId;
	const isHead = createMemo(() => {
		const prev = props.prev();
		if (!prev) return true;
		if (hasReply()) return true;
		if (compactMode()) return false;
		if (prev.authorId !== m.authorId) return true;
		return Number(new Date(m.createdAt)) - Number(new Date(prev.createdAt)) > 5 * 60 * 1000;
	});
	const isMine = () => m.authorId === currentUser()?.id;
	const canDelete = () => isMine() || can(m.guildId, Perm.MANAGE_MESSAGES);
	const nameColor = () =>
		memberColor(
			guilds().find((g) => g.id === m.guildId),
			m.authorId,
		);

	// iOS never fires `contextmenu`, so a long press opens the same menu. Android fires
	// both; the later native event is swallowed.
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	let pressAt = 0;
	let pressX = 0;
	let pressY = 0;
	const cancelPress = () => clearTimeout(pressTimer);
	onCleanup(cancelPress);
	const openMenu = (e: MouseEvent) => {
		if (Date.now() - pressAt < 1000) {
			e.preventDefault();
			return;
		}
		props.onContextMenu(e, m.id, m.content, isMine(), canDelete());
	};
	const pressHandlers = {
		onTouchStart: (e: TouchEvent) => {
			if (e.touches.length !== 1 || props.editing()) return;
			const tt = e.touches[0];
			pressX = tt.clientX;
			pressY = tt.clientY;
			cancelPress();
			pressTimer = setTimeout(() => {
				pressAt = Date.now();
				props.onContextMenu(
					{ clientX: pressX, clientY: pressY, preventDefault() {} } as MouseEvent,
					m.id,
					m.content,
					isMine(),
					canDelete(),
				);
			}, LONG_PRESS_MS);
		},
		onTouchMove: (e: TouchEvent) => {
			const tt = e.touches[0];
			if (Math.hypot(tt.clientX - pressX, tt.clientY - pressY) > LONG_PRESS_SLOP) cancelPress();
		},
		onTouchEnd: cancelPress,
		onTouchCancel: cancelPress,
	};

	const Toolbar = () => (
		<Show when={!props.editing()}>
			<div class="absolute -top-3 right-4 opacity-0 group-hover:opacity-100 transition-opacity flex bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700 rounded-lg shadow-md overflow-hidden z-10">
				<button
					type="button"
					onClick={() => props.onStartReply(m)}
					class="w-8 h-8 flex items-center justify-center hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300"
					title={t('context-reply')}
				>
					<i class="fa-solid fa-reply text-xs" />
				</button>
				<Show when={isMine()}>
					<button
						type="button"
						onClick={() => props.onStartEdit(m.id, m.content)}
						class="w-8 h-8 flex items-center justify-center hover:bg-stone-100 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300 border-l border-stone-200 dark:border-stone-700"
						title={t('context-edit')}
					>
						<i class="fa-solid fa-pen text-xs" />
					</button>
				</Show>
				<Show when={canDelete()}>
					<button
						type="button"
						onClick={() => props.onDelete(m.id, m.content)}
						class="w-8 h-8 flex items-center justify-center hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 border-l border-stone-200 dark:border-stone-700"
						title={t('context-delete')}
					>
						<i class="fa-solid fa-trash text-xs" />
					</button>
				</Show>
			</div>
		</Show>
	);

	const ReplyPreview = () => {
		const ref = m.referencedMessage;
		if (!ref && !m.messageReference?.messageId) return null;
		const refAuthorName = () => {
			if (!ref) return null;
			const cached = getUser(ref.authorId);
			return ref.author?.member?.nickname ?? cached?.username ?? ref.author?.username ?? '?';
		};
		const refAvatarUser = () => {
			if (!ref) return null;
			const cached = getUser(ref.authorId);
			return {
				id: ref.authorId,
				username: cached?.username ?? ref.author?.username ?? '?',
				avatar: cached?.avatar ?? ref.author?.avatar ?? null,
			};
		};
		const targetId = ref?.id ?? m.messageReference?.messageId;
		const onJump = () => {
			if (targetId) props.onJumpToMessage(targetId);
		};
		return (
			<div class="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400 mb-1 pl-3 relative">
				<span class="absolute left-0 top-1/2 -translate-y-1/2 w-2.5 h-2 border-l-2 border-t-2 border-stone-300 dark:border-stone-600 rounded-tl-md" />
				<Show when={ref} fallback={<span class="italic">{t('reply-deleted')}</span>}>
					{(r) => (
						<button
							type="button"
							onClick={onJump}
							class="flex items-center gap-1.5 min-w-0 hover:text-stone-700 dark:hover:text-stone-200 transition-colors"
							title={t('reply-click-to-jump')}
						>
							<Avatar user={refAvatarUser()!} size={16} />
							<span class="font-display font-medium shrink-0">@{refAuthorName()}</span>
							<span class="truncate opacity-80">
								<MessageBody text={previewText(r())} mode="inline" />
							</span>
						</button>
					)}
				</Show>
			</div>
		);
	};

	const Content = () => (
		<Show
			when={props.editing()}
			fallback={
				<>
					<MessageBody text={m.content} />
					<MessageAttachments attachments={m.attachments} />
				</>
			}
		>
			<div>
				<textarea
					value={props.editDraft()}
					onInput={(e) => props.setEditDraft(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							props.saveEdit();
						}
						if (e.key === 'Escape') props.cancelEdit();
					}}
					rows={2}
					class="w-full rounded-lg bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-700 px-3 py-2 text-sm outline-none focus:border-[#f7e26c] resize-none"
				/>
				<div class="flex gap-3 text-xs text-stone-500 mt-1 italic font-display">
					<span>
						{t('edit-hint')}{' '}
						<button
							type="button"
							onClick={props.cancelEdit}
							class="underline hover:text-stone-800 dark:hover:text-stone-200"
						>
							{t('edit-cancel')}
						</button>
					</span>
				</div>
			</div>
		</Show>
	);

	return (
		<Show
			when={isHead()}
			fallback={
				<div
					data-message-id={m.id}
					class="relative flex group hover:bg-[#f7e26c]/40 dark:hover:bg-stone-800/80 -mx-3 px-3 py-0.5 rounded-md transition-colors"
					classList={{
						'bg-[#f7e26c]/30 dark:bg-[#f7e26c]/20 shadow-[inset_3px_0_0_#f7e26c]':
							props.highlighted() || pinged(),
					}}
					onContextMenu={openMenu}
					{...pressHandlers}
				>
					<Toolbar />
					<span class="w-[50px] shrink-0 text-[0.65rem] text-stone-400 font-mono opacity-0 group-hover:opacity-100 self-center text-right pr-2">
						{fullTime}
					</span>
					<div class="flex-1 min-w-0 text-stone-700 dark:text-stone-300 leading-relaxed text-[0.95rem] break-words whitespace-pre-wrap">
						<Content />
					</div>
				</div>
			}
		>
			<div
				data-message-id={m.id}
				class="relative group hover:bg-[#f7e26c]/40 dark:hover:bg-stone-800/80 -mx-3 px-3 py-2 mt-2 rounded-xl transition-colors"
				classList={{
					'bg-[#f7e26c]/30 dark:bg-[#f7e26c]/20 shadow-[inset_3px_0_0_#f7e26c]':
						props.highlighted() || pinged(),
				}}
				onContextMenu={openMenu}
				{...pressHandlers}
			>
				<Toolbar />
				<ReplyPreview />
				<div class="flex gap-3">
					<button onClick={(e) => profile.open(profileUser(), e, true)} class="shrink-0 self-start">
						<Avatar user={avatarUser()} status={liveStatus()} size={38} />
					</button>
					<div class="flex-1 min-w-0">
						<div class="flex items-baseline gap-2">
							<button
								onClick={(e) => profile.open(profileUser(), e, true)}
								class="font-display text-base hover:underline underline-offset-2"
								style={{ color: nameColor() }}
							>
								{displayName()}
							</button>
							<span class="text-xs text-stone-400 font-display italic">{fullTime}</span>
						</div>
						<div class="text-stone-700 dark:text-stone-300 leading-relaxed text-[0.95rem] break-words mt-0.5 whitespace-pre-wrap">
							<Content />
						</div>
					</div>
				</div>
			</div>
		</Show>
	);
}
