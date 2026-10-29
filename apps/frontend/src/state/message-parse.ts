import { splitLinks } from './links';

export type Inline =
	| { type: 'text'; text: string }
	| { type: 'code'; text: string }
	| { type: 'link'; href: string; children: Inline[] }
	| { type: 'mention'; text: string; name: string }
	| { type: 'emoji'; name: string; id: string }
	| { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; children: Inline[] };

export type Block =
	| { type: 'paragraph'; children: Inline[] }
	| { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
	| { type: 'quote'; children: Inline[] }
	| { type: 'subtext'; children: Inline[] }
	| { type: 'list'; ordered: boolean; items: Inline[][] }
	| { type: 'codeblock'; lang: string; text: string };

export type Deco = {
	kind:
		| 'marker'
		| 'bold'
		| 'italic'
		| 'underline'
		| 'strike'
		| 'spoiler'
		| 'code'
		| 'link'
		| 'mention'
		| 'customemoji'
		| 'heading1'
		| 'heading2'
		| 'heading3'
		| 'quote'
		| 'subtext'
		| 'fence'
		| 'codeblock'
		| 'codebody';
	from: number;
	to: number;
	line?: boolean;
	lang?: string;
};

const MENTION = /^@([\w.-]+)/;
export const CUSTOM_EMOJI = /^<:(\w{2,32}):(\d+)>/;
const MASKED_LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;
// Longest first: `***` must win over `**` and `*`.
const DELIMITERS: Array<{
	mark: string;
	types: Array<'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'>;
}> = [
	{ mark: '***', types: ['bold', 'italic'] },
	{ mark: '**', types: ['bold'] },
	{ mark: '__', types: ['underline'] },
	{ mark: '~~', types: ['strike'] },
	{ mark: '||', types: ['spoiler'] },
	{ mark: '*', types: ['italic'] },
	{ mark: '_', types: ['italic'] },
];
const ESCAPABLE = '\\*_~|`>#-[]()@';

// Letters of any script count: everything above Latin-1 punctuation is treated as a word character.
const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9\u00C0-\uFFFF]/.test(c);

function findClose(text: string, mark: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
			continue;
		}
		// Content may not span a code span: skip over it.
		if (text[i] === '`') {
			const end = text.indexOf('`', i + 1);
			if (end === -1) continue;
			i = end;
			continue;
		}
		if (!text.startsWith(mark, i) || i === from) continue;
		const content = text.slice(from, i);
		if (!content.trim()) continue;
		// A single `*`/`_` must hug its content, and `_` must not sit inside a word.
		if (mark.length === 1) {
			if (/\s$/.test(content)) continue;
			if (text[i + 1] === mark) continue;
			if (mark === '_' && isWordChar(text[i + 1])) continue;
		}
		return i;
	}
	return -1;
}

export function parseInline(text: string, base = 0, sink?: Deco[]): Inline[] {
	const mark = (kind: Deco['kind'], from: number, to: number) => {
		if (sink && to > from) sink.push({ kind, from: base + from, to: base + to });
	};
	const out: Inline[] = [];
	let plain = '';
	const flush = () => {
		if (plain) out.push({ type: 'text', text: plain });
		plain = '';
	};

	let i = 0;
	while (i < text.length) {
		const c = text[i];

		if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1])) {
			mark('marker', i, i + 1);
			plain += text[i + 1];
			i += 2;
			continue;
		}

		if (c === '`') {
			const end = text.indexOf('`', i + 1);
			if (end > i + 1) {
				flush();
				out.push({ type: 'code', text: text.slice(i + 1, end) });
				mark('code', i, end + 1);
				mark('marker', i, i + 1);
				mark('marker', end, end + 1);
				i = end + 1;
				continue;
			}
		}

		if (c === '[') {
			const m = MASKED_LINK.exec(text.slice(i));
			if (m) {
				flush();
				out.push({ type: 'link', href: m[2], children: parseInline(m[1], base + i + 1, sink) });
				mark('link', i + 1, i + 1 + m[1].length);
				mark('marker', i, i + 1);
				mark('marker', i + 1 + m[1].length, i + m[0].length);
				i += m[0].length;
				continue;
			}
		}

		if (c === 'h' && /^https?:\/\//.test(text.slice(i, i + 8))) {
			const [first] = splitLinks(text.slice(i));
			if (first?.href && text.startsWith(first.text, i)) {
				flush();
				out.push({
					type: 'link',
					href: first.href,
					children: [{ type: 'text', text: first.text }],
				});
				i += first.text.length;
				continue;
			}
		}

		if (c === '<') {
			const m = CUSTOM_EMOJI.exec(text.slice(i));
			if (m) {
				flush();
				out.push({ type: 'emoji', name: m[1], id: m[2] });
				mark('customemoji', i, i + m[0].length);
				i += m[0].length;
				continue;
			}
		}

		if (c === '@' && !/[\w@]/.test(text[i - 1] ?? '')) {
			const m = MENTION.exec(text.slice(i));
			if (m) {
				flush();
				out.push({ type: 'mention', text: m[0], name: m[1].toLowerCase() });
				mark('mention', i, i + m[0].length);
				i += m[0].length;
				continue;
			}
		}

		const delim = DELIMITERS.find((d) => text.startsWith(d.mark, i));
		if (delim) {
			const open = delim.mark;
			const intraWord = open === '_' && isWordChar(text[i - 1]);
			const close = intraWord ? -1 : findClose(text, open, i + open.length);
			if (close !== -1 && !/^\s/.test(text.slice(i + open.length, i + open.length + 1) || 'x')) {
				flush();
				const inner = text.slice(i + open.length, close);
				let node: Inline = {
					type: delim.types[delim.types.length - 1],
					children: parseInline(inner, base + i + open.length, sink),
				};
				for (let k = delim.types.length - 2; k >= 0; k--)
					node = { type: delim.types[k], children: [node] };
				out.push(node);
				for (const type of delim.types) mark(type, i + open.length, close);
				mark('marker', i, i + open.length);
				mark('marker', close, close + open.length);
				i = close + open.length;
				continue;
			}
		}

		plain += c;
		i++;
	}
	flush();
	return out;
}

const FENCE = /^```(\w*)\s*$/;
const SUBTEXT = /^-# +(.+)$/;
const HEADING = /^(#{1,3}) +(.+)$/;
const QUOTE = /^> ?(.*)$/;
const BULLET = /^[-*] +(.+)$/;
const NUMBERED = /^\d+\. +(.+)$/;

export function parseMessage(text: string, sink?: Deco[]): Block[] {
	const lines = text.split('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const l of lines) {
		starts.push(offset);
		offset += l.length + 1;
	}
	const blocks: Block[] = [];
	let para: string[] = [];
	let paraStart = 0;
	const flushPara = () => {
		if (para.length)
			blocks.push({
				type: 'paragraph',
				children: parseInline(para.join('\n'), starts[paraStart], sink),
			});
		para = [];
	};
	const markPrefix = (line: number, prefix: number, content: string) => {
		if (!sink) return;
		sink.push({ kind: 'marker', from: starts[line], to: starts[line] + prefix });
		parseInline(content, starts[line] + prefix, sink);
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const fence = FENCE.exec(line);
		if (fence) {
			const end = lines.findIndex((l, j) => j > i && l.trim() === '```');
			if (end !== -1) {
				flushPara();
				blocks.push({
					type: 'codeblock',
					lang: fence[1],
					text: lines.slice(i + 1, end).join('\n'),
				});
				if (sink) {
					if (end > i + 1) {
						sink.push({
							kind: 'codebody',
							from: starts[i + 1],
							to: starts[end] - 1,
							lang: fence[1],
						});
					}
					for (let k = i; k <= end; k++) {
						const kind = k === i || k === end ? 'fence' : 'codeblock';
						sink.push({ kind, from: starts[k], to: starts[k] + lines[k].length, line: true });
					}
				}
				i = end;
				continue;
			}
		}

		const subtext = SUBTEXT.exec(line);
		if (subtext) {
			flushPara();
			blocks.push({ type: 'subtext', children: parseInline(subtext[1]) });
			sink?.push({ kind: 'subtext', from: starts[i], to: starts[i] + line.length, line: true });
			markPrefix(i, line.length - subtext[1].length, subtext[1]);
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flushPara();
			const level = heading[1].length as 1 | 2 | 3;
			blocks.push({ type: 'heading', level, children: parseInline(heading[2]) });
			sink?.push({
				kind: `heading${level}`,
				from: starts[i],
				to: starts[i] + line.length,
				line: true,
			});
			markPrefix(i, line.length - heading[2].length, heading[2]);
			continue;
		}

		if (QUOTE.test(line)) {
			flushPara();
			const quoted: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				const content = (QUOTE.exec(lines[i]) as RegExpExecArray)[1];
				quoted.push(content);
				sink?.push({ kind: 'quote', from: starts[i], to: starts[i] + lines[i].length, line: true });
				markPrefix(i, lines[i].length - content.length, content);
				i++;
			}
			i--;
			blocks.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
			continue;
		}

		const ordered = NUMBERED.test(line);
		if (ordered || BULLET.test(line)) {
			flushPara();
			const re = ordered ? NUMBERED : BULLET;
			const items: Inline[][] = [];
			while (i < lines.length && re.test(lines[i])) {
				const content = (re.exec(lines[i]) as RegExpExecArray)[1];
				items.push(parseInline(content));
				markPrefix(i, lines[i].length - content.length, content);
				i++;
			}
			i--;
			blocks.push({ type: 'list', ordered, items });
			continue;
		}

		if (!para.length) paraStart = i;
		para.push(line);
	}
	flushPara();
	return blocks;
}

export function decorate(text: string): Deco[] {
	const sink: Deco[] = [];
	parseMessage(text, sink);
	return sink;
}

function walk(nodes: Inline[], visit: (node: Inline) => void) {
	for (const n of nodes) {
		visit(n);
		if ('children' in n) walk(n.children, visit);
	}
}

export function inlinesOf(blocks: Block[]): Inline[][] {
	return blocks.flatMap((b) => {
		switch (b.type) {
			case 'list':
				return b.items;
			case 'codeblock':
				return [];
			default:
				return [b.children];
		}
	});
}

export function linksIn(blocks: Block[]): string[] {
	const hrefs: string[] = [];
	for (const inlines of inlinesOf(blocks)) {
		walk(inlines, (n) => {
			if (n.type === 'link') hrefs.push(n.href);
		});
	}
	return hrefs;
}
