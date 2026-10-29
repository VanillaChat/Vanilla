import { createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { type GatewayUser, ready } from '../api/gateway';

const ANIM_MS = 130;

export function useProfilePopover() {
	const [profileUser, setProfileUser] = createSignal<GatewayUser | null>(null);
	const [profilePos, setProfilePos] = createSignal({ x: 0, y: 0 });
	const [profilePinBottom, setProfilePinBottom] = createSignal<number | null>(null);
	const [profileOrigin, setProfileOrigin] = createSignal('top left');
	const [profileClosing, setProfileClosing] = createSignal(false);
	const [statusPickerOpen, setStatusPickerOpen] = createSignal(false);
	let popoverEl: HTMLDivElement | undefined;
	let profileCloseTimer: number | null = null;
	// The outside-mousedown closes the popover before the click that would toggle it
	// arrives, so remember it to keep that click from reopening the same profile.
	let outsideClose: { id: string; at: number } | null = null;

	const close = () => {
		if (!profileUser() || profileClosing()) return;
		setStatusPickerOpen(false);
		setProfileClosing(true);
		profileCloseTimer = window.setTimeout(() => {
			setProfileUser(null);
			setProfileClosing(false);
			profileCloseTimer = null;
		}, ANIM_MS);
	};

	const open = (
		user: GatewayUser,
		e: MouseEvent,
		preferRight = false,
		preferAbove = false,
		centerX = false,
	) => {
		e.stopPropagation();
		if (outsideClose && outsideClose.id === user.id && performance.now() - outsideClose.at < 400) {
			outsideClose = null;
			return;
		}
		const W = 288;
		const H = 380;
		const GAP = 12;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();

		let x: number;
		let y: number;
		let originX: 'left' | 'right' | 'center';
		let originY: 'top' | 'bottom';

		let pinBottom: number | null = null;
		if (preferAbove) {
			if (centerX) {
				x = rect.left + rect.width / 2 - W / 2;
				originX = 'center';
			} else {
				x = rect.left;
				originX = 'left';
			}
			const above = rect.top - H - GAP;
			if (above >= 8) {
				pinBottom = window.innerHeight - rect.top + GAP;
				y = above;
				originY = 'bottom';
			} else {
				y = rect.bottom + GAP;
				originY = 'top';
			}
		} else {
			if (preferRight) {
				const right = rect.right + GAP;
				if (right + W <= window.innerWidth - 8) {
					x = right;
					originX = 'left';
				} else {
					x = rect.left - W - GAP;
					originX = 'right';
				}
			} else {
				const left = rect.left - W - GAP;
				if (left >= 8) {
					x = left;
					originX = 'right';
				} else {
					x = rect.right + GAP;
					originX = 'left';
				}
			}
			if (rect.top + H <= window.innerHeight - 8) {
				y = rect.top;
				originY = 'top';
			} else {
				y = rect.bottom - H;
				originY = 'bottom';
			}
		}

		x = Math.max(8, Math.min(x, window.innerWidth - W - 8));
		y = Math.max(8, Math.min(y, window.innerHeight - H - 8));

		if (profileCloseTimer !== null) {
			clearTimeout(profileCloseTimer);
			profileCloseTimer = null;
		}
		setProfileClosing(false);
		setProfilePos({ x, y });
		setProfilePinBottom(pinBottom);
		setProfileOrigin(`${originY} ${originX}`);
		setStatusPickerOpen(false);
		setProfileUser(user);
	};

	const liveProfileUser = createMemo<GatewayUser | null>(() => {
		const u = profileUser();
		if (!u) return null;
		return ready()?.users?.[u.id] ?? u;
	});

	createEffect(() => {
		if (!profileUser() || profileClosing()) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Element;
			// Floating children (the emoji picker) live outside the popover's DOM but belong to it.
			if (popoverEl && !popoverEl.contains(target) && !target.closest('[data-popover-child]')) {
				const id = profileUser()?.id;
				outsideClose = id ? { id, at: performance.now() } : null;
				close();
			}
		};
		document.addEventListener('mousedown', handler);
		onCleanup(() => document.removeEventListener('mousedown', handler));
	});

	return {
		open,
		close,
		user: liveProfileUser,
		pos: profilePos,
		pinBottom: profilePinBottom,
		origin: profileOrigin,
		closing: profileClosing,
		statusPickerOpen,
		setStatusPickerOpen,
		setPopoverEl: (el: HTMLDivElement) => {
			popoverEl = el;
		},
	};
}

export type ProfilePopoverApi = ReturnType<typeof useProfilePopover>;
