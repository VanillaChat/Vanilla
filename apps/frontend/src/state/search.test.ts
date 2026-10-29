import { describe, expect, test } from 'bun:test';
import { highlightTerms, splitSearchTokens } from './search';

describe('splitSearchTokens', () => {
	test('keeps quoted phrases and filter values together', () => {
		expect(splitSearchTokens('hello from:"john doe" "exact phrase"')).toEqual([
			'hello',
			'from:"john doe"',
			'"exact phrase"',
		]);
	});

	test('survives an unterminated quote', () => {
		expect(splitSearchTokens('say "hel')).toEqual(['say', '"hel']);
	});
});

describe('highlightTerms', () => {
	test('drops filters, negations and OR', () => {
		expect(highlightTerms('cats from:alice in:general has:link -dogs OR birds')).toEqual([
			'cats',
			'birds',
		]);
	});

	test('treats a quoted phrase as one term', () => {
		expect(highlightTerms('"good morning" before:2026-01-01')).toEqual(['good morning']);
	});

	test('a URL is text, not a filter', () => {
		expect(highlightTerms('https://example.com')).toEqual(['https://example.com']);
	});

	test('ignores one-letter terms', () => {
		expect(highlightTerms('a b cc')).toEqual(['cc']);
	});
});
