import { createEffect, createSignal, type JSX, onCleanup, onMount } from 'solid-js';
import type { LayoutCtx } from '../contexts/layout';

export type UseLayoutStateOptions = {
	currentServerId: () => string | undefined;
	currentChannelId: () => string | undefined;
	hasMembers: () => boolean;
};

export type LayoutState = LayoutCtx & {
	drag: () => { side: 'left' | 'right'; px: number } | null;
};

export function useLayoutState(opts: UseLayoutStateOptions): LayoutState {
	const [sidebarOpen, setSidebarOpen] = createSignal(false);
	const [membersOpen, setMembersOpen] = createSignal(false);
	const [sidebarCollapsed, setSidebarCollapsed] = createSignal(
		typeof localStorage !== 'undefined' && localStorage.getItem('sidebar-collapsed') === '1',
	);
	const [sidebarPeeking, setSidebarPeeking] = createSignal(false);
	const [membersCollapsed, setMembersCollapsed] = createSignal(
		typeof localStorage !== 'undefined' && localStorage.getItem('members-collapsed') === '1',
	);
	const [membersPeeking, setMembersPeeking] = createSignal(false);

	createEffect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('sidebar-collapsed', sidebarCollapsed() ? '1' : '0');
		}
	});

	createEffect(() => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('members-collapsed', membersCollapsed() ? '1' : '0');
		}
	});

	createEffect(() => {
		if (!sidebarCollapsed()) setSidebarPeeking(false);
	});

	createEffect(() => {
		if (!membersCollapsed()) setMembersPeeking(false);
	});

	const [drag, setDrag] = createSignal<{ side: 'left' | 'right'; px: number } | null>(null);
	const [isMobile, setIsMobile] = createSignal(
		typeof window !== 'undefined' ? window.innerWidth < 1024 : true,
	);
	const [vw, setVw] = createSignal(typeof window !== 'undefined' ? window.innerWidth : 1024);

	const LEFT_W = () => Math.min(288, Math.round(vw() * 0.85));
	const RIGHT_W = () => Math.min(256, Math.round(vw() * 0.85));
	const LEFT_HIDE = () => LEFT_W();
	const RIGHT_HIDE = () => RIGHT_W();

	const leftOffsetPx = () => {
		if (!isMobile()) return 0;
		const base = sidebarOpen() ? 0 : -LEFT_HIDE();
		const d = drag();
		if (d?.side === 'left') {
			return Math.max(-LEFT_HIDE(), Math.min(0, base + d.px));
		}
		return base;
	};

	const rightOffsetPx = () => {
		if (!isMobile()) return 0;
		const base = membersOpen() ? 0 : RIGHT_HIDE();
		const d = drag();
		if (d?.side === 'right') {
			return Math.max(0, Math.min(RIGHT_HIDE(), base + d.px));
		}
		return base;
	};

	const contentOffsetPx = () => {
		if (!isMobile()) return 0;
		const leftOpenFrac = 1 + leftOffsetPx() / LEFT_HIDE();
		const rightOpenFrac = 1 - rightOffsetPx() / RIGHT_HIDE();
		return LEFT_W() * leftOpenFrac - RIGHT_W() * rightOpenFrac;
	};

	const transitionStyle = () =>
		drag() ? 'none' : 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)';

	const leftStyle = (): JSX.CSSProperties => {
		if (isMobile()) {
			return {
				transform: `translate3d(${leftOffsetPx()}px, 0, 0)`,
				transition: transitionStyle(),
			};
		}
		const hidden = sidebarCollapsed() && !sidebarPeeking();
		return {
			transform: hidden ? 'translate3d(calc(-100% - 1.5rem), 0, 0)' : 'translate3d(0, 0, 0)',
			transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
			'box-shadow':
				sidebarCollapsed() && sidebarPeeking()
					? '0 10px 40px rgba(0,0,0,0.18)'
					: '0 2px 10px rgba(0,0,0,0.04)',
		};
	};
	const rightStyle = (): JSX.CSSProperties => {
		if (isMobile()) {
			return {
				transform: `translate3d(${rightOffsetPx()}px, 0, 0)`,
				transition: transitionStyle(),
			};
		}
		const hidden = membersCollapsed() && !membersPeeking();
		return {
			transform: hidden ? 'translate3d(calc(100% + 1.5rem), 0, 0)' : 'translate3d(0, 0, 0)',
			transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
			'box-shadow':
				membersCollapsed() && membersPeeking()
					? '0 10px 40px rgba(0,0,0,0.18)'
					: '0 2px 10px rgba(0,0,0,0.04)',
		};
	};
	const contentStyle = (): JSX.CSSProperties => {
		if (isMobile()) {
			return {
				transform: `translate3d(${contentOffsetPx()}px, 0, 0)`,
				transition: transitionStyle(),
				'will-change': 'transform',
			};
		}
		const ease = '220ms cubic-bezier(0.32, 0.72, 0, 1)';
		return {
			transform: 'none',
			'margin-left': sidebarCollapsed() ? '0.75rem' : '19.25rem',
			'margin-right': !opts.hasMembers() || membersCollapsed() ? '0.75rem' : '17.25rem',
			transition: `margin-left ${ease}, margin-right ${ease}`,
		};
	};

	createEffect(() => {
		opts.currentChannelId();
		setSidebarOpen(false);
		setMembersOpen(false);
	});
	createEffect(() => {
		opts.currentServerId();
		setMembersOpen(false);
	});

	onMount(() => {
		const sync = () => {
			setVw(window.innerWidth);
			setIsMobile(window.innerWidth < 1024);
		};
		sync();
		window.addEventListener('resize', sync);
		onCleanup(() => window.removeEventListener('resize', sync));

		const onKey = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
			const key = e.key.toLowerCase();
			if (key === 'b') {
				e.preventDefault();
				if (isMobile()) {
					const next = !sidebarOpen();
					setSidebarOpen(next);
					if (next) setMembersOpen(false);
				} else {
					setSidebarCollapsed(!sidebarCollapsed());
				}
			} else if (key === 'u') {
				if (!opts.hasMembers()) return;
				e.preventDefault();
				if (isMobile()) {
					const next = !membersOpen();
					setMembersOpen(next);
					if (next) setSidebarOpen(false);
				} else {
					setMembersCollapsed(!membersCollapsed());
				}
			}
		};
		document.addEventListener('keydown', onKey);
		onCleanup(() => document.removeEventListener('keydown', onKey));

		let startX = 0;
		let startY = 0;
		let lastX = 0;
		let lastT = 0;
		let velocity = 0;
		let startTime = 0;
		let tracking = false;
		let decided = false;
		let side: 'left' | 'right' | null = null;

		const insideHScroll = (target: EventTarget | null): boolean => {
			let el = target as HTMLElement | null;
			while (el && el !== document.body) {
				const style = window.getComputedStyle(el);
				const ox = style.overflowX;
				if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) {
					return true;
				}
				el = el.parentElement;
			}
			return false;
		};

		const insideInteractive = (target: EventTarget | null): boolean => {
			let el = target as HTMLElement | null;
			while (el && el !== document.body) {
				const tag = el.tagName;
				if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
				if (el.isContentEditable) return true;
				el = el.parentElement;
			}
			return false;
		};

		const onStart = (e: TouchEvent) => {
			if (!isMobile()) return;
			if (e.touches.length !== 1) {
				tracking = false;
				return;
			}
			if (insideHScroll(e.target) || insideInteractive(e.target)) {
				tracking = false;
				return;
			}
			const tt = e.touches[0];
			startX = tt.clientX;
			startY = tt.clientY;
			lastX = startX;
			lastT = Date.now();
			velocity = 0;
			startTime = lastT;
			tracking = true;
			decided = false;
			side = null;
		};

		const onMove = (e: TouchEvent) => {
			if (!tracking || e.touches.length !== 1) return;
			const tt = e.touches[0];
			const dx = tt.clientX - startX;
			const dy = tt.clientY - startY;
			const adx = Math.abs(dx);
			const ady = Math.abs(dy);

			if (!decided && (adx > 8 || ady > 8)) {
				if (adx <= ady) {
					tracking = false;
					return;
				}
				decided = true;
				if (sidebarOpen()) side = 'left';
				else if (membersOpen()) side = 'right';
				else if (dx > 0) side = 'left';
				else side = opts.hasMembers() ? 'right' : null;
				if (!side) {
					tracking = false;
					return;
				}
			}
			if (!decided || !side) return;

			const now = Date.now();
			const ddx = tt.clientX - lastX;
			const ddt = Math.max(1, now - lastT);
			velocity = (ddx / ddt) * 0.5 + velocity * 0.5;
			lastX = tt.clientX;
			lastT = now;

			setDrag({ side, px: dx });
		};

		const onEnd = () => {
			if (!tracking) {
				setDrag(null);
				return;
			}
			tracking = false;
			const d = drag();
			if (!d || !side) {
				setDrag(null);
				return;
			}

			const dt = Date.now() - startTime;
			const flick = Math.abs(velocity) > 0.5 && dt < 500;

			if (side === 'left') {
				const opening = !sidebarOpen();
				const w = LEFT_HIDE();
				if (flick) {
					setSidebarOpen(velocity > 0);
				} else {
					const progress = opening ? d.px / w : 1 + d.px / w;
					setSidebarOpen(progress > 0.5);
				}
			} else {
				const opening = !membersOpen();
				const w = RIGHT_HIDE();
				if (flick) {
					setMembersOpen(velocity < 0);
				} else {
					const progress = opening ? -d.px / w : 1 - d.px / w;
					setMembersOpen(progress > 0.5);
				}
			}
			setDrag(null);
			side = null;
		};

		document.addEventListener('touchstart', onStart, { passive: true });
		document.addEventListener('touchmove', onMove, { passive: true });
		document.addEventListener('touchend', onEnd, { passive: true });
		document.addEventListener('touchcancel', onEnd, { passive: true });
		onCleanup(() => {
			document.removeEventListener('touchstart', onStart);
			document.removeEventListener('touchmove', onMove);
			document.removeEventListener('touchend', onEnd);
			document.removeEventListener('touchcancel', onEnd);
		});
	});

	const toggleSidebar = () => {
		if (!isMobile()) {
			setSidebarCollapsed(!sidebarCollapsed());
			return;
		}
		const next = !sidebarOpen();
		setSidebarOpen(next);
		if (next) setMembersOpen(false);
	};

	const toggleMembers = () => {
		if (!isMobile()) {
			setMembersCollapsed(!membersCollapsed());
			return;
		}
		const next = !membersOpen();
		setMembersOpen(next);
		if (next) setSidebarOpen(false);
	};

	return {
		sidebarOpen,
		setSidebarOpen,
		toggleSidebar,
		membersOpen,
		setMembersOpen,
		toggleMembers,
		sidebarCollapsed,
		setSidebarCollapsed,
		sidebarPeeking,
		setSidebarPeeking,
		membersCollapsed,
		setMembersCollapsed,
		membersPeeking,
		setMembersPeeking,
		leftStyle,
		rightStyle,
		contentStyle,
		isMobile,
		drag,
	};
}
