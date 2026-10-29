import { describe, expect, test } from 'bun:test';
import { defaultAvatar } from './default-avatar';

describe('defaultAvatar', () => {
	test('is stable for an id and varies between ids', () => {
		expect(defaultAvatar('123')).toEqual(defaultAvatar('123'));
		const seen = new Set(
			['1', '22', '333', '4444', '55555', '666666'].map((id) => defaultAvatar(id).background),
		);
		expect(seen.size).toBeGreaterThan(2);
	});

	test('colours are valid hex, background darker than mark', () => {
		const spec = defaultAvatar('98765');
		expect(spec.background).toMatch(/^#[0-9a-f]{6}$/);
		expect(spec.mark).toMatch(/^#[0-9a-f]{6}$/);
		const lum = (c: string) => Number.parseInt(c.slice(1, 3), 16);
		expect(lum(spec.background)).toBeLessThan(lum(spec.mark));
	});
});
