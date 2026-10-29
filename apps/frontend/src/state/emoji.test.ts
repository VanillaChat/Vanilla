import { describe, expect, test } from 'bun:test';
import { isEmojiOnly, matchShortcodes, searchEmoji, splitEmoji } from './emoji';

describe('splitEmoji', () => {
	test('separates emoji from text with Twemoji urls', () => {
		const parts = splitEmoji('hi 👋!');
		expect(parts.map((p) => p.text)).toEqual(['hi ', '👋', '!']);
		expect(parts[1].emoji?.url).toContain('1f44b.svg');
	});

	test('keeps ZWJ sequences whole', () => {
		const parts = splitEmoji('👨‍👩‍👧');
		expect(parts).toHaveLength(1);
		expect(parts[0].emoji).toBeDefined();
	});

	test('plain text is untouched', () => {
		expect(splitEmoji('hello 123 #')).toEqual([{ text: 'hello 123 #' }]);
	});
});

describe('isEmojiOnly', () => {
	test('only emoji and spaces', () => {
		expect(isEmojiOnly('😀 😀')).toBe(true);
		expect(isEmojiOnly('😀 hi')).toBe(false);
		expect(isEmojiOnly('')).toBe(false);
	});
});

describe('searchEmoji', () => {
	const all = [
		{
			hexcode: '1F44B',
			unicode: '👋',
			label: 'waving hand',
			tags: ['hello', 'wave'],
			group: 1,
			skins: [],
		},
		{ hexcode: '1F30A', unicode: '🌊', label: 'water wave', tags: ['ocean'], group: 3, skins: [] },
	];
	test('prefix matches rank first', () => {
		expect(searchEmoji(all, 'wave').map((e) => e.unicode)).toEqual(['👋', '🌊']);
		expect(searchEmoji(all, 'ocean').map((e) => e.unicode)).toEqual(['🌊']);
		expect(searchEmoji(all, '')).toEqual([]);
	});
});

describe('matchShortcodes', () => {
	const codes = [
		{ code: 'smile', unicode: '😄' },
		{ code: 'smiley', unicode: '😃' },
		{ code: 'sunny', unicode: '☀️' },
		{ code: 'wide_smile', unicode: '😁' },
	];
	test('prefix first, then contains', () => {
		expect(matchShortcodes(codes, 'smi').map((c) => c.code)).toEqual([
			'smile',
			'smiley',
			'wide_smile',
		]);
		expect(matchShortcodes(codes, 'zzz')).toEqual([]);
	});
});
