import { describe, expect, test } from 'bun:test';
import { decorate, type Inline, linksIn, parseInline, parseMessage } from './message-parse';

const types = (nodes: Inline[]) => nodes.map((n) => n.type);
const textOf = (nodes: Inline[]): string =>
	nodes
		.map((n) => ('children' in n ? textOf(n.children) : 'text' in n ? n.text : `:${n.name}:`))
		.join('');

describe('inline', () => {
	test('custom emoji tokens', () => {
		expect(parseInline('hi <:party_parrot:123456> there')).toEqual([
			{ type: 'text', text: 'hi ' },
			{ type: 'emoji', name: 'party_parrot', id: '123456' },
			{ type: 'text', text: ' there' },
		]);
		expect(types(parseInline('<:x:1>'))).toEqual(['text']);
		expect(types(parseInline('<not:an:emoji>'))).toEqual(['text']);
	});

	test('plain text stays one node', () => {
		expect(parseInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
	});

	test('bold, italic, underline, strike, spoiler', () => {
		expect(types(parseInline('**a**'))).toEqual(['bold']);
		expect(types(parseInline('*a*'))).toEqual(['italic']);
		expect(types(parseInline('_a_'))).toEqual(['italic']);
		expect(types(parseInline('__a__'))).toEqual(['underline']);
		expect(types(parseInline('~~a~~'))).toEqual(['strike']);
		expect(types(parseInline('||a||'))).toEqual(['spoiler']);
	});

	test('nests and handles bold italic', () => {
		const [bold] = parseInline('**bold *and italic***');
		expect(bold.type).toBe('bold');
		const [outer] = parseInline('***both***');
		expect(outer.type).toBe('bold');
		expect('children' in outer && outer.children[0].type).toBe('italic');
	});

	test('unmatched or spaced markers stay literal', () => {
		expect(parseInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
		expect(parseInline('**oops')).toEqual([{ type: 'text', text: '**oops' }]);
		expect(parseInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
	});

	test('escapes', () => {
		expect(parseInline('\\*not italic\\*')).toEqual([{ type: 'text', text: '*not italic*' }]);
	});

	test('code spans are verbatim', () => {
		expect(parseInline('`**x** @bob`')).toEqual([{ type: 'code', text: '**x** @bob' }]);
	});

	test('mentions, but not inside words', () => {
		expect(types(parseInline('hi @Bob!'))).toEqual(['text', 'mention', 'text']);
		expect(types(parseInline('mail me@bob.com'))).toEqual(['text']);
	});

	test('links: raw, masked, and not swallowing punctuation', () => {
		const raw = parseInline('see https://a.example/x, ok');
		expect(raw[1]).toMatchObject({ type: 'link', href: 'https://a.example/x' });
		expect(textOf(raw)).toBe('see https://a.example/x, ok');
		const masked = parseInline('[docs](https://a.example/d)');
		expect(masked[0]).toMatchObject({ type: 'link', href: 'https://a.example/d' });
		expect(textOf(masked)).toBe('docs');
	});

	test('an @ inside a URL is not a mention', () => {
		const nodes = parseInline('https://x.example/@alice');
		expect(types(nodes)).toEqual(['link']);
	});

	test('markup in a link target is left alone', () => {
		const nodes = parseInline('https://x.example/a_b_c');
		expect(nodes).toHaveLength(1);
		expect(nodes[0].type).toBe('link');
	});
});

describe('blocks', () => {
	test('plain multi-line text is one paragraph with its newlines', () => {
		const blocks = parseMessage('a\n\nb');
		expect(blocks).toHaveLength(1);
		expect(textOf((blocks[0] as { children: Inline[] }).children)).toBe('a\n\nb');
	});

	test('subtext lines', () => {
		const blocks = parseMessage('-# small *note*\nnormal');
		expect(blocks.map((b) => b.type)).toEqual(['subtext', 'paragraph']);
	});

	test('headings, quotes, lists', () => {
		const blocks = parseMessage('# Title\n> quoted\n> more\n- one\n- two\n1. first\ntail');
		expect(blocks.map((b) => b.type)).toEqual(['heading', 'quote', 'list', 'list', 'paragraph']);
		expect(blocks[2]).toMatchObject({ ordered: false });
		expect(blocks[3]).toMatchObject({ ordered: true });
		expect((blocks[2] as { items: Inline[][] }).items).toHaveLength(2);
	});

	test('fenced code is verbatim and keeps its language', () => {
		const blocks = parseMessage('before\n```ts\nconst a = **1**;\n```\nafter');
		expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'codeblock', 'paragraph']);
		expect(blocks[1]).toEqual({ type: 'codeblock', lang: 'ts', text: 'const a = **1**;' });
	});

	test('an unclosed fence is plain text', () => {
		expect(parseMessage('```\nno end').map((b) => b.type)).toEqual(['paragraph']);
	});

	test('links in code are not links', () => {
		expect(linksIn(parseMessage('`https://a.example` and https://b.example'))).toEqual([
			'https://b.example',
		]);
		expect(linksIn(parseMessage('```\nhttps://a.example\n```'))).toEqual([]);
	});
});

describe('decorate', () => {
	const find = (text: string, kind: string) => decorate(text).filter((d) => d.kind === kind);

	test('bold has dim markers and a styled body, at absolute offsets', () => {
		const text = 'hi **bold** there';
		expect(find(text, 'bold')).toEqual([{ kind: 'bold', from: 5, to: 9 }]);
		expect(find(text, 'marker')).toEqual([
			{ kind: 'marker', from: 3, to: 5 },
			{ kind: 'marker', from: 9, to: 11 },
		]);
	});

	test('nested markup and offsets after earlier lines', () => {
		const text = 'first line\n**a *b* c**';
		const italic = find(text, 'italic');
		expect(italic).toHaveLength(1);
		expect(text.slice(italic[0].from, italic[0].to)).toBe('b');
	});

	test('headings, quotes and code fences style whole lines', () => {
		const text = '# Title\n> quote\n```\ncode\n```';
		expect(find(text, 'heading1')).toEqual([{ kind: 'heading1', from: 0, to: 7, line: true }]);
		expect(find(text, 'quote')).toHaveLength(1);
		expect(find(text, 'fence')).toHaveLength(2);
		expect(find(text, 'codeblock')).toEqual([{ kind: 'codeblock', from: 20, to: 24, line: true }]);
	});

	test('markup inside a code block is not decorated', () => {
		expect(find('```\n**x**\n```', 'bold')).toEqual([]);
	});

	test('plain text has no decorations', () => {
		expect(decorate('just words')).toEqual([]);
	});
});

describe('decorate code bodies', () => {
	test('reports the text between fences with its language', () => {
		const text = 'a\n```rs\nfn x() {}\nlet y;\n```';
		const body = decorate(text).find((d) => d.kind === 'codebody');
		expect(body?.lang).toBe('rs');
		expect(text.slice(body?.from, body?.to)).toBe('fn x() {}\nlet y;');
	});

	test('an empty block has no body', () => {
		expect(decorate('```js\n```').some((d) => d.kind === 'codebody')).toBe(false);
	});
});
