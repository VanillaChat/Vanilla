import { expect, test } from 'bun:test';
import { highlight, loadLanguage, resolveLanguage } from './highlight';

test('rust gets tokens and escapes html', async () => {
	const name = resolveLanguage('RS');
	expect(name).toBe('rust');
	await loadLanguage(name as string);
	const html = highlight('fn main() { let x = "<b>"; }', name as string);
	expect(html).toContain('hljs-keyword');
	expect(html).not.toContain('<b>');
	expect(resolveLanguage('brainfuck')).toBeNull();
});

test('token ranges line up with the original code, entities included', async () => {
	const { tokenRanges } = await import('./highlight');
	const code = 'let a = "<x>"; // hi';
	await loadLanguage('javascript');
	const ranges = tokenRanges(highlight(code, 'javascript'));
	const slice = (r: { from: number; to: number }) => code.slice(r.from, r.to);
	expect(ranges.map(slice)).toContain('let');
	expect(ranges.map(slice)).toContain('"<x>"');
	expect(ranges.map(slice)).toContain('// hi');
});
