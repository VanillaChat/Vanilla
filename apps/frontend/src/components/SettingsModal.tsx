import { useNavigate } from '@tanstack/solid-router';
import { createSignal, For, type JSX, onCleanup, onMount, Show } from 'solid-js';
import { logout } from '../api/auth';
import { ApiError } from '../api/client';
import { type DmPrivacy, disconnect, ready } from '../api/gateway';
import { type ImageKind, MAX_IMAGE_BYTES, updateProfile, uploadProfileImage } from '../api/profile';
import { updateDmPrivacy } from '../api/settings';
import { t } from '../i18n';
import { avatarBackdrop } from '../state/default-avatar';
import { prefs, updatePrefs } from '../state/prefs';
import { isDesktop } from '../state/presence';
import { setUpdateSimulation } from '../state/updater';
import { updateVoiceSettings, voiceSettings } from '../voice/settings';
import { UpdatesPanel } from './UpdatesPanel';
import { Checkbox } from './ui/Checkbox';
import { DefaultAvatar } from './ui/DefaultAvatar';
import { Select } from './ui/Select';
import { InfoTip } from './ui/Tooltip';
import { VoiceSettingsPanel } from './voice/VoiceSettingsPanel';

type Section =
	| 'account'
	| 'profile'
	| 'appearance'
	| 'privacy'
	| 'voice'
	| 'updates'
	| 'advanced'
	| 'danger';

type SectionDef = { id: Section; labelKey: string; icon: string };

const SECTIONS: SectionDef[] = [
	{ id: 'account', labelKey: 'settings-account', icon: 'fa-user' },
	{ id: 'profile', labelKey: 'settings-profile', icon: 'fa-id-card' },
	{ id: 'appearance', labelKey: 'settings-appearance', icon: 'fa-palette' },
	{ id: 'privacy', labelKey: 'settings-privacy', icon: 'fa-shield-halved' },
	{ id: 'voice', labelKey: 'settings-voice', icon: 'fa-microphone' },
	{ id: 'updates', labelKey: 'settings-updates', icon: 'fa-download' },
	{ id: 'advanced', labelKey: 'settings-advanced', icon: 'fa-code' },
	{ id: 'danger', labelKey: 'settings-danger', icon: 'fa-triangle-exclamation' },
];

const THEME_KEYS: Record<'LIGHT' | 'DIM' | 'DARK', string> = {
	LIGHT: 'settings-theme-light',
	DIM: 'settings-theme-dim',
	DARK: 'settings-theme-dark',
};

const DM_PRIVACY_KEYS: Record<DmPrivacy, string> = {
	EVERYONE: 'settings-dm-everyone',
	SHARED_SERVERS: 'settings-dm-shared',
	FRIENDS: 'settings-dm-friends',
};

const DM_PRIVACY_HINTS: Record<DmPrivacy, string> = {
	EVERYONE: 'settings-dm-hint-everyone',
	SHARED_SERVERS: 'settings-dm-hint-shared',
	FRIENDS: 'settings-dm-hint-friends',
};

const inputClass =
	'w-full rounded-xl bg-[#fdfaf3] dark:bg-stone-900 border border-stone-200 dark:border-stone-800 px-4 py-2.5 text-sm outline-none focus:border-stone-400 dark:focus:border-stone-600 transition-colors placeholder:text-stone-400 dark:placeholder:text-stone-600';

export function SettingsModal(props: {
	onClose: () => void;
	closing?: boolean;
	initialSection?: Section;
}) {
	const [section, setSection] = createSignal<Section>(props.initialSection ?? 'account');
	const navigate = useNavigate();

	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === 'Escape') props.onClose();
		};
		document.addEventListener('keydown', handler);
		onCleanup(() => document.removeEventListener('keydown', handler));
	});

	const r = ready;
	const me = () => r()?.user;
	const account = () => r()?.account;
	const settings = () => r()?.settings;

	const [bio, setBio] = createSignal('');
	const [avatar, setAvatar] = createSignal('');
	const [banner, setBanner] = createSignal('');
	const [theme, setTheme] = createSignal<'LIGHT' | 'DARK' | 'DIM'>('LIGHT');
	const [compact, setCompact] = createSignal(false);
	const [showAvatars, setShowAvatars] = createSignal(true);

	const [dmPrivacy, setDmPrivacy] = createSignal<DmPrivacy>(
		settings()?.dmPrivacy ?? 'SHARED_SERVERS',
	);
	const changeDmPrivacy = async (next: DmPrivacy) => {
		const before = dmPrivacy();
		setErr(null);
		setDmPrivacy(next);
		try {
			await updateDmPrivacy(next);
		} catch {
			setDmPrivacy(before);
			setErr(t('settings-privacy-error'));
		}
	};

	const [savingProfile, setSavingProfile] = createSignal(false);
	const saveProfile = async () => {
		setErr(null);
		setSavingProfile(true);
		try {
			await updateProfile({ bio: bio() });
		} catch (e) {
			setErr(e instanceof ApiError ? e.message : t('settings-profile-error'));
		} finally {
			setSavingProfile(false);
		}
	};

	const [loggingOut, setLoggingOut] = createSignal(false);
	const [err, setErr] = createSignal<string | null>(null);

	const u = me();
	if (u) {
		setBio(u.bio ?? '');
		setAvatar(u.avatar ?? '');
		setBanner(u.banner ?? '');
	}
	const initialSettings = settings();
	if (initialSettings) {
		setTheme(initialSettings.theme);
		setCompact(initialSettings.compactMode);
		setShowAvatars(initialSettings.compactShowAvatars);
	}

	const onLogout = async () => {
		setErr(null);
		setLoggingOut(true);
		try {
			await logout();
			disconnect();
			navigate({ to: '/login' });
		} catch (e) {
			setErr(
				e instanceof ApiError
					? e.message
					: e instanceof Error
						? e.message
						: t('settings-logout-error'),
			);
		} finally {
			setLoggingOut(false);
		}
	};

	return (
		<>
			<div
				class={`fixed inset-0 z-50 bg-stone-900/40 backdrop-blur-sm ${
					props.closing ? 'animate-fade-out' : 'animate-fade-in'
				}`}
				onClick={props.onClose}
			/>
			<div class="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6 pointer-events-none">
				<div
					class={`pointer-events-auto w-full max-w-4xl h-dvh sm:h-[80dvh] rounded-none sm:rounded-3xl bg-[#fdfaf3] dark:bg-[#1a1816] shadow-2xl shadow-black/20 overflow-hidden flex flex-col sm:flex-row ${
						props.closing ? 'animate-popover-out' : 'animate-popover-in'
					}`}
				>
					<aside class="w-full sm:w-56 shrink-0 bg-[#f5efe1] dark:bg-[#211e1b] flex sm:flex-col gap-1 px-3 py-3 sm:py-5 border-b sm:border-b-0 sm:border-r border-stone-200 dark:border-stone-800 overflow-x-auto sm:overflow-visible">
						<div class="hidden sm:block px-3 mb-3">
							<h2 class="font-display text-2xl">{t('settings-title')}</h2>
						</div>
						<For each={SECTIONS.filter((item) => item.id !== 'updates' || isDesktop())}>
							{(item) => (
								<button
									onClick={() => setSection(item.id)}
									class={`shrink-0 sm:w-full flex items-center gap-2 sm:gap-3 px-3 py-2 rounded-xl text-sm text-left ${
										section() === item.id
											? 'bg-[#f7e26c] text-stone-900 font-medium'
											: 'text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800/40 hover:text-stone-900 dark:hover:text-stone-100'
									}`}
								>
									<i class={`fa-solid ${item.icon} w-4 text-center text-xs opacity-70`} />
									<span>{t(item.labelKey)}</span>
								</button>
							)}
						</For>
					</aside>

					<main class="flex-1 min-w-0 overflow-y-auto relative">
						<button
							onClick={props.onClose}
							class="absolute top-3 right-3 sm:top-4 sm:right-5 w-9 h-9 rounded-full bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 text-stone-600 dark:text-stone-300 flex items-center justify-center z-10"
							title={t('settings-close')}
						>
							<i class="fa-solid fa-xmark" />
						</button>

						<div class="max-w-2xl mx-auto px-5 sm:px-8 py-6 sm:py-10">
							<Show when={section() === 'account'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-account')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-account-sub')}
								</p>
								<Field label={t('settings-username')}>
									<input class={inputClass} value={me()?.username ?? ''} readonly />
								</Field>
								<Field label={t('settings-tag')}>
									<input class={inputClass} value={me()?.tag ?? ''} readonly />
								</Field>
								<Field label={t('settings-email')}>
									<input class={inputClass} value={account()?.email ?? ''} readonly />
								</Field>
								<Field label={t('settings-email-verified')}>
									<input
										class={inputClass}
										value={account()?.emailVerified ?? 'unknown'}
										readonly
									/>
								</Field>
								<Field label={t('settings-locale')}>
									<input class={inputClass} value={account()?.locale ?? ''} readonly />
								</Field>
								<Field label={t('settings-user-id')}>
									<input
										class={`${inputClass} font-mono text-xs`}
										value={me()?.id ?? ''}
										readonly
									/>
								</Field>
							</Show>

							<Show when={section() === 'profile'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-profile')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-profile-sub')}
								</p>
								<Field label={t('settings-avatar')}>
									<div class="flex items-center gap-4">
										<div
											class="w-16 h-16 rounded-full overflow-hidden shrink-0 grid place-items-center"
											style={{ 'background-color': avatarBackdrop(me()?.id ?? '', !!me()?.avatar) }}
										>
											<Show when={me()?.avatar} fallback={<DefaultAvatar id={me()?.id ?? ''} />}>
												{(src) => <img src={src()} alt="" class="w-full h-full object-cover" />}
											</Show>
										</div>
										<ImagePicker kind="avatar" hasImage={!!me()?.avatar} onError={setErr} />
									</div>
								</Field>
								<Field label={t('settings-banner')}>
									<div
										class="h-24 w-full rounded-xl bg-stone-200 dark:bg-stone-800 bg-cover bg-center mb-2"
										style={me()?.banner ? { 'background-image': `url(${me()?.banner})` } : {}}
									/>
									<ImagePicker kind="banner" hasImage={!!me()?.banner} onError={setErr} />
								</Field>
								<Field label={t('settings-bio')}>
									<textarea
										rows={4}
										maxLength={190}
										placeholder={t('settings-bio-placeholder')}
										value={bio()}
										onInput={(e) => setBio(e.currentTarget.value)}
										class={`${inputClass} resize-none`}
									/>
								</Field>
								<Show when={err()}>
									<p class="mb-3 text-sm text-red-600 dark:text-red-400">{err()}</p>
								</Show>
								<div class="mt-6 flex gap-2">
									<button
										type="button"
										disabled={savingProfile() || bio() === (me()?.bio ?? '')}
										onClick={saveProfile}
										class="px-5 py-2.5 rounded-xl text-sm font-medium bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow disabled:opacity-50"
									>
										{t('settings-save-changes')}
									</button>
								</div>
							</Show>

							<Show when={section() === 'appearance'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-appearance')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-appearance-sub')}
								</p>
								<Field label={t('settings-theme')}>
									<div class="flex gap-2">
										<For each={['LIGHT', 'DIM', 'DARK'] as const}>
											{(themeId) => (
												<button
													onClick={() => setTheme(themeId)}
													class={`flex-1 px-4 py-3 rounded-xl text-sm font-medium border ${
														theme() === themeId
															? 'bg-[#f7e26c] text-stone-900 border-[#f7e26c]'
															: 'bg-stone-100 dark:bg-stone-800 border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700'
													}`}
												>
													{t(THEME_KEYS[themeId])}
												</button>
											)}
										</For>
									</div>
								</Field>
								<ToggleField
									label={t('settings-compact-mode')}
									hint={t('settings-compact-mode-hint')}
									value={compact()}
									onChange={setCompact}
								/>
								<ToggleField
									label={t('settings-show-avatars')}
									hint={t('settings-show-avatars-hint')}
									value={showAvatars()}
									onChange={setShowAvatars}
								/>
								<ToggleField
									label={t('settings-live-formatting')}
									hint={t('settings-live-formatting-hint')}
									value={prefs().liveFormatting}
									onChange={(v) => updatePrefs({ liveFormatting: v })}
								/>
								<ToggleField
									label={t('settings-ping-sound')}
									hint={t('settings-ping-sound-hint')}
									value={prefs().pingSound}
									onChange={(v) => updatePrefs({ pingSound: v })}
								/>
								<Show when={isDesktop()}>
									<ToggleField
										label={t('settings-discord-presence')}
										hint={t('settings-discord-presence-hint')}
										value={prefs().discordPresence}
										onChange={(v) => updatePrefs({ discordPresence: v })}
									/>
								</Show>
								<div class="mt-6 flex gap-2">
									<button class="px-5 py-2.5 rounded-xl text-sm font-medium bg-[#f7e26c] text-stone-900 hover:shadow-md hover:shadow-[#f7e26c]/40 transition-shadow">
										{t('settings-save-prefs')}
									</button>
								</div>
							</Show>

							<Show when={section() === 'privacy'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-privacy')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-privacy-sub')}
								</p>
								<Field label={t('settings-dm-who')} tip={t('settings-dm-who-tip')}>
									<Select
										options={(Object.keys(DM_PRIVACY_KEYS) as DmPrivacy[]).map((value) => ({
											value,
											label: t(DM_PRIVACY_KEYS[value]),
										}))}
										value={dmPrivacy()}
										onChange={changeDmPrivacy}
									/>
									<p class="mt-2 text-xs text-stone-500">{t(DM_PRIVACY_HINTS[dmPrivacy()])}</p>
								</Field>
								<Show when={err()}>
									<p class="mt-3 text-sm text-red-600">{err()}</p>
								</Show>
							</Show>

							<Show when={section() === 'voice'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-voice')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-voice-sub')}
								</p>
								<VoiceSettingsPanel />
							</Show>

							<Show when={section() === 'updates'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-updates')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-updates-sub')}
								</p>
								<UpdatesPanel />
							</Show>

							<Show when={section() === 'advanced'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-advanced')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-advanced-sub')}
								</p>
								<Checkbox
									label={t('settings-developer-mode')}
									hint={t('settings-developer-mode-hint')}
									checked={voiceSettings().developerMode}
									onChange={(v) => {
										updateVoiceSettings({ developerMode: v });
										if (!v && prefs().simulateUpdate) {
											updatePrefs({ simulateUpdate: false });
											setUpdateSimulation(false);
										}
									}}
								/>
								<Show when={voiceSettings().developerMode && isDesktop()}>
									<Checkbox
										label={t('settings-simulate-update')}
										hint={t('settings-simulate-update-hint')}
										checked={prefs().simulateUpdate}
										onChange={(v) => {
											updatePrefs({ simulateUpdate: v });
											setUpdateSimulation(v);
										}}
									/>
								</Show>
							</Show>

							<Show when={section() === 'danger'}>
								<h3 class="font-display text-3xl mb-1">{t('settings-danger')}</h3>
								<p class="text-sm text-stone-500 italic font-display mb-8">
									{t('settings-danger-sub')}
								</p>

								<div class="rounded-xl border border-stone-200 dark:border-stone-800 p-5 mb-4">
									<h4 class="font-display text-lg mb-1">{t('settings-logout-title')}</h4>
									<p class="text-sm text-stone-500 mb-3">{t('settings-logout-sub')}</p>
									<button
										onClick={onLogout}
										disabled={loggingOut()}
										class="px-4 py-2 rounded-xl text-sm font-medium bg-stone-100 dark:bg-stone-800 border border-stone-300 dark:border-stone-700 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-60"
									>
										{loggingOut() ? t('settings-logging-out') : t('settings-logout')}
									</button>
								</div>

								<div class="rounded-xl border border-red-300 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20 p-5">
									<h4 class="font-display text-lg text-red-700 dark:text-red-400 mb-1">
										{t('settings-delete-title')}
									</h4>
									<p class="text-sm text-stone-500 mb-3">{t('settings-delete-sub')}</p>
									<button class="px-4 py-2 rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-700">
										{t('settings-delete-btn')}
									</button>
								</div>

								<Show when={err()}>
									<div class="mt-4 text-sm text-red-600 dark:text-red-400">{err()}</div>
								</Show>
							</Show>
						</div>
					</main>
				</div>
			</div>
		</>
	);
}

function ImagePicker(props: {
	kind: ImageKind;
	hasImage: boolean;
	onError: (message: string | null) => void;
}) {
	const [busy, setBusy] = createSignal(false);
	let input: HTMLInputElement | undefined;

	const run = async (job: () => Promise<unknown>) => {
		props.onError(null);
		setBusy(true);
		try {
			await job();
		} catch (e) {
			props.onError(e instanceof ApiError ? e.message : t('settings-profile-error'));
		} finally {
			setBusy(false);
		}
	};

	const onFile = (e: Event) => {
		const el = e.currentTarget as HTMLInputElement;
		const file = el.files?.[0];
		el.value = '';
		if (!file) return;
		if (file.size > MAX_IMAGE_BYTES) return props.onError(t('settings-image-too-large'));
		run(() => uploadProfileImage(props.kind, file));
	};

	return (
		<div class="flex gap-2">
			<input ref={input} type="file" accept="image/*" class="hidden" onChange={onFile} />
			<button
				type="button"
				disabled={busy()}
				onClick={() => input?.click()}
				class="px-4 py-2 rounded-xl text-sm font-medium bg-[#f7e26c] text-stone-900 disabled:opacity-50"
			>
				{t('settings-image-upload')}
			</button>
			<Show when={props.hasImage}>
				<button
					type="button"
					disabled={busy()}
					onClick={() => run(() => updateProfile({ [props.kind]: null }))}
					class="px-4 py-2 rounded-xl text-sm font-medium bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 disabled:opacity-50"
				>
					{t('settings-image-remove')}
				</button>
			</Show>
		</div>
	);
}

function Field(props: { label: string; tip?: string; children: JSX.Element }) {
	return (
		<div class="mb-5">
			<div class="flex items-center gap-1.5 text-xs font-display italic text-stone-500 mb-1.5 px-1">
				<label>{props.label}</label>
				<Show when={props.tip}>{(tip) => <InfoTip text={tip()} />}</Show>
			</div>
			{props.children}
		</div>
	);
}

function ToggleField(props: {
	label: string;
	hint?: string;
	value: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div class="flex items-start justify-between py-3 border-t border-stone-100 dark:border-stone-800">
			<div class="flex-1 pr-6">
				<div class="flex items-center gap-1.5 text-sm font-medium">
					{props.label}
					<Show when={props.hint}>{(hint) => <InfoTip text={hint()} />}</Show>
				</div>
			</div>
			<button
				onClick={() => props.onChange(!props.value)}
				class={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
					props.value ? 'bg-[#f7e26c]' : 'bg-stone-300 dark:bg-stone-700'
				}`}
			>
				<span
					class="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform"
					style={{ transform: props.value ? 'translateX(20px)' : 'translateX(0)' }}
				/>
			</button>
		</div>
	);
}
