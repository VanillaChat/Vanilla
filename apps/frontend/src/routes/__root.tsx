import { createRootRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/solid-router';
import { TanStackRouterDevtools } from '@tanstack/solid-router-devtools';
import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import { logout, type Session } from '../api/auth';
import { TitleBar } from '../components/app/TitleBar';
import { DefaultAvatar } from '../components/ui/DefaultAvatar';
import { isDesktop } from '../state/presence';
import { refetchSession, session } from '../state/session';
import { voiceSettings } from '../voice/settings';

export const Route = createRootRoute({
	component: RootComponent,
	notFoundComponent: () => {
		return (
			<div>
				<p>This is the notFoundComponent configured on root route</p>
				<Link to="/">Start Over</Link>
			</div>
		);
	},
});

function useContextMenuGuard() {
	onMount(() => {
		const handler = (e: MouseEvent) => {
			if (e.defaultPrevented || voiceSettings().developerMode) return;
			const target = e.target as HTMLElement | null;
			// Text fields keep copy and paste.
			if (target?.closest('input, textarea, [contenteditable="true"]')) return;
			e.preventDefault();
		};
		document.addEventListener('contextmenu', handler);
		onCleanup(() => document.removeEventListener('contextmenu', handler));
	});
}

function RootComponent() {
	useContextMenuGuard();
	const routerState = useRouterState();
	const isApp = () => routerState().location.pathname.startsWith('/app');
	// The desktop app has no site navigation: it is the product, not the marketing page.
	const showNav = () => !isApp() && !isDesktop();
	const isSplash = () => routerState().location.pathname === '/updater';

	return (
		<Show when={!isSplash()} fallback={<Outlet />}>
			<Show when={isDesktop()}>
				<TitleBar solid={isApp()} />
			</Show>
			<Show when={showNav()}>
				<nav class="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[min(72rem,calc(100%-3rem))] lg:w-[min(72rem,calc(100%-6rem))] flex items-center justify-between px-4 py-2.5 rounded-lg border border-stone-200 dark:border-stone-800 bg-[#fdfaf3]/80 dark:bg-[#171411]/80 backdrop-blur-md shadow-lg shadow-black/5">
					<div class="flex items-center gap-5">
						<Link to="/" class="flex items-center" aria-label="Vanilla">
							<span
								class="block h-6 w-28 bg-white"
								style={{
									mask: 'url(/VanillaLogo.svg) left center / contain no-repeat',
									'-webkit-mask': 'url(/VanillaLogo.svg) left center / contain no-repeat',
								}}
							/>
						</Link>
						<a
							href="https://github.com/VanillaChat/Vauler"
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-white transition-colors"
						>
							<i class="fa-brands fa-github text-base" />
							GitHub
						</a>
						<a
							href="https://discord.gg/mXZZzSHGnR"
							target="_blank"
							rel="noreferrer"
							class="inline-flex items-center gap-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-white transition-colors"
						>
							<i class="fa-brands fa-discord text-base" />
							Discord
						</a>
					</div>
					<div class="flex items-center gap-2">
						<Show
							when={session()}
							fallback={
								<>
									<Link
										to="/login"
										class="px-3 py-1.5 rounded-md text-sm transition-colors hover:bg-stone-900/5 dark:hover:bg-white/5"
									>
										Login
									</Link>
									<Link
										to="/register"
										class="px-3 py-1.5 rounded-md text-sm font-medium text-gray-900 bg-[#f7e26c] hover:opacity-90 transition-opacity"
									>
										Register
									</Link>
								</>
							}
						>
							{(s) => <SessionMenu session={s()} onLogout={() => refetchSession()} />}
						</Show>
					</div>
				</nav>
			</Show>
			{/* Kept without the nav too: the pages pull themselves up by the same 6rem. */}
			<main class={`mt-[var(--titlebar,0px)] ${isApp() ? '' : 'pt-24'}`}>
				<Outlet />
			</main>
			<Show when={!isDesktop()}>
				<TanStackRouterDevtools position="bottom-right" />
			</Show>
		</Show>
	);
}

function SessionMenu(props: { session: Session; onLogout: () => void }) {
	const [open, setOpen] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const navigate = useNavigate();
	let wrapperRef: HTMLDivElement | undefined;

	const onDocClick = (e: MouseEvent) => {
		if (!wrapperRef) return;
		if (!wrapperRef.contains(e.target as Node)) setOpen(false);
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') setOpen(false);
	};

	onMount(() => {
		document.addEventListener('mousedown', onDocClick);
		document.addEventListener('keydown', onKey);
	});
	onCleanup(() => {
		document.removeEventListener('mousedown', onDocClick);
		document.removeEventListener('keydown', onKey);
	});

	const handleLogout = async () => {
		if (busy()) return;
		setBusy(true);
		try {
			await logout();
		} catch {
			/* ignore */
		} finally {
			setBusy(false);
			setOpen(false);
			props.onLogout();
		}
	};

	const handleOpenApp = () => {
		setOpen(false);
		navigate({ to: '/app' });
	};

	return (
		<div class="relative" ref={wrapperRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open()}
				class="flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-full text-sm transition-colors hover:bg-stone-900/5 dark:hover:bg-white/5"
			>
				<span
					class="w-7 h-7 rounded-full grid place-items-center font-display text-stone-900 bg-[#f7e26c] overflow-hidden"
					aria-hidden="true"
				>
					{props.session.user.avatar ? (
						<img src={props.session.user.avatar} alt="" class="w-full h-full object-cover" />
					) : (
						<DefaultAvatar id={props.session.user.id} />
					)}
				</span>
				<span class="font-medium">{props.session.user.username}</span>
				<i
					class={`fa-solid fa-chevron-down text-[10px] opacity-60 transition-transform ${open() ? 'rotate-180' : ''}`}
				/>
			</button>

			<Show when={open()}>
				<div
					role="menu"
					class="absolute right-0 top-[calc(100%+0.5rem)] w-60 origin-top-right rounded-xl border border-stone-200 dark:border-stone-800 bg-[#fdfaf3] dark:bg-[#171411] shadow-xl shadow-black/10 overflow-hidden animate-menu-in"
				>
					<div class="px-4 py-3 border-b border-stone-200 dark:border-stone-800">
						<div class="text-sm font-medium truncate">{props.session.user.username}</div>
						<div class="text-xs text-stone-500 dark:text-stone-400 truncate">
							{props.session.account.email}
						</div>
					</div>
					<button
						type="button"
						role="menuitem"
						onClick={handleOpenApp}
						class="w-full flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-stone-900/5 dark:hover:bg-white/5 transition-colors"
					>
						<i class="fa-solid fa-arrow-right-to-bracket w-4 text-stone-500" />
						Open Vanilla
					</button>
					<button
						type="button"
						role="menuitem"
						disabled={busy()}
						onClick={handleLogout}
						class="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-60"
					>
						<i class="fa-solid fa-right-from-bracket w-4" />
						{busy() ? 'Logging out…' : 'Logout'}
					</button>
				</div>
			</Show>
		</div>
	);
}
