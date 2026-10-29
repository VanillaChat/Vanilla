import { createSignal } from 'solid-js';
import { api } from '../api/client';
import type { Message } from '../api/messages';

export type SearchScope = { kind: 'guild'; guildId: string } | { kind: 'dm' };

export const scopeKey = (scope: SearchScope) => (scope.kind === 'guild' ? scope.guildId : '@me');

export const SEARCH_FILTERS = [
	{ key: 'from', hintKey: 'search-hint-from' },
	{ key: 'in', hintKey: 'search-hint-in' },
	{ key: 'mentions', hintKey: 'search-hint-mentions' },
	{ key: 'has', hintKey: 'search-hint-has' },
	{ key: 'before', hintKey: 'search-hint-before' },
	{ key: 'after', hintKey: 'search-hint-after' },
	{ key: 'during', hintKey: 'search-hint-during' },
] as const;

const FILTER_KEYS: string[] = SEARCH_FILTERS.map((f) => f.key);

const PAGE = 25;

type SearchResponse = { total: number; messages: Message[] };

const [panel, setPanel] = createSignal<{ scope: SearchScope; query: string } | null>(null);
const [results, setResults] = createSignal<Message[]>([]);
const [total, setTotal] = createSignal(0);
const [loading, setLoading] = createSignal(false);
const [error, setError] = createSignal<unknown>(null);

/** Only the newest request may write results, so a slow old search cannot overwrite a new one. */
let latest = 0;

export const searchPanel = panel;
export const searchResults = results;
export const searchTotal = total;
export const searchLoading = loading;
export const searchError = error;

const url = (scope: SearchScope, query: string, offset: number) => {
	const qs = new URLSearchParams({ q: query, limit: String(PAGE), offset: String(offset) });
	return scope.kind === 'guild' ? `/search/guilds/${scope.guildId}?${qs}` : `/search/dms?${qs}`;
};

export async function runSearch(scope: SearchScope, query: string): Promise<void> {
	const id = ++latest;
	setPanel({ scope, query });
	setResults([]);
	setTotal(0);
	setError(null);
	setLoading(true);
	try {
		const res = await api<SearchResponse>(url(scope, query, 0));
		if (id !== latest) return;
		setResults(res.messages);
		setTotal(res.total);
	} catch (e) {
		if (id === latest) setError(e);
	} finally {
		if (id === latest) setLoading(false);
	}
}

export async function loadMoreResults(): Promise<void> {
	const p = panel();
	if (!p || loading() || results().length >= total()) return;
	const id = ++latest;
	setLoading(true);
	try {
		const res = await api<SearchResponse>(url(p.scope, p.query, results().length));
		if (id !== latest) return;
		setResults([...results(), ...res.messages]);
		setTotal(res.total);
	} catch (e) {
		if (id === latest) setError(e);
	} finally {
		if (id === latest) setLoading(false);
	}
}

export function closeSearch() {
	latest++;
	setPanel(null);
	setResults([]);
	setTotal(0);
	setError(null);
	setLoading(false);
}

export type JumpTarget = { channelId: string; messageId: string };

const [jumpTarget, setJumpTarget] = createSignal<JumpTarget | null>(null);

export { jumpTarget, setJumpTarget };

export function splitSearchTokens(query: string): string[] {
	return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

export function highlightTerms(query: string): string[] {
	const terms = new Set<string>();
	for (const token of splitSearchTokens(query)) {
		const colon = token.indexOf(':');
		const key = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
		if (FILTER_KEYS.includes(key) && token.length > colon + 1) continue;
		if (token.startsWith('-') || token.toLowerCase() === 'or') continue;
		const term = token.replaceAll('"', '').trim();
		if (term.length >= 2) terms.add(term);
	}
	return Array.from(terms);
}
