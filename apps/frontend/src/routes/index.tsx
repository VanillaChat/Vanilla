import { createFileRoute, Link, redirect } from '@tanstack/solid-router';
import { createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { getSession } from '../api/auth';
import { t } from '../i18n';
import { isDesktop } from '../state/presence';
import { session } from '../state/session';

export const Route = createFileRoute('/')({
	// The desktop app is the product itself: no landing page, straight to the app or sign-in.
	beforeLoad: async () => {
		if (!isDesktop()) return;
		const signedIn = await getSession().then(
			() => true,
			() => false,
		);
		throw redirect({ to: signedIn ? '/app' : '/login', replace: true });
	},
	component: Home,
});

function Home() {
	return (
		<div class="-mt-24 pt-24 bg-[#fdfaf3] dark:bg-[#171411] text-stone-900 dark:text-stone-100 overflow-x-clip">
			<Hero />
			<Features />
			<Stage panels={[BuiltForSmall, OpenSource, FinalCta]} />
			<Footer />
		</div>
	);
}

function Hero() {
	return (
		<section class="relative px-6 lg:px-12 pt-20 lg:pt-32 pb-24 lg:pb-40">
			<div class="relative max-w-6xl mx-auto">
				<div class="max-w-3xl mx-auto text-center">
					<h1 class="font-display tracking-tight leading-[1.1] font-semibold text-5xl sm:text-6xl lg:text-7xl">
						{t('home-headline-a')}
						<br />
						<span class="text-stone-500 dark:text-stone-400">{t('home-headline-b')}</span>
					</h1>

					<p class="mt-8 text-lg lg:text-xl leading-relaxed max-w-xl mx-auto text-stone-600 dark:text-stone-300">
						{t('home-sub')}
					</p>

					<div class="mt-10 flex flex-wrap items-center justify-center gap-3">
						<Show
							when={session()}
							fallback={
								<>
									<Link
										to="/register"
										class="group inline-flex items-center gap-2 bg-[#f7e26c] text-stone-900 px-6 py-3 rounded-full text-sm font-medium hover:shadow-lg hover:shadow-[#f7e26c]/40 transition-shadow"
									>
										{t('home-cta-primary')}
										<span class="transition-transform group-hover:translate-x-0.5">→</span>
									</Link>
									<Link
										to="/login"
										class="inline-flex items-center px-6 py-3 rounded-full text-sm font-medium border border-stone-300 dark:border-stone-700 hover:bg-stone-900/5 dark:hover:bg-white/5 transition-colors"
									>
										{t('home-cta-secondary')}
									</Link>
								</>
							}
						>
							<Link
								to="/app"
								class="group inline-flex items-center gap-2 bg-[#f7e26c] text-stone-900 px-6 py-3 rounded-full text-sm font-medium hover:shadow-lg hover:shadow-[#f7e26c]/40 transition-shadow"
							>
								{t('home-cta-open')}
								<span class="transition-transform group-hover:translate-x-0.5">→</span>
							</Link>
						</Show>
					</div>
				</div>
			</div>
		</section>
	);
}

function Features() {
	const items = [
		{
			icon: 'fa-comments',
			title: t('home-feature-rooms-title'),
			body: t('home-feature-rooms-body'),
		},
		{
			icon: 'fa-microphone',
			title: t('home-feature-voice-title'),
			body: t('home-feature-voice-body'),
		},
		{
			icon: 'fa-lock',
			title: t('home-feature-private-title'),
			body: t('home-feature-private-body'),
		},
	];

	return (
		<section class="px-6 lg:px-12 py-20 lg:py-28 border-t border-stone-200/70 dark:border-stone-800/70">
			<div class="max-w-6xl mx-auto grid md:grid-cols-3 gap-10 lg:gap-16">
				<For each={items}>
					{(it) => (
						<article>
							<i class={`fa-solid ${it.icon} text-lg text-stone-500 dark:text-stone-400`} />
							<h3 class="font-display text-xl font-semibold tracking-tight mt-4">{it.title}</h3>
							<p class="mt-3 text-stone-600 dark:text-stone-300 leading-relaxed">{it.body}</p>
						</article>
					)}
				</For>
			</div>
		</section>
	);
}

/**
 * Pins one viewport and cross-fades its panels while the page scrolls, so the
 * page seems to keep its height until the last panel is reached.
 */
function Stage(props: { panels: (() => JSX.Element)[] }) {
	const n = props.panels.length;
	const [raw, setRaw] = createSignal(0);
	const [reduced, setReduced] = createSignal(false);
	let container: HTMLDivElement | undefined;
	let frame = 0;

	const update = () => {
		frame = 0;
		if (!container) return;
		const rect = container.getBoundingClientRect();
		const total = rect.height - window.innerHeight;
		const p = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
		setRaw(p * (n - 1));
	};
	const onScroll = () => {
		if (!frame) frame = requestAnimationFrame(update);
	};

	onMount(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
		setReduced(mq.matches);
		update();
		window.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);
	});
	onCleanup(() => {
		window.removeEventListener('scroll', onScroll);
		window.removeEventListener('resize', onScroll);
		if (frame) cancelAnimationFrame(frame);
	});

	const opacity = (i: number) => Math.min(1, Math.max(0, 1 - (Math.abs(raw() - i) - 0.15) / 0.35));

	return (
		<Show
			when={!reduced()}
			fallback={
				<For each={props.panels}>
					{(Panel) => (
						<section class="px-6 lg:px-12 py-20 border-t border-stone-200/70 dark:border-stone-800/70">
							<div class="max-w-6xl mx-auto text-center">
								<Panel />
							</div>
						</section>
					)}
				</For>
			}
		>
			<div
				ref={container}
				class="relative border-t border-stone-200/70 dark:border-stone-800/70"
				style={{ height: `${n * 100}svh` }}
			>
				<div class="sticky top-0 h-[100svh] overflow-hidden">
					<For each={props.panels}>
						{(Panel, i) => (
							<div
								class="absolute inset-0 px-6 lg:px-12 pb-24 flex items-center will-change-[opacity,transform]"
								style={{
									opacity: opacity(i()),
									transform: `translateY(${(i() - raw()) * 48}px)`,
									'pointer-events': opacity(i()) > 0.5 ? 'auto' : 'none',
								}}
								aria-hidden={opacity(i()) < 0.5}
							>
								<div class="max-w-6xl mx-auto w-full text-center">
									<Panel />
								</div>
							</div>
						)}
					</For>
				</div>
			</div>
		</Show>
	);
}

function BuiltForSmall() {
	return (
		<div>
			<h2 class="font-display font-semibold text-3xl lg:text-5xl tracking-tight leading-tight lg:whitespace-nowrap">
				{t('home-section-built-title')}
			</h2>
			<p class="mt-6 max-w-2xl mx-auto text-lg lg:text-xl text-stone-600 dark:text-stone-300 leading-relaxed">
				{t('home-section-built-body')}
			</p>
		</div>
	);
}

function OpenSource() {
	return (
		<div>
			<h2 class="font-display font-semibold text-3xl lg:text-5xl tracking-tight leading-tight lg:whitespace-nowrap">
				{t('home-oss-title')}
			</h2>
			<p class="mt-6 max-w-2xl mx-auto text-lg lg:text-xl text-stone-600 dark:text-stone-300 leading-relaxed">
				{t('home-oss-body')}
			</p>
			<a
				href="https://github.com/VanillaChat"
				target="_blank"
				rel="noreferrer"
				class="mt-8 inline-flex items-center gap-2 border border-stone-300 dark:border-stone-700 px-6 py-3 rounded-full text-sm font-medium hover:bg-stone-900/5 dark:hover:bg-white/5 transition-colors"
			>
				<i class="fa-brands fa-github" />
				{t('home-oss-cta')}
			</a>
		</div>
	);
}

function FinalCta() {
	return (
		<div>
			<h2 class="font-display font-semibold text-4xl lg:text-7xl tracking-tight leading-[1.1]">
				{t('home-final-headline')}
			</h2>
			<p class="mt-5 text-lg lg:text-xl max-w-xl mx-auto text-stone-600 dark:text-stone-300">
				{t('home-final-sub')}
			</p>
			<Link
				to="/register"
				class="mt-10 inline-flex items-center gap-2 bg-[#f7e26c] text-stone-900 px-7 py-4 rounded-full text-sm font-medium hover:shadow-lg hover:shadow-[#f7e26c]/40 transition-shadow"
			>
				{t('home-final-cta')}
				<span>→</span>
			</Link>
		</div>
	);
}

function Footer() {
	return (
		<footer class="px-6 lg:px-12 py-10 border-t border-stone-200/70 dark:border-stone-800/70">
			<div class="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4 text-sm text-stone-500 dark:text-stone-400">
				<div class="flex items-center gap-3">
					<span
						aria-label={t('brand-name')}
						class="block h-5 w-24 bg-stone-500 dark:bg-stone-400"
						style={{
							mask: 'url(/VanillaLogo.svg) left center / contain no-repeat',
							'-webkit-mask': 'url(/VanillaLogo.svg) left center / contain no-repeat',
						}}
					/>
				</div>
				<div class="flex items-center gap-5">
					<Link
						to="/login"
						class="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
					>
						sign in
					</Link>
					<Link
						to="/register"
						class="hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
					>
						register
					</Link>
				</div>
			</div>
		</footer>
	);
}
