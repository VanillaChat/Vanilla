import { createFileRoute, useNavigate } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from 'solid-js';
import { ApiError } from '../api/client';
import { gatewayState } from '../api/gateway';
import {
	type CreateMessageRequest,
	createMessage,
	deleteMessage,
	editMessage,
	fetchMessages,
	type Message,
	sendTyping,
} from '../api/messages';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ChannelHeader } from '../components/channel/ChannelHeader';
import { InviteBanner } from '../components/channel/InviteBanner';
import { JumpToBottomButton } from '../components/channel/JumpToBottomButton';
import { MessageComposer } from '../components/channel/MessageComposer';
import { type CtxMenuState, MessageContextMenu } from '../components/channel/MessageContextMenu';
import { MessageItem } from '../components/channel/MessageItem';
import { SlowmodeIndicator } from '../components/channel/SlowmodeIndicator';
import { TypingIndicator } from '../components/channel/TypingIndicator';
import { VoiceChannelView } from '../components/channel/VoiceChannelView';
import { SearchBox } from '../components/search/SearchBox';
import { SearchPanel } from '../components/search/SearchPanel';
import { useLayout } from '../contexts/layout';
import { t } from '../i18n';
import { clearPending, isUploading, readyIds } from '../state/attachments';
import { DM_SCOPE, dmChannels, dmOthers, dmTitle, getDm, leaveGroup } from '../state/dms';
import { currentUser, getUser, useChannel, useGuild, useGuildUsers } from '../state/gateway-data';
import { copyText, createInviteLink } from '../state/invite';
import { setViewedChannel } from '../state/mentions';
import {
	addMessage,
	isChannelDetached,
	isChannelExhausted,
	isChannelLoaded,
	markChannelExhausted,
	markChannelLoaded,
	messageStore,
	prependMessages,
	removeMessage as removeLocalMessage,
	setChannelDetached,
	setChannelMessages,
	unmarkChannelExhausted,
	updateMessage as updateLocalMessage,
} from '../state/messages';
import { hasPerm, Perm, standingIn } from '../state/permissions';
import { closeSearch, jumpTarget, type SearchScope, setJumpTarget } from '../state/search';
import { lastSentStore, recordSent } from '../state/slowmode';
import { typingStore } from '../state/typing';
import { voiceEvents } from '../state/voice-events';

export const Route = createFileRoute('/app/$serverId/$channelId')({
	component: ChannelView,
});

const PAGE_SIZE = 50;
const ANIM_MS = 130;

function ChannelView() {
	const params = Route.useParams();
	const channel = useChannel(
		() => params().serverId,
		() => params().channelId,
	);

	const isVoiceChannel = createMemo(() => (channel()?.type ?? 'TEXT').toUpperCase() === 'VOICE');

	const dm = createMemo(() =>
		params().serverId === DM_SCOPE ? getDm(params().channelId) : undefined,
	);
	const navigate = useNavigate();
	const [leaving, setLeaving] = createSignal(false);
	const leave = async () => {
		await leaveGroup(params().channelId);
		navigate({ to: '/app/$serverId', params: { serverId: DM_SCOPE }, viewTransition: false });
	};

	const guild = useGuild(() => params().serverId);
	const standing = () => standingIn(guild(), currentUser()?.id);
	// Slowmode does not apply to those who moderate the server.
	const skipsSlowmode = () =>
		(standing().permissions & (Perm.MANAGE_MESSAGES | Perm.MANAGE_CHANNELS)) !== 0;
	// Until the server has loaded there is nothing to judge by; the API refuses a send anyway.
	const canSend = () =>
		params().serverId === DM_SCOPE ||
		!guild() ||
		hasPerm(standing().permissions, Perm.SEND_MESSAGES);
	const layout = useLayout();

	const messages = createMemo(() => {
		const list = messageStore()[params().channelId] ?? [];
		return [...list].sort((a, b) => Number(new Date(a.createdAt)) - Number(new Date(b.createdAt)));
	});

	type TimelineItem =
		| {
				kind: 'msg';
				m: ReturnType<typeof messages>[number];
				prev: ReturnType<typeof messages>[number] | undefined;
		  }
		| { kind: 'sys'; id: string; text: string };
	// Rows are matched by object identity, so unchanged items must come back as the same
	// object or every row (and its link previews) would be rebuilt on each new message.
	let rows = new Map<string, TimelineItem>();
	const timeline = createMemo<TimelineItem[]>(() => {
		const msgs = messages();
		const out: TimelineItem[] = [];
		const used = new Map<string, TimelineItem>();
		const keep = (key: string, item: TimelineItem, same: (old: TimelineItem) => boolean) => {
			const old = rows.get(key);
			const chosen = old && same(old) ? old : item;
			used.set(key, chosen);
			out.push(chosen);
		};
		const events = isVoiceChannel()
			? voiceEvents().filter((e) => e.channelId === params().channelId)
			: [];
		let e = 0;
		const flush = (until: number) => {
			while (e < events.length && events[e].at <= until) {
				const ev = events[e++];
				const name = getUser(ev.userId)?.username ?? ev.userId;
				const text = t(ev.kind === 'join' ? 'voice-system-join' : 'voice-system-leave', { name });
				keep(
					`s:${ev.id}`,
					{ kind: 'sys', id: ev.id, text },
					(o) => o.kind === 'sys' && o.text === text,
				);
			}
		};
		msgs.forEach((m) => {
			flush(Number(new Date(m.createdAt)));
			const above = out[out.length - 1];
			const prev = above?.kind === 'msg' ? above.m : undefined;
			keep(
				`m:${m.id}`,
				{ kind: 'msg', m, prev },
				(o) => o.kind === 'msg' && o.m === m && o.prev === prev,
			);
		});
		flush(Number.POSITIVE_INFINITY);
		rows = used;
		return out;
	});

	createEffect(() => {
		setViewedChannel(params().channelId);
		onCleanup(() => setViewedChannel(null));
	});

	const [chatOpen, setChatOpen] = createSignal(false);
	const [chatSeenAt, setChatSeenAt] = createSignal(Date.now());
	createEffect(
		on(
			() => params().channelId,
			() => {
				setChatOpen(false);
				setChatSeenAt(Date.now());
			},
		),
	);
	createEffect(() => {
		messages();
		if (chatOpen()) setChatSeenAt(Date.now());
	});
	const chatUnread = createMemo(() => {
		if (chatOpen()) return 0;
		const me = currentUser()?.id;
		const since = chatSeenAt();
		return messages().filter((m) => m.authorId !== me && Number(new Date(m.createdAt)) > since)
			.length;
	});
	const showChat = () => !isVoiceChannel() || chatOpen();

	const guildUsers = useGuildUsers(() => params().serverId);
	const mentionCandidates = () => guildUsers().map((u) => u.user.username);

	const typing = createMemo(() => typingStore()[params().channelId] ?? []);
	const typingText = createMemo(() => {
		const list = typing();
		if (list.length === 0) return null;
		if (list.length === 1) return t('typing-one', { name: list[0].username });
		if (list.length === 2) return t('typing-two', { a: list[0].username, b: list[1].username });
		if (list.length === 3)
			return t('typing-three', {
				a: list[0].username,
				b: list[1].username,
				c: list[2].username,
			});
		return t('typing-many');
	});

	const [draft, setDraft] = createSignal('');
	const [loadingHistory, setLoadingHistory] = createSignal(false);
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [atBottom, setAtBottom] = createSignal(true);
	const [unread, setUnread] = createSignal(0);
	const [replyingTo, setReplyingTo] = createSignal<Message | null>(null);
	const [highlightId, setHighlightId] = createSignal<string | null>(null);
	let scrollEl: HTMLDivElement | undefined;
	// Stays true until the user scrolls up: content that grows (images, previews, new
	// messages) then keeps the view on the newest message instead of drifting upwards.
	let pinned = true;
	let resizeObserver: ResizeObserver | undefined;
	const pinToBottom = () => {
		if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
	};
	const bindScroll = (el: HTMLDivElement) => {
		scrollEl = el;
		resizeObserver?.disconnect();
		resizeObserver = new ResizeObserver(() => {
			if (pinned) pinToBottom();
		});
		resizeObserver.observe(el);
		if (el.firstElementChild) resizeObserver.observe(el.firstElementChild);
	};
	onCleanup(() => resizeObserver?.disconnect());
	let composerEl: { focus(): void } | undefined;
	let highlightTimer: number | null = null;

	const loadInitial = async (id: string) => {
		if (gatewayState() !== 'ready') return;
		if (isChannelLoaded(id) || loadingHistory()) return;
		setLoadingHistory(true);
		try {
			const list = await fetchMessages(id, { limit: PAGE_SIZE });
			// A jump to an old message got there first: keep that window.
			if (isChannelDetached(id)) return;
			setChannelMessages(id, list ?? []);
			markChannelLoaded(id);
			if ((list?.length ?? 0) < PAGE_SIZE) markChannelExhausted(id);
			requestAnimationFrame(() => {
				if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
			});
		} catch (err) {
			console.error('fetch messages failed', err);
		} finally {
			setLoadingHistory(false);
		}
	};

	const loadOlder = async () => {
		const id = params().channelId;
		if (gatewayState() !== 'ready') return;
		if (loadingOlder() || isChannelExhausted(id)) return;
		const list = messages();
		const oldest = list[0];
		if (!oldest) return;
		setLoadingOlder(true);
		const prevHeight = scrollEl?.scrollHeight ?? 0;
		const prevTop = scrollEl?.scrollTop ?? 0;
		try {
			const older = await fetchMessages(id, { before: oldest.id, limit: PAGE_SIZE });
			if (!older?.length || older.length < PAGE_SIZE) markChannelExhausted(id);
			if (older?.length) prependMessages(id, older);
			requestAnimationFrame(() => {
				if (scrollEl) {
					scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevHeight);
				}
			});
		} catch (err) {
			console.error('fetch older failed', err);
		} finally {
			setLoadingOlder(false);
		}
	};

	createEffect(() => {
		const id = params().channelId;
		if (!id) return;
		if (gatewayState() !== 'ready') return;
		loadInitial(id);
	});

	createEffect(
		on(
			() => params().channelId,
			() => {
				pinned = true;
				setAtBottom(true);
				setUnread(0);
				pinToBottom();
			},
		),
	);

	createEffect<{ len: number; last?: string }>(
		(prev) => {
			const list = messages();
			const last = list[list.length - 1]?.id;
			// Only a new newest message is unread; older pages prepended above are not.
			if (last !== prev.last && list.length > prev.len && !pinned) {
				setUnread((u) => u + (list.length - prev.len));
			}
			return { len: list.length, last };
		},
		{ len: 0 },
	);

	const onScroll = () => {
		if (!scrollEl) return;
		const near = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
		pinned = near;
		setAtBottom(near);
		if (near) setUnread(0);
		// Older history is requested only after the user scrolled up, never while we are
		// still settling on the bottom of a freshly opened channel.
		else if (scrollEl.scrollTop < 120) loadOlder();
	};

	const scrollToBottom = (smooth = true) => {
		if (!scrollEl) return;
		scrollEl.scrollTo({
			top: scrollEl.scrollHeight,
			behavior: smooth ? 'smooth' : 'auto',
		});
		setUnread(0);
	};

	const loadAround = async (channelId: string, messageId: string) => {
		const window = await fetchMessages(channelId, { around: messageId, limit: PAGE_SIZE });
		if (!window?.length) return false;
		setChannelMessages(channelId, window);
		markChannelLoaded(channelId);
		unmarkChannelExhausted(channelId);
		setChannelDetached(channelId, true);
		return true;
	};

	const jumpToPresent = async () => {
		const id = params().channelId;
		try {
			const list = await fetchMessages(id, { limit: PAGE_SIZE });
			setChannelDetached(id, false);
			setChannelMessages(id, list ?? []);
			if ((list?.length ?? 0) < PAGE_SIZE) markChannelExhausted(id);
			else unmarkChannelExhausted(id);
			pinned = true;
			pinToBottom();
		} catch (err) {
			console.error('jump to present failed', err);
		}
	};

	const jumpToMessage = async (id: string) => {
		let instant = false;
		if (!messages().some((m) => m.id === id)) {
			try {
				if (!(await loadAround(params().channelId, id))) return;
			} catch (err) {
				console.error('load around failed', err);
				return;
			}
			instant = true;
		}
		if (!scrollEl) return;
		const el = scrollEl.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
		if (!el) return;
		pinned = false;
		el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
		if (highlightTimer !== null) clearTimeout(highlightTimer);
		setHighlightId(id);
		highlightTimer = window.setTimeout(() => {
			setHighlightId(null);
			highlightTimer = null;
		}, 1600);
	};

	createEffect(() => {
		const target = jumpTarget();
		if (!target || target.channelId !== params().channelId) return;
		if (gatewayState() !== 'ready') return;
		setJumpTarget(null);
		jumpToMessage(target.messageId);
	});

	const startReply = (msg: Message) => {
		setReplyingTo(msg);
		requestAnimationFrame(() => composerEl?.focus());
	};
	const cancelReply = () => setReplyingTo(null);

	createEffect(
		on(
			() => params().channelId,
			() => setReplyingTo(null),
			{ defer: true },
		),
	);

	onCleanup(() => {
		if (highlightTimer !== null) clearTimeout(highlightTimer);
	});

	const [inviteCode, setInviteCode] = createSignal<string | null>(null);
	const [inviteLoading, setInviteLoading] = createSignal(false);
	const [inviteError, setInviteError] = createSignal<string | null>(null);
	const [copied, setCopied] = createSignal(false);

	const generateInvite = async () => {
		const id = params().channelId;
		setInviteLoading(true);
		setInviteError(null);
		setCopied(false);
		try {
			const link = await createInviteLink(id);
			setInviteCode(link);
			if (await copyText(link)) {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		} catch (err) {
			setInviteError(
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: t('invite-failed'),
			);
		} finally {
			setInviteLoading(false);
		}
	};

	const closeInvite = () => {
		setInviteCode(null);
		setInviteError(null);
		setCopied(false);
	};

	const copyInvite = async () => {
		const c = inviteCode();
		if (!c) return;
		try {
			await navigator.clipboard.writeText(c);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {}
	};

	const [lastMsgId, setLastMsgId] = createSignal<string>('');
	const [sending, setSending] = createSignal(false);
	const [sendError, setSendError] = createSignal<string | null>(null);
	const [now, setNow] = createSignal(Date.now());

	const cooldown = createMemo(() => {
		if (skipsSlowmode()) return 0;
		const rl = channel()?.rateLimitPerUser ?? 0;
		if (!rl) return 0;
		const last = lastSentStore()[params().channelId] ?? 0;
		const elapsed = (now() - last) / 1000;
		return Math.max(0, Math.ceil(rl - elapsed));
	});

	createEffect(() => {
		if (cooldown() <= 0) return;
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		onCleanup(() => clearInterval(timer));
	});

	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [editDraft, setEditDraft] = createSignal('');
	const [deleteCandidate, setDeleteCandidate] = createSignal<{
		id: string;
		preview: string;
	} | null>(null);

	const [ctxMenu, setCtxMenu] = createSignal<CtxMenuState | null>(null);
	const [ctxClosing, setCtxClosing] = createSignal(false);
	let ctxCloseTimer: number | null = null;
	let ctxMenuEl: HTMLDivElement | undefined;

	const openCtxMenu = (
		e: MouseEvent,
		messageId: string,
		content: string,
		mine: boolean,
		canDelete: boolean,
	) => {
		e.preventDefault();
		if (ctxCloseTimer !== null) {
			clearTimeout(ctxCloseTimer);
			ctxCloseTimer = null;
		}
		const W = 208;
		const H = mine ? 296 : canDelete ? 250 : 204;
		const x = Math.max(8, Math.min(e.clientX, window.innerWidth - W - 8));
		const y = Math.max(8, Math.min(e.clientY, window.innerHeight - H - 8));
		setCtxClosing(false);
		setCtxMenu({ x, y, messageId, content, mine, canDelete });
	};

	const closeCtxMenu = () => {
		if (!ctxMenu() || ctxClosing()) return;
		setCtxClosing(true);
		ctxCloseTimer = window.setTimeout(() => {
			setCtxMenu(null);
			setCtxClosing(false);
			ctxCloseTimer = null;
		}, ANIM_MS);
	};

	const copyToClipboard = async (text: string) => {
		try {
			await navigator.clipboard.writeText(text);
		} catch {}
	};

	createEffect(() => {
		if (!ctxMenu() || ctxClosing()) return;
		const onDown = (e: PointerEvent) => {
			if (!ctxMenuEl?.contains(e.target as Node)) closeCtxMenu();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeCtxMenu();
		};
		const onScrollClose = () => closeCtxMenu();
		document.addEventListener('pointerdown', onDown);
		document.addEventListener('keydown', onKey);
		scrollEl?.addEventListener('scroll', onScrollClose);
		onCleanup(() => {
			document.removeEventListener('pointerdown', onDown);
			document.removeEventListener('keydown', onKey);
			scrollEl?.removeEventListener('scroll', onScrollClose);
		});
	});

	createEffect(
		on(
			() => params().channelId,
			() => {
				if (ctxMenu()) closeCtxMenu();
			},
			{ defer: true },
		),
	);

	const openDelete = (id: string, preview: string) => setDeleteCandidate({ id, preview });
	let lastTypingAt = 0;

	const startEdit = (id: string, current: string) => {
		setEditingId(id);
		setEditDraft(current);
	};
	const cancelEdit = () => {
		setEditingId(null);
		setEditDraft('');
	};
	const saveEdit = async () => {
		const id = editingId();
		if (!id) return;
		const text = editDraft().trim();
		if (!text) return;
		try {
			const updated = await editMessage(params().channelId, id, text);
			if (updated?.id) updateLocalMessage(updated);
		} catch (err) {
			console.error('edit failed', err);
		}
		cancelEdit();
	};

	const confirmDelete = async (id: string) => {
		await deleteMessage(params().channelId, id);
		removeLocalMessage(params().channelId, id);
	};

	const onDraftInput = (value: string) => {
		setDraft(value);
		if (!value.trim()) return;
		if (gatewayState() !== 'ready') return;
		const now = Date.now();
		if (now - lastTypingAt >= 1000) {
			lastTypingAt = now;
			sendTyping(params().channelId).catch(() => {});
		}
	};

	const onSend = async (e: Event) => {
		e.preventDefault();
		const text = draft().trim();
		const channelId = params().channelId;
		const attachmentIds = readyIds(channelId);
		if ((!text && attachmentIds.length === 0) || sending() || cooldown() > 0) return;
		if (isUploading(channelId)) return;
		// Sending from a window of old history: come back to the present first.
		if (isChannelDetached(channelId)) await jumpToPresent();
		const nonce = lastMsgId() || `n-${Date.now()}`;
		const reply = replyingTo();
		setDraft('');
		setSending(true);
		setSendError(null);
		try {
			const payload: CreateMessageRequest = { content: text, nonce };
			if (attachmentIds.length) payload.attachmentIds = attachmentIds;
			if (reply) payload.messageReference = { messageId: reply.id };
			const msg = await createMessage(channelId, payload);
			if (msg?.id) {
				addMessage(msg);
				setLastMsgId(msg.id);
				if ((channel()?.rateLimitPerUser ?? 0) > 0) {
					recordSent(channelId);
					setNow(Date.now());
				}
				setReplyingTo(null);
				clearPending(channelId);
			}
		} catch (err) {
			setSendError(
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: t('app-send-failed'),
			);
			setDraft(text);
		} finally {
			setSending(false);
		}
	};

	const onReplyFromMenu = (id: string) => {
		const target = messages().find((x) => x.id === id);
		if (target) startReply(target);
	};

	const inDms = () => params().serverId === DM_SCOPE;
	const searchScope = (): SearchScope =>
		inDms() ? { kind: 'dm' } : { kind: 'guild', guildId: params().serverId };
	const searchPeople = () =>
		inDms()
			? dmChannels().flatMap((d) => dmOthers(d, currentUser()?.id).map((u) => u.username))
			: guildUsers().map((u) => u.user.username);
	const searchChannels = () =>
		inDms()
			? [...dmChannels().flatMap((d) => (d.name ? [d.name] : [])), ...searchPeople()]
			: (guild()?.channels ?? [])
					.filter((c) => (c.type ?? 'TEXT').toUpperCase() === 'TEXT')
					.map((c) => c.name);
	const resultLabel = (m: Message) => {
		if (inDms()) {
			const d = getDm(m.channelId);
			return d ? dmTitle(d, currentUser()?.id) : '';
		}
		return `#${guild()?.channels.find((c) => c.id === m.channelId)?.name ?? ''}`;
	};
	const pickResult = (m: Message) => {
		setJumpTarget({ channelId: m.channelId, messageId: m.id });
		if (m.channelId !== params().channelId) {
			navigate({
				to: '/app/$serverId/$channelId',
				params: { serverId: params().serverId, channelId: m.channelId },
				viewTransition: false,
			});
		}
		if (layout.isMobile()) closeSearch();
	};

	const onCopyLink = (id: string) => {
		const link = `${window.location.origin}/app/${params().serverId}/${params().channelId}/${id}`;
		copyToClipboard(link);
	};

	// Replays the entrance animation each time another channel opens.
	let mainEl: HTMLElement | undefined;
	createEffect(
		on(
			() => params().channelId,
			() => {
				if (!mainEl) return;
				mainEl.classList.remove('channel-enter');
				void mainEl.offsetWidth;
				mainEl.classList.add('channel-enter');
			},
		),
	);

	return (
		<main
			ref={mainEl}
			class="relative flex-1 min-w-0 flex flex-col bg-white dark:bg-[#211e1b] overflow-hidden lg:my-3 lg:mx-3 lg:rounded-3xl lg:shadow-[0_2px_10px_rgba(0,0,0,0.04)]"
			style={layout.contentStyle()}
		>
			<ChannelHeader
				channel={channel}
				onGenerateInvite={generateInvite}
				inviteLoading={inviteLoading}
				dm={params().serverId === DM_SCOPE}
				group={dm()?.isGroup}
				onLeave={() => setLeaving(true)}
				search={<SearchBox scope={searchScope()} people={searchPeople} channels={searchChannels} />}
			/>

			<InviteBanner
				code={inviteCode}
				error={inviteError}
				copied={copied}
				onCopy={copyInvite}
				onClose={closeInvite}
			/>

			<Show when={isChannelDetached(params().channelId)}>
				<div class="px-4 sm:px-6 py-2 flex items-center gap-3 text-sm bg-[#fdfaf3] dark:bg-stone-900 border-b border-stone-100 dark:border-stone-800 shrink-0">
					<i class="fa-solid fa-clock-rotate-left text-stone-400" />
					<span class="flex-1 italic font-display text-stone-600 dark:text-stone-300">
						{t('search-detached')}
					</span>
					<button
						type="button"
						onClick={jumpToPresent}
						class="font-medium text-stone-700 dark:text-stone-200 hover:underline"
					>
						{t('app-jump-to-present')}
					</button>
				</div>
			</Show>

			<div class="relative flex-1 min-h-0 flex flex-col lg:flex-row">
				<Show when={isVoiceChannel()}>
					<div class="flex flex-col min-h-0 min-w-0 flex-1 lg:flex-[3] max-h-[55%] lg:max-h-none">
						<VoiceChannelView
							chatOpen={chatOpen()}
							chatUnread={chatUnread()}
							onToggleChat={() => setChatOpen(!chatOpen())}
							channelId={params().channelId}
							channelName={channel()?.name ?? ''}
							guildId={params().serverId}
						/>
					</div>
				</Show>

				<Show when={showChat()}>
					<div
						class="relative flex flex-col min-h-0 min-w-0"
						classList={{
							'flex-1': !isVoiceChannel(),
							'flex-1 lg:flex-[2] lg:max-w-md lg:border-l border-t lg:border-t-0 border-stone-100 dark:border-stone-800':
								isVoiceChannel(),
						}}
					>
						<Show when={isVoiceChannel()}>
							<button
								type="button"
								onClick={() => setChatOpen(false)}
								aria-label={t('voice-chat-close')}
								title={t('voice-chat-close')}
								class="absolute top-2 right-2 z-20 w-8 h-8 rounded-lg bg-stone-100/90 dark:bg-stone-800/90 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300 flex items-center justify-center"
							>
								<i class="fa-solid fa-xmark" />
							</button>
						</Show>
						<div
							ref={bindScroll}
							onScroll={onScroll}
							class="flex-1 overflow-y-auto px-3 sm:px-6 py-4 sm:py-5"
						>
							<div class="min-h-full flex flex-col justify-end">
								<Show when={loadingOlder()}>
									<div class="text-center py-2 text-xs text-stone-400 italic font-display">
										{t('app-load-older')}
									</div>
								</Show>
								<Show when={loadingHistory() && messages().length === 0}>
									<div class="text-center py-20 text-stone-400 italic font-display">
										{t('app-loading')}
									</div>
								</Show>
								<Show
									when={messages().length > 0}
									fallback={
										<div class="text-center text-stone-400 py-20 font-display italic text-2xl">
											{t('app-empty-channel')}
										</div>
									}
								>
									<For each={timeline()}>
										{(item) => (
											<Show
												when={item.kind === 'msg' && item}
												fallback={
													<div class="py-1 text-center text-xs text-stone-400 italic font-display">
														{item.kind === 'sys' ? item.text : ''}
													</div>
												}
											>
												{(entry) => {
													const m = () => (entry() as Extract<TimelineItem, { kind: 'msg' }>).m;
													return (
														<MessageItem
															m={m()}
															prev={() => (entry() as Extract<TimelineItem, { kind: 'msg' }>).prev}
															highlighted={() => highlightId() === m().id}
															editing={() => editingId() === m().id}
															editDraft={editDraft}
															setEditDraft={setEditDraft}
															saveEdit={saveEdit}
															cancelEdit={cancelEdit}
															onStartReply={startReply}
															onStartEdit={startEdit}
															onDelete={openDelete}
															onJumpToMessage={jumpToMessage}
															onContextMenu={openCtxMenu}
														/>
													);
												}}
											</Show>
										)}
									</For>
								</Show>
							</div>
						</div>

						<JumpToBottomButton
							visible={() => !atBottom() || isChannelDetached(params().channelId)}
							unread={unread}
							onClick={() =>
								isChannelDetached(params().channelId) ? jumpToPresent() : scrollToBottom(true)
							}
						/>

						<TypingIndicator text={typingText} />

						<SlowmodeIndicator channel={channel} cooldown={cooldown} bypassed={skipsSlowmode} />

						<Show when={sendError()}>
							<div class="px-4 sm:px-6 py-2 text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
								<span>{sendError()}</span>
								<button
									onClick={() => setSendError(null)}
									class="ml-auto text-stone-400 hover:text-stone-700"
								>
									<i class="fa-solid fa-xmark" />
								</button>
							</div>
						</Show>

						<Show
							when={canSend()}
							fallback={
								<div class="px-4 sm:px-6 pb-5 pt-2">
									<div class="rounded-2xl bg-stone-100 dark:bg-stone-800/60 px-4 py-3 text-sm text-stone-500 italic font-display">
										{t('composer-no-permission')}
									</div>
								</div>
							}
						>
							<MessageComposer
								mentionCandidates={mentionCandidates}
								channel={channel}
								draft={draft}
								onDraftInput={onDraftInput}
								channelId={() => params().channelId}
								onSend={onSend}
								sending={sending}
								cooldown={cooldown}
								replyingTo={replyingTo}
								onCancelReply={cancelReply}
								composerRef={(el) => (composerEl = el)}
							/>
						</Show>

						<MessageContextMenu
							menu={ctxMenu}
							closing={ctxClosing}
							menuRef={(el) => (ctxMenuEl = el)}
							onReply={onReplyFromMenu}
							onCopyText={copyToClipboard}
							onCopyId={copyToClipboard}
							onCopyLink={onCopyLink}
							onEdit={startEdit}
							onDelete={openDelete}
							onClose={closeCtxMenu}
						/>

						<Show when={deleteCandidate()}>
							{(c) => (
								<ConfirmDialog
									title={t('delete-title')}
									description={t('delete-sub')}
									confirmLabel={t('delete-confirm')}
									busyLabel={t('delete-confirming')}
									onClose={() => setDeleteCandidate(null)}
									onConfirm={() => confirmDelete(c().id)}
								>
									<div class="rounded-xl bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-800 px-4 py-3 text-sm text-stone-700 dark:text-stone-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
										{c().preview}
									</div>
								</ConfirmDialog>
							)}
						</Show>
						<Show when={leaving()}>
							<ConfirmDialog
								title={t('group-leave-title')}
								description={t(
									(dm()?.members.length ?? 0) <= 1 ? 'group-leave-sub-last' : 'group-leave-sub',
								)}
								confirmLabel={t('group-leave-confirm')}
								busyLabel={t('group-leave-confirming')}
								errorText={t('group-leave-failed')}
								onClose={() => setLeaving(false)}
								onConfirm={leave}
							/>
						</Show>
					</div>
				</Show>
				<SearchPanel label={resultLabel} onPick={pickResult} />
			</div>
		</main>
	);
}
