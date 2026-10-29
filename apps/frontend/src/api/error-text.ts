import { hasMessage, t } from '../i18n';
import { ApiError } from './client';

export function errorText(e: unknown, fallbackKey: string): string {
	if (e instanceof ApiError && e.body && typeof e.body === 'object') {
		const { code, message } = e.body as { code?: unknown; message?: unknown };
		for (const raw of [message, code]) {
			// Fluent ids cannot contain dots: `friends.errors.self` is `friends-errors-self`.
			const id = typeof raw === 'string' ? raw.replaceAll('.', '-') : '';
			if (hasMessage(id)) return t(id);
		}
	}
	return t(fallbackKey);
}
