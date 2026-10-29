import { FluentBundle, FluentResource, type FluentVariable } from '@fluent/bundle';
import { createSignal } from 'solid-js';
import enRaw from './locales/en.ftl?raw';

const bundles = new Map<string, FluentBundle>();

function makeBundle(locale: string, ftl: string) {
	const b = new FluentBundle(locale, { useIsolating: false });
	b.addResource(new FluentResource(ftl));
	return b;
}

bundles.set('en', makeBundle('en', enRaw));

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('vanilla-locale') : null;

const [locale, _setLocale] = createSignal<string>(stored ?? 'en');

export const currentLocale = locale;

export function setCurrentLocale(l: string) {
	if (typeof localStorage !== 'undefined') localStorage.setItem('vanilla-locale', l);
	_setLocale(l);
}

export const availableLocales = (): string[] => Array.from(bundles.keys());

export function hasMessage(id: string): boolean {
	const b = bundles.get(locale()) ?? bundles.get('en');
	return !!b?.getMessage(id)?.value;
}

export function t(id: string, args?: Record<string, FluentVariable>): string {
	const b = bundles.get(locale()) ?? bundles.get('en');
	if (!b) return id;
	const msg = b.getMessage(id);
	if (!msg?.value) return id;
	return b.formatPattern(msg.value, args, []);
}
