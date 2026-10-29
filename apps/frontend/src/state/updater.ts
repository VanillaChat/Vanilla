import { createSignal } from 'solid-js';
import { prefs } from './prefs';

export type UpdateStatus =
	| { state: 'idle' }
	| { state: 'checking' }
	| { state: 'upToDate' }
	| { state: 'available'; version: string; notes?: string | null }
	| { state: 'downloading'; version: string; downloaded: number; total?: number | null }
	| { state: 'ready'; version: string }
	| { state: 'error'; message: string };

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

const invoke = (): Invoke | undefined =>
	(window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__?.invoke;

const [status, setStatus] = createSignal<UpdateStatus>({ state: 'idle' });
const [version, setVersion] = createSignal('');
const [dismissed, setDismissed] = createSignal<string | null>(null);
const [settingsRequest, setSettingsRequest] = createSignal(0);

export { settingsRequest, status as updateStatus, version as appVersion };

/** True once an update is downloaded and waiting for a restart. */
export const updateReady = () => status().state === 'ready';

/** What the title bar pill says; null when there is nothing to announce. */
export const updatePill = (): { key: string; percent?: number } | null => {
	const s = status();
	if (s.state === 'available') return { key: 'updates-pill-available' };
	if (s.state === 'ready') return { key: 'updates-pill' };
	if (s.state === 'downloading') {
		const percent = s.total ? Math.min(100, Math.round((s.downloaded / s.total) * 100)) : undefined;
		return { key: 'updates-pill-downloading', percent };
	}
	return null;
};

/** The version to nag about in the toast, unless the user chose "Later" for it. */
export const toastVersion = () => {
	const s = status();
	return s.state === 'ready' && dismissed() !== s.version ? s.version : null;
};

export const dismissToast = () => {
	const s = status();
	if (s.state === 'ready') setDismissed(s.version);
};

export const requestUpdatesView = () => setSettingsRequest((n) => n + 1);

const asMessage = (e: unknown) => (typeof e === 'string' ? e : e instanceof Error ? e.message : '');

const SIMULATED_NOTES = [
	'Roles and permissions, with an audit log for admins',
	'Soft ping sound and a default emoji in every server',
	'Invite links show a preview card in Discord',
].join('\n');

const simulatedAvailable = (): UpdateStatus => ({
	state: 'available',
	version: version() || '0.0.0',
	notes: SIMULATED_NOTES,
});

let simulation: ReturnType<typeof setInterval> | undefined;

/** Developer mode: shows the whole update flow for the version that is already installed. */
export function setUpdateSimulation(on: boolean) {
	clearInterval(simulation);
	simulation = undefined;
	setDismissed(null);
	setStatus(on ? simulatedAvailable() : { state: 'idle' });
}

function simulateDownload(target: string) {
	const total = 38 * 1024 * 1024;
	let downloaded = 0;
	clearInterval(simulation);
	simulation = setInterval(() => {
		downloaded = Math.min(total, downloaded + total / 25);
		if (downloaded >= total) {
			clearInterval(simulation);
			simulation = undefined;
			setStatus({ state: 'ready', version: target });
		} else {
			setStatus({ state: 'downloading', version: target, downloaded, total });
		}
	}, 200);
}

export async function checkForUpdate(): Promise<UpdateStatus> {
	if (prefs().simulateUpdate) {
		const s = status();
		if (s.state === 'idle' || s.state === 'upToDate' || s.state === 'error') {
			setStatus(simulatedAvailable());
		}
		return status();
	}
	const call = invoke();
	if (!call) return status();
	setStatus({ state: 'checking' });
	try {
		const next = (await call('update_check')) as UpdateStatus;
		setStatus(next);
		return next;
	} catch (e) {
		const next: UpdateStatus = { state: 'error', message: asMessage(e) };
		setStatus(next);
		return next;
	}
}

let polling: ReturnType<typeof setInterval> | undefined;

function poll() {
	const call = invoke();
	if (!call || polling) return;
	polling = setInterval(async () => {
		try {
			const next = (await call('update_status')) as UpdateStatus;
			setStatus(next);
			if (next.state !== 'downloading') {
				clearInterval(polling);
				polling = undefined;
			}
		} catch {
			clearInterval(polling);
			polling = undefined;
		}
	}, 400);
}

export async function installUpdate() {
	if (prefs().simulateUpdate) {
		const s = status();
		if (s.state === 'available') {
			setStatus({ state: 'downloading', version: s.version, downloaded: 0, total: 1 });
			simulateDownload(s.version);
		}
		return;
	}
	const call = invoke();
	if (!call) return;
	const s = status();
	if (s.state === 'available')
		setStatus({ state: 'downloading', version: s.version, downloaded: 0 });
	try {
		await call('update_install');
		poll();
	} catch (e) {
		setStatus({ state: 'error', message: asMessage(e) });
	}
}

export async function restartToUpdate() {
	if (prefs().simulateUpdate) {
		setStatus(simulatedAvailable());
		return;
	}
	try {
		await invoke()?.('update_apply');
	} catch (e) {
		setStatus({ state: 'error', message: asMessage(e) });
	}
}

const SIX_HOURS = 6 * 60 * 60 * 1000;
let started = false;

/** Desktop only: reads the version, then checks now and every few hours. */
export function startUpdateChecks() {
	const call = invoke();
	if (!call || started) return;
	started = true;
	call('app_version')
		.then((v) => {
			setVersion(String(v));
			if (prefs().simulateUpdate && status().state === 'idle') setStatus(simulatedAvailable());
		})
		.catch(() => {});
	// The startup splash may already have found (or downloaded) an update.
	call('update_status')
		.then((s) => {
			const current = s as UpdateStatus;
			if (current.state === 'downloading') poll();
			if (current.state !== 'idle' && !prefs().simulateUpdate) setStatus(current);
		})
		.catch(() => {});
	const run = async () => {
		if (!prefs().autoUpdate || prefs().simulateUpdate) return;
		const s = status();
		if (s.state === 'downloading' || s.state === 'ready' || s.state === 'checking') return;
		const next = await checkForUpdate();
		if (next.state === 'available') await installUpdate();
	};
	setTimeout(run, 10_000);
	setInterval(run, SIX_HOURS);
}
