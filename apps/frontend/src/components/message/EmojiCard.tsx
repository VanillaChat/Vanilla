import { useMatch, useNavigate } from '@tanstack/solid-router';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../../i18n';
import { avatarBackdrop } from '../../state/default-avatar';
import { BUILTIN_GUILD, type CustomEmoji } from '../../state/emoji';
import { guilds } from '../../state/gateway-data';
import { DefaultAvatar } from '../ui/DefaultAvatar';
import { Emoji } from '../ui/Emoji';

const W = 280;
const H = 190;

/** A custom emoji in a message. Clicking it opens a card saying where the emoji comes from. */
export function EmojiCard(props: { emoji: CustomEmoji; big?: boolean }) {
	const navigate = useNavigate();
	const [pos, setPos] = createSignal<{ x: number; y: number } | null>(null);
	const server = useMatch({ from: '/app/$serverId', shouldThrow: false });
	const guild = () => guilds().find((g) => g.id === props.emoji.guildId);
	const fromHere = () => server()?.params.serverId === props.emoji.guildId;

	const open = (e: MouseEvent) => {
		const target = e.currentTarget as HTMLElement;
		const r = target.getBoundingClientRect();
		// Beside the emoji, on the right; on the left when there is no room.
		const right = r.right + 8;
		const x =
			right + W <= window.innerWidth - 8 ? right : Math.max(8, Math.min(r.left - W - 8, right));
		// Centred on the whole message, not just the emoji.
		const row = (target.closest('[data-message-id]') ?? target).getBoundingClientRect();
		const mid = row.top + row.height / 2;
		const y = Math.max(H / 2 + 8, Math.min(mid, window.innerHeight - H / 2 - 8));
		setPos({ x, y });
	};

	return (
		<>
			<button
				type="button"
				data-emoji-card
				onClick={(e) => (pos() ? setPos(null) : open(e))}
				class="inline align-baseline cursor-pointer"
				aria-label={`:${props.emoji.name}:`}
			>
				<Emoji char={`:${props.emoji.name}:`} url={props.emoji.src} big={props.big} />
			</button>
			<Show when={pos()}>
				{(p) => (
					<Portal>
						<Card
							x={p().x}
							y={p().y}
							emoji={props.emoji}
							fromHere={fromHere()}
							serverName={guild()?.name ?? props.emoji.guildName}
							icon={guild()?.icon ?? null}
							onClose={() => setPos(null)}
							onGo={() => {
								setPos(null);
								navigate({
									to: '/app/$serverId',
									params: { serverId: props.emoji.guildId },
									viewTransition: false,
								});
							}}
						/>
					</Portal>
				)}
			</Show>
		</>
	);
}

function Card(props: {
	x: number;
	y: number;
	emoji: CustomEmoji;
	fromHere: boolean;
	serverName: string;
	icon: string | null;
	onClose: () => void;
	onGo: () => void;
}) {
	let el: HTMLDivElement | undefined;
	onMount(() => {
		const down = (e: MouseEvent) => {
			const target = e.target as Element;
			// The emoji button toggles the card itself.
			if (!el?.contains(target) && !target.closest('[data-emoji-card]')) props.onClose();
		};
		const key = (e: KeyboardEvent) => {
			if (e.key === 'Escape') props.onClose();
		};
		document.addEventListener('mousedown', down);
		document.addEventListener('keydown', key);
		onCleanup(() => {
			document.removeEventListener('mousedown', down);
			document.removeEventListener('keydown', key);
		});
	});

	return (
		<div
			ref={el}
			role="dialog"
			aria-label={`:${props.emoji.name}:`}
			style={{
				left: `${props.x}px`,
				top: `${props.y - H / 2}px`,
				width: `${W}px`,
			}}
			class="fixed z-[80] rounded-2xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-[#211e1b] shadow-xl shadow-black/15 p-4 animate-popover-in"
		>
			<div class="flex items-center gap-3">
				<img
					src={props.emoji.src}
					alt=""
					draggable={false}
					class="w-12 h-12 object-contain shrink-0"
				/>
				<div class="min-w-0">
					<div class="font-display text-lg leading-tight truncate">:{props.emoji.name}:</div>
					<div class="text-xs text-stone-500 mt-0.5">
						{props.emoji.guildId === BUILTIN_GUILD
							? t('emoji-card-builtin')
							: props.fromHere
								? t('emoji-card-here')
								: t('emoji-card-other')}
					</div>
				</div>
			</div>
			<Show
				when={props.emoji.guildId !== BUILTIN_GUILD}
				fallback={
					<div class="invisible mt-4 pt-3 border-t border-transparent" aria-hidden="true">
						<div class="mb-2 text-[0.7rem]">.</div>
						<div class="h-8" />
					</div>
				}
			>
				<div class="mt-4 pt-3 border-t border-stone-100 dark:border-stone-800">
					<div class="text-[0.7rem] uppercase tracking-wider text-stone-400 font-medium mb-2">
						{t('emoji-card-from')}
					</div>
					<div class="flex items-center gap-2.5 min-w-0">
						<span
							class="flex items-center justify-center w-8 h-8 rounded-lg font-display text-stone-900 overflow-hidden shrink-0"
							style={{
								'background-color': avatarBackdrop(props.emoji.guildId, !!props.icon),
							}}
						>
							{props.icon ? (
								<img src={props.icon} alt="" class="w-full h-full object-cover" />
							) : (
								<DefaultAvatar id={props.emoji.guildId} />
							)}
						</span>
						<span class="flex-1 truncate text-sm font-medium">{props.serverName}</span>
						<Show
							when={!props.fromHere}
							fallback={
								<span class="text-xs text-stone-400 shrink-0">{t('emoji-card-joined')}</span>
							}
						>
							<button
								type="button"
								onClick={props.onGo}
								class="shrink-0 px-3 py-1.5 rounded-lg bg-[#f7e26c] text-stone-900 text-xs font-medium hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow"
							>
								{t('emoji-card-go')}
							</button>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
