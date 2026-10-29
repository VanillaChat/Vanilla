import { parse } from '@twemoji/parser';
import { emojiSrc } from '../api/emoji';
import type { GatewayEmoji } from '../api/gateway';
import { guilds } from './gateway-data';

// Pinned so artwork never changes under existing messages.
const ASSETS = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/svg/';

const buildUrl = (codepoints: string) => `${ASSETS}${codepoints}.svg`;

export type EmojiPart = { text: string; emoji?: { url: string } };

export function splitEmoji(text: string): EmojiPart[] {
	const entities = parse(text, { buildUrl });
	if (entities.length === 0) return [{ text }];
	const parts: EmojiPart[] = [];
	let last = 0;
	for (const e of entities) {
		const [from, to] = e.indices;
		if (from > last) parts.push({ text: text.slice(last, from) });
		parts.push({ text: e.text, emoji: { url: e.url } });
		last = to;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

export const MAX_JUMBO = 27;

const CUSTOM_EMOJI_G = /<:\w{2,32}:\d+>/g;

export function isEmojiOnly(text: string): boolean {
	const trimmed = text.replace(CUSTOM_EMOJI_G, '😀').trim();
	if (!trimmed) return false;
	const parts = splitEmoji(trimmed);
	let count = 0;
	for (const p of parts) {
		if (p.emoji) count++;
		else if (p.text.trim()) return false;
	}
	return count > 0 && count <= MAX_JUMBO;
}

export function emojiUrl(unicode: string): string {
	return splitEmoji(unicode)[0]?.emoji?.url ?? '';
}

export const CUSTOM_EMOJI_RE = /^<:(\w{2,32}):(\d+)>$/;

export type CustomEmoji = GatewayEmoji & { guildName: string; src: string };

export const BUILTIN_GUILD = 'vanilla';

/** Emoji every account has, whatever servers it is in. Same `<:name:id>` text as server emoji. */
const BUILTIN_EMOJI: CustomEmoji[] = [
	{
		id: '1565376747027824651',
		guildId: BUILTIN_GUILD,
		guildName: 'Vanilla',
		name: 'salceson_akrobatyczny',
		animated: false,
		creatorId: '',
		url: '/emoji/salceson_akrobatyczny.webp',
		src: '/emoji/salceson_akrobatyczny.webp',
	},
];

export function allCustomEmoji(): CustomEmoji[] {
	return [
		...BUILTIN_EMOJI,
		...guilds().flatMap((g) =>
			(g.emojis ?? []).map((e) => ({ ...e, guildName: g.name, src: emojiSrc(e) })),
		),
	];
}

export function customEmojiById(id: string): CustomEmoji | undefined {
	return allCustomEmoji().find((e) => e.id === id);
}

export const customEmojiText = (e: Pick<GatewayEmoji, 'name' | 'id'>) => `<:${e.name}:${e.id}>`;

export type PickerEmoji = {
	hexcode: string;
	unicode: string;
	label: string;
	tags: string[];
	group: number;
	skins: string[];
};

export const EMOJI_GROUPS = [
	{ id: 0, key: 'smileys', icon: 'fa-regular fa-face-smile' },
	{ id: 1, key: 'people', icon: 'fa-solid fa-hand' },
	{ id: 3, key: 'animals', icon: 'fa-solid fa-paw' },
	{ id: 4, key: 'food', icon: 'fa-solid fa-burger' },
	{ id: 5, key: 'travel', icon: 'fa-solid fa-car' },
	{ id: 6, key: 'activities', icon: 'fa-solid fa-futbol' },
	{ id: 7, key: 'objects', icon: 'fa-regular fa-lightbulb' },
	{ id: 8, key: 'symbols', icon: 'fa-solid fa-icons' },
	{ id: 9, key: 'flags', icon: 'fa-regular fa-flag' },
] as const;

let loading: Promise<PickerEmoji[]> | null = null;

export function loadEmoji(): Promise<PickerEmoji[]> {
	loading ??= import('emojibase-data/en/compact.json').then((m) =>
		(m.default as unknown as Array<Record<string, unknown>>)
			.filter((e) => typeof e.group === 'number' && e.group !== 2)
			.map((e) => ({
				hexcode: e.hexcode as string,
				unicode: e.unicode as string,
				label: e.label as string,
				tags: (e.tags as string[] | undefined) ?? [],
				group: e.group as number,
				skins: ((e.skins as Array<{ unicode: string }> | undefined) ?? []).map((s) => s.unicode),
			})),
	);
	return loading;
}

export type Shortcode = { code: string; unicode: string; src?: string };

export function customShortcodes(): Shortcode[] {
	return allCustomEmoji().map((e) => ({ code: e.name, unicode: customEmojiText(e), src: e.src }));
}

let shortcodes: Promise<Shortcode[]> | null = null;

export function loadShortcodes(): Promise<Shortcode[]> {
	shortcodes ??= Promise.all([
		loadEmoji(),
		import('emojibase-data/en/shortcodes/github.json'),
	]).then(([emoji, codes]) => {
		const byHex = codes.default as unknown as Record<string, string | string[]>;
		const out: Shortcode[] = [];
		for (const e of emoji) {
			const raw = byHex[e.hexcode];
			for (const code of raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]) {
				out.push({ code, unicode: e.unicode });
			}
		}
		return out;
	});
	return shortcodes;
}

export function matchShortcodes(all: Shortcode[], query: string, limit = 8): Shortcode[] {
	const q = query.toLowerCase();
	const starts = all.filter((s) => s.code.startsWith(q));
	const rest = all.filter((s) => !s.code.startsWith(q) && s.code.includes(q));
	return [...starts, ...rest].slice(0, limit);
}

export function searchEmoji(all: PickerEmoji[], query: string, limit = 160): PickerEmoji[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const starts: PickerEmoji[] = [];
	const rest: PickerEmoji[] = [];
	for (const e of all) {
		if (e.label.startsWith(q) || e.tags.some((tag) => tag.startsWith(q))) starts.push(e);
		else if (e.label.includes(q) || e.tags.some((tag) => tag.includes(q))) rest.push(e);
	}
	return [...starts, ...rest].slice(0, limit);
}

const RECENT_KEY = 'vanilla-emoji-recent';
const MAX_RECENT = 24;
const TONE_KEY = 'vanilla-emoji-tone';

export function recentEmoji(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, MAX_RECENT) : [];
	} catch {
		return [];
	}
}

export function rememberEmoji(unicode: string) {
	try {
		const next = [unicode, ...recentEmoji().filter((x) => x !== unicode)].slice(0, MAX_RECENT);
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {}
}

export function loadTone(): number {
	try {
		const n = Number(localStorage.getItem(TONE_KEY));
		return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
	} catch {
		return 0;
	}
}

export function saveTone(tone: number) {
	try {
		localStorage.setItem(TONE_KEY, String(tone));
	} catch {}
}

export const withTone = (e: PickerEmoji, tone: number) =>
	tone > 0 && e.skins[tone - 1] ? e.skins[tone - 1] : e.unicode;
