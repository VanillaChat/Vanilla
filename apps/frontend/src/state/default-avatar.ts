import { colorForId } from './palette';

export const MARK_LEFT =
	'M206.73 386.677C220.279 386.131 234.211 386.475 247.841 386.358C275.29 386.245 307.522 383.182 324.811 409.637C334.749 424.842 343.429 441.595 352.401 457.507L377.493 502.033C409.242 558.462 406.181 550.35 374.976 604.878C363.3 628.169 347.068 637.77 331.123 611.215C321.816 595.715 313.091 579.591 304.195 563.823L257.663 481.096C251.502 470.032 205.943 391.667 205.585 387.812L206.73 386.677Z';
export const MARK_RIGHT =
	'M424.339 386.608C432.776 385.969 446.405 386.298 455.124 386.311C468.311 386.33 484.632 385.632 497.423 387.646C494.63 395.619 482.246 416.206 477.527 424.53L436.636 497.032C432.816 504.085 429.828 509.582 424.521 515.657C418.552 508.887 390.363 458.963 386.149 449.35C384.197 444.969 382.863 440.339 382.185 435.591C380.647 424.704 383.598 413.659 390.359 404.99C398.939 393.817 410.643 388.492 424.339 386.608Z';
export const MARK_TRANSFORM = 'matrix(0.553097 0 0 0.553279 -113.385 -213.012)';

export type DefaultAvatarSpec = {
	background: string;
	mark: string;
};

const channels = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

const toHex = (r: number, g: number, b: number) =>
	`#${[r, g, b]
		.map((v) =>
			Math.round(v * 255)
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;

function hsv(hex: string, saturation: number, value: number): string {
	const [r, g, b] = channels(hex);
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
	}
	h = (h < 0 ? h + 6 : h) / 6;
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = value * (1 - saturation);
	const q = value * (1 - f * saturation);
	const t = value * (1 - (1 - f) * saturation);
	const [rr, gg, bb] = (
		[
			[value, t, p],
			[q, value, p],
			[p, value, t],
			[p, q, value],
			[t, p, value],
			[value, p, q],
		] as const
	)[i % 6];
	return toHex(rr, gg, bb);
}

const lighten = (hex: string, amount: number) => {
	const [r, g, b] = channels(hex);
	return toHex(r + (1 - r) * amount, g + (1 - g) * amount, b + (1 - b) * amount);
};

export function defaultAvatar(id: string): DefaultAvatarSpec {
	const color = colorForId(id);
	return {
		background: hsv(color, 0.55, 0.4),
		mark: lighten(color, 0.35),
	};
}

/**
 * Colour behind a picture's container. The default is drawn edge to edge, so its own deep
 * colour must sit behind it: anything lighter shows as a fringe on the antialiased circle.
 */
export const avatarBackdrop = (id: string, hasImage: boolean) =>
	hasImage ? colorForId(id) : defaultAvatar(id).background;
