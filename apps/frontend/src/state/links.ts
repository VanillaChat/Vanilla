export interface LinkPart {
	text: string;
	href?: string;
}

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

export function splitLinks(text: string): LinkPart[] {
	const parts: LinkPart[] = [];
	const re = new RegExp(URL_RE.source, 'g');
	let last = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		let url = m[0];
		const trail = TRAILING.exec(url);
		if (trail) url = url.slice(0, url.length - trail[0].length);
		if (!url) continue;
		if (m.index > last) parts.push({ text: text.slice(last, m.index) });
		parts.push({ text: url, href: url });
		last = m.index + url.length;
		re.lastIndex = last;
	}
	if (last < text.length) parts.push({ text: text.slice(last) });
	return parts;
}

export function previewableLinks(hrefs: string[], max = 2): string[] {
	const urls: string[] = [];
	for (const href of hrefs) {
		if (urls.includes(href)) continue;
		try {
			const url = new URL(href);
			if (url.origin === window.location.origin) continue;
		} catch {
			continue;
		}
		urls.push(href);
		if (urls.length >= max) break;
	}
	return urls;
}

export function inviteCodesIn(hrefs: string[]): string[] {
	const codes: string[] = [];
	for (const href of hrefs) {
		try {
			const url = new URL(href);
			const m = /^\/invite\/([\w-]+)\/?$/.exec(url.pathname);
			if (url.origin === window.location.origin && m && !codes.includes(m[1])) codes.push(m[1]);
		} catch {}
	}
	return codes;
}
