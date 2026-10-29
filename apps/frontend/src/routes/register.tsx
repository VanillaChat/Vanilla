import { createFileRoute, Link, useNavigate } from '@tanstack/solid-router';
import { createSignal, Show } from 'solid-js';
import { register } from '../api/auth';
import { ApiError } from '../api/client';

export const Route = createFileRoute('/register')({
	component: RegisterPage,
});

function RegisterPage() {
	const navigate = useNavigate();
	const [username, setUsername] = createSignal('');
	const [email, setEmail] = createSignal('');
	const [password, setPassword] = createSignal('');
	const [confirmPassword, setConfirmPassword] = createSignal('');
	const [inviteCode, setInviteCode] = createSignal(
		new URLSearchParams(window.location.search).get('invite') ?? '',
	);
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);

	const onSubmit = async (e: Event) => {
		e.preventDefault();
		setError(null);

		if (password() !== confirmPassword()) {
			setError("Passwords don't match");
			return;
		}

		setSubmitting(true);
		try {
			await register({
				email: email(),
				password: password(),
				confirmPassword: confirmPassword(),
				username: username(),
				inviteCode: inviteCode().trim() || undefined,
			});
			navigate({ to: '/app' });
		} catch (err) {
			const msg =
				err instanceof ApiError
					? err.message
					: err instanceof Error
						? err.message
						: 'Registration failed';
			setError(msg);
		} finally {
			setSubmitting(false);
		}
	};

	const inputClass =
		'w-full rounded-full bg-white dark:bg-white/5 border border-stone-200 dark:border-stone-800 px-5 py-3 text-sm outline-none focus:border-stone-400 dark:focus:border-stone-500 transition-colors placeholder:text-stone-400 dark:placeholder:text-stone-600';

	return (
		<div class="-mt-24 grid lg:grid-cols-2 min-h-[calc(100dvh-var(--titlebar,0px))]">
			<aside class="bg-[#f7e26c] text-stone-900 px-8 lg:px-16 pt-32 pb-12 lg:py-24 flex flex-col justify-center">
				<div class="max-w-md">
					<div class="flex items-center">
						<img src="/VanillaLogo.svg" alt="" class="w-64 mb-8 rounded-lg text-[#2b1d12]" />
					</div>
					<h1 class="font-display text-5xl lg:text-[3.75rem] tracking-tight leading-[1.05] mb-6">
						Where simplicity and privacy meet.
					</h1>
					<p class="font-sans text-lg leading-relaxed opacity-80">
						Group chats without the noise. Voice that just works.
					</p>
				</div>
			</aside>

			<section class="bg-[#fdfaf3] dark:bg-[#171411] px-8 lg:px-16 py-16 lg:py-24 flex items-center">
				<div class="w-full max-w-sm mx-auto">
					<h2 class="font-display text-4xl tracking-tight text-stone-900 dark:text-stone-100 mb-2">
						Join Vanilla.
					</h2>
					<p class="font-sans text-sm text-stone-500 dark:text-stone-400 mb-10">
						Make an account to get started.
					</p>

					<form onSubmit={onSubmit} class="space-y-4">
						<input
							type="text"
							required
							placeholder="username"
							value={username()}
							onInput={(e) => setUsername(e.currentTarget.value)}
							class={inputClass}
						/>
						<input
							type="email"
							required
							placeholder="email"
							value={email()}
							onInput={(e) => setEmail(e.currentTarget.value)}
							class={inputClass}
						/>
						<input
							type="password"
							required
							minLength={8}
							placeholder="password"
							value={password()}
							onInput={(e) => setPassword(e.currentTarget.value)}
							class={inputClass}
						/>
						<input
							type="password"
							required
							minLength={8}
							placeholder="confirm password"
							value={confirmPassword()}
							onInput={(e) => setConfirmPassword(e.currentTarget.value)}
							class={inputClass}
						/>
						<input
							type="text"
							placeholder="invite code (optional)"
							value={inviteCode()}
							onInput={(e) => setInviteCode(e.currentTarget.value)}
							class={inputClass}
						/>

						<Show when={error()}>
							<div class="text-sm text-red-600 dark:text-red-400 px-2">{error()}</div>
						</Show>

						<button
							type="submit"
							disabled={submitting()}
							class="w-full bg-vault text-stone-900 px-6 py-3 rounded-full text-sm font-medium hover:shadow-md hover:shadow-vault/40 transition-shadow disabled:opacity-60 disabled:cursor-not-allowed"
						>
							{submitting() ? 'Creating…' : 'Create account'}
						</button>
					</form>

					<p class="mt-8 text-center text-sm text-stone-500 dark:text-stone-400">
						Already have one?{' '}
						<Link to="/login" class="text-stone-900 dark:text-white underline underline-offset-4">
							Sign in
						</Link>
					</p>
				</div>
			</section>
		</div>
	);
}
