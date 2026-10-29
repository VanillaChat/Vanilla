import { createSignal } from 'solid-js';

export interface Prefs {
	liveFormatting: boolean;
	discordPresence: boolean;
	pingSound: boolean;
	autoUpdate: boolean;
	simulateUpdate: boolean;
}

const STORAGE_KEY = 'vanilla-prefs';
const DEFAULTS: Prefs = {
	liveFormatting: true,
	discordPresence: false,
	pingSound: true,
	autoUpdate: true,
	simulateUpdate: false,
};

function load(): Prefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
	} catch {}
	return DEFAULTS;
}

const [prefs, setPrefsSignal] = createSignal<Prefs>(load());

export { prefs };

export function updatePrefs(patch: Partial<Prefs>) {
	const next = { ...prefs(), ...patch };
	setPrefsSignal(next);
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {}
}
