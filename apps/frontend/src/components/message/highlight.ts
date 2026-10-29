import type { LanguageFn } from 'highlight.js';
import hljs from 'highlight.js/lib/core';

type Loader = () => Promise<{ default: LanguageFn }>;

// Each grammar is its own chunk, fetched the first time a message uses it.
const LOADERS: Record<string, Loader> = {
	bash: () => import('highlight.js/lib/languages/bash'),
	c: () => import('highlight.js/lib/languages/c'),
	cpp: () => import('highlight.js/lib/languages/cpp'),
	csharp: () => import('highlight.js/lib/languages/csharp'),
	css: () => import('highlight.js/lib/languages/css'),
	diff: () => import('highlight.js/lib/languages/diff'),
	dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
	go: () => import('highlight.js/lib/languages/go'),
	ini: () => import('highlight.js/lib/languages/ini'),
	java: () => import('highlight.js/lib/languages/java'),
	javascript: () => import('highlight.js/lib/languages/javascript'),
	json: () => import('highlight.js/lib/languages/json'),
	kotlin: () => import('highlight.js/lib/languages/kotlin'),
	lua: () => import('highlight.js/lib/languages/lua'),
	markdown: () => import('highlight.js/lib/languages/markdown'),
	nginx: () => import('highlight.js/lib/languages/nginx'),
	php: () => import('highlight.js/lib/languages/php'),
	powershell: () => import('highlight.js/lib/languages/powershell'),
	python: () => import('highlight.js/lib/languages/python'),
	ruby: () => import('highlight.js/lib/languages/ruby'),
	rust: () => import('highlight.js/lib/languages/rust'),
	scss: () => import('highlight.js/lib/languages/scss'),
	sql: () => import('highlight.js/lib/languages/sql'),
	swift: () => import('highlight.js/lib/languages/swift'),
	typescript: () => import('highlight.js/lib/languages/typescript'),
	xml: () => import('highlight.js/lib/languages/xml'),
	yaml: () => import('highlight.js/lib/languages/yaml'),
};

const ALIASES: Record<string, string> = {
	sh: 'bash',
	shell: 'bash',
	zsh: 'bash',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	ts: 'typescript',
	tsx: 'typescript',
	py: 'python',
	rs: 'rust',
	rb: 'ruby',
	cs: 'csharp',
	'c#': 'csharp',
	'c++': 'cpp',
	h: 'c',
	hpp: 'cpp',
	kt: 'kotlin',
	html: 'xml',
	svg: 'xml',
	yml: 'yaml',
	toml: 'ini',
	md: 'markdown',
	ps1: 'powershell',
	docker: 'dockerfile',
	golang: 'go',
};

export function resolveLanguage(tag: string): string | null {
	const key = tag.trim().toLowerCase();
	const name = ALIASES[key] ?? key;
	return name in LOADERS ? name : null;
}

const loading = new Map<string, Promise<void>>();

export function loadLanguage(name: string): Promise<void> {
	if (hljs.getLanguage(name)) return Promise.resolve();
	let p = loading.get(name);
	if (!p) {
		p = LOADERS[name]().then((m) => {
			hljs.registerLanguage(name, m.default);
		});
		loading.set(name, p);
	}
	return p;
}

export function highlight(code: string, name: string): string {
	return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
}

export const isLanguageLoaded = (name: string) => !!hljs.getLanguage(name);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };

export type TokenRange = { from: number; to: number; className: string };

export function tokenRanges(html: string): TokenRange[] {
	const out: TokenRange[] = [];
	const open: Array<{ from: number; className: string }> = [];
	let pos = 0;
	for (let i = 0; i < html.length; ) {
		if (html[i] === '<') {
			const end = html.indexOf('>', i);
			if (end === -1) break;
			const tag = html.slice(i + 1, end);
			if (tag.startsWith('/')) {
				const o = open.pop();
				if (o && pos > o.from) out.push({ from: o.from, to: pos, className: o.className });
			} else {
				const m = /class="([^"]*)"/.exec(tag);
				open.push({ from: pos, className: m ? m[1] : '' });
			}
			i = end + 1;
		} else if (html[i] === '&') {
			const end = html.indexOf(';', i);
			if (end !== -1 && end - i <= 6 && html.slice(i + 1, end) in ENTITIES) {
				pos++;
				i = end + 1;
			} else {
				pos++;
				i++;
			}
		} else {
			pos++;
			i++;
		}
	}
	return out;
}

export function highlightRanges(code: string, name: string): TokenRange[] {
	return isLanguageLoaded(name) ? tokenRanges(highlight(code, name)) : [];
}
