import { createFileRoute, Outlet, useMatch, useNavigate } from '@tanstack/solid-router';
import { createEffect, createMemo, createSignal, onMount, Show } from 'solid-js';
import { connect, ready, upsertDmUsers } from '../api/gateway';
import { ConnectionBar } from '../components/app/ConnectionBar';
import { ProfilePopover } from '../components/app/ProfilePopover';
import { UpdateToast } from '../components/app/UpdateToast';
import { ChannelSettingsModal } from '../components/ChannelSettingsModal';
import { CreateChannelModal } from '../components/CreateChannelModal';
import { GroupModal } from '../components/GroupModal';
import { ServerChannelList } from '../components/ServerChannelList';
import { ServerModal } from '../components/ServerModal';
import { ServerSettingsModal } from '../components/ServerSettingsModal';
import { SettingsModal } from '../components/SettingsModal';
import { LayoutContext } from '../contexts/layout';
import { ProfileContext } from '../contexts/profile';
import { useLayoutState } from '../hooks/useLayoutState';
import { useProfilePopover } from '../hooks/useProfilePopover';
import { DM_SCOPE, loadDms } from '../state/dms';
import { loadRelationships } from '../state/friends';
import { currentUser, guilds } from '../state/gateway-data';
import { closeGroupModal, groupModal } from '../state/group-modal';
import { can, canManageAnything, Perm } from '../state/permissions';
import { usePresence } from '../state/presence';
import { settingsRequest, startUpdateChecks } from '../state/updater';

export const Route = createFileRoute('/app')({
	component: AppLayout,
});

const ANIM_MS = 130;

function AppLayout() {
	onMount(() => {
		connect();
		startUpdateChecks();
	});
	createEffect(() => {
		if (settingsRequest() === 0) return;
		setSettingsSection('updates');
		setSettingsClosing(false);
		setSettingsOpen(true);
	});

	const navigate = useNavigate();
	const serverMatch = useMatch({ from: '/app/$serverId', shouldThrow: false });
	const currentServerId = createMemo<string | undefined>((prev) => {
		const id = serverMatch()?.params.serverId;
		return id ?? prev;
	});
	const channelMatch = useMatch({ from: '/app/$serverId/$channelId', shouldThrow: false });
	// Keeps the last channel only while no server is matched; on a server page without a
	// channel (such as Friends) there is none.
	const currentChannelId = createMemo<string | undefined>((prev) => {
		const id = channelMatch()?.params.channelId;
		if (id) return id;
		return serverMatch() ? undefined : prev;
	});

	// Direct messages are not part of the gateway ready payload. Keyed on the id alone:
	// loading them upserts users, which changes `ready()` and would re-run this forever.
	const userId = createMemo(() => currentUser()?.id);
	createEffect(() => {
		if (!userId()) return;
		loadDms()
			.then(upsertDmUsers)
			.catch(() => {});
		loadRelationships().catch(() => {});
	});

	// A server or channel deleted while you are looking at it: step back to what is left.
	createEffect(() => {
		if (!ready()) return;
		const serverId = serverMatch()?.params.serverId;
		if (!serverId || serverId === DM_SCOPE) return;
		const guild = guilds().find((g) => g.id === serverId);
		if (!guild) {
			navigate({ to: '/app', viewTransition: false });
			return;
		}
		const channelId = channelMatch()?.params.channelId;
		if (channelId && !(guild.channels ?? []).some((c) => c.id === channelId)) {
			navigate({ to: '/app/$serverId', params: { serverId }, viewTransition: false });
		}
	});

	const hasMembers = () =>
		!!currentServerId() && !(currentServerId() === DM_SCOPE && !channelMatch());
	usePresence(() => ({ serverId: currentServerId(), channelId: currentChannelId() }));
	const layout = useLayoutState({ currentServerId, currentChannelId, hasMembers });
	const profile = useProfilePopover();

	const invitedWith = new URLSearchParams(window.location.search).get('invite') ?? undefined;
	if (invitedWith) window.history.replaceState(null, '', window.location.pathname);
	const [serverModalOpen, setServerModalOpen] = createSignal(!!invitedWith);
	const [serverModalClosing, setServerModalClosing] = createSignal(false);
	const [settingsOpen, setSettingsOpen] = createSignal(false);
	const [settingsClosing, setSettingsClosing] = createSignal(false);
	const [settingsSection, setSettingsSection] = createSignal<'voice' | 'updates' | undefined>();
	const [channelModalGuildId, setChannelModalGuildId] = createSignal<string | null>(null);
	const [channelModalClosing, setChannelModalClosing] = createSignal(false);

	const [serverSettingsId, setServerSettingsId] = createSignal<string | null>(null);
	const [serverSettingsClosing, setServerSettingsClosing] = createSignal(false);
	const [channelSettingsId, setChannelSettingsId] = createSignal<string | null>(null);
	const [channelSettingsClosing, setChannelSettingsClosing] = createSignal(false);

	const closeServerSettings = () => {
		if (!serverSettingsId() || serverSettingsClosing()) return;
		setServerSettingsClosing(true);
		setTimeout(() => {
			setServerSettingsId(null);
			setServerSettingsClosing(false);
		}, ANIM_MS);
	};

	const closeChannelSettings = () => {
		if (!channelSettingsId() || channelSettingsClosing()) return;
		setChannelSettingsClosing(true);
		setTimeout(() => {
			setChannelSettingsId(null);
			setChannelSettingsClosing(false);
		}, ANIM_MS);
	};

	const closeServerModal = () => {
		if (!serverModalOpen() || serverModalClosing()) return;
		setServerModalClosing(true);
		setTimeout(() => {
			setServerModalOpen(false);
			setServerModalClosing(false);
		}, ANIM_MS);
	};

	const closeSettings = () => {
		if (!settingsOpen() || settingsClosing()) return;
		setSettingsClosing(true);
		setTimeout(() => {
			setSettingsOpen(false);
			setSettingsClosing(false);
		}, ANIM_MS);
	};

	const closeChannelModal = () => {
		if (!channelModalGuildId() || channelModalClosing()) return;
		setChannelModalClosing(true);
		setTimeout(() => {
			setChannelModalGuildId(null);
			setChannelModalClosing(false);
		}, ANIM_MS);
	};

	return (
		<LayoutContext.Provider value={layout}>
			<ProfileContext.Provider
				value={{
					open: profile.open,
					openSettings: (section) => {
						setSettingsSection(section);
						setSettingsClosing(false);
						setSettingsOpen(true);
					},
				}}
			>
				<div class="h-[calc(100dvh-var(--titlebar,0px))] flex bg-[#fdfaf3] dark:bg-[#1a1816] text-stone-800 dark:text-stone-100 overflow-hidden">
					<Show when={!layout.isMobile() && layout.sidebarCollapsed() && !layout.sidebarPeeking()}>
						<div
							class="hidden lg:block fixed top-[var(--titlebar,0px)] bottom-0 left-0 w-2 z-40"
							onMouseEnter={() => layout.setSidebarPeeking(true)}
							aria-hidden="true"
						/>
					</Show>
					<Show
						when={
							!layout.isMobile() &&
							layout.membersCollapsed() &&
							!layout.membersPeeking() &&
							hasMembers()
						}
					>
						<div
							class="hidden lg:block fixed top-[var(--titlebar,0px)] bottom-0 right-0 w-2 z-40"
							onMouseEnter={() => layout.setMembersPeeking(true)}
							aria-hidden="true"
						/>
					</Show>
					<Show
						when={
							layout.isMobile() && (layout.sidebarOpen() || layout.membersOpen() || layout.drag())
						}
					>
						<div
							class="fixed inset-0 z-30 bg-stone-900/40 backdrop-blur-sm lg:hidden"
							classList={{ 'animate-fade-in': !layout.drag() }}
							style={{ 'pointer-events': layout.drag() ? 'none' : 'auto' }}
							onClick={() => {
								layout.setSidebarOpen(false);
								layout.setMembersOpen(false);
							}}
						/>
					</Show>

					<ConnectionBar />

					<ServerChannelList
						currentServerId={currentServerId}
						currentChannelId={currentChannelId}
						onAddServer={() => setServerModalOpen(true)}
						canAddChannel={(id) => can(id, Perm.MANAGE_CHANNELS)}
						canOpenServerSettings={canManageAnything}
						onAddChannel={(id) => {
							setChannelModalClosing(false);
							setChannelModalGuildId(id);
						}}
						onOpenServerSettings={(id) => {
							setServerSettingsClosing(false);
							setServerSettingsId(id);
						}}
						onOpenChannelSettings={(id) => {
							setChannelSettingsClosing(false);
							setChannelSettingsId(id);
						}}
						onOpenProfile={(user, e) => profile.open(user, e, false, true, true)}
						onOpenSettings={() => {
							setSettingsSection(undefined);
							setSettingsClosing(false);
							setSettingsOpen(true);
						}}
					/>

					<Outlet />

					<Show when={serverModalOpen() || serverModalClosing()}>
						<ServerModal
							initialCode={invitedWith}
							closing={serverModalClosing()}
							onClose={closeServerModal}
							onCreated={(id) =>
								navigate({
									to: '/app/$serverId',
									params: { serverId: id },
									viewTransition: false,
								})
							}
						/>
					</Show>

					<UpdateToast />

					<Show when={settingsOpen() || settingsClosing()}>
						<SettingsModal
							closing={settingsClosing()}
							onClose={closeSettings}
							initialSection={settingsSection()}
						/>
					</Show>

					<Show when={channelModalGuildId()}>
						{(guildId) => (
							<CreateChannelModal
								guildId={guildId()}
								closing={channelModalClosing()}
								onClose={closeChannelModal}
								onCreated={(c) =>
									navigate({
										to: '/app/$serverId/$channelId',
										params: { serverId: guildId(), channelId: c.id },
										viewTransition: false,
									})
								}
							/>
						)}
					</Show>

					<Show when={serverSettingsId()}>
						{(id) => (
							<ServerSettingsModal
								guildId={id()}
								closing={serverSettingsClosing()}
								onClose={closeServerSettings}
							/>
						)}
					</Show>

					<Show when={channelSettingsId()}>
						{(id) => (
							<ChannelSettingsModal
								channelId={id()}
								closing={channelSettingsClosing()}
								onClose={closeChannelSettings}
							/>
						)}
					</Show>

					<Show when={groupModal()}>
						{(m) => <GroupModal modal={m()} onClose={closeGroupModal} />}
					</Show>

					<ProfilePopover api={profile} />
				</div>
			</ProfileContext.Provider>
		</LayoutContext.Provider>
	);
}
