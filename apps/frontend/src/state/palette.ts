export const PALETTE = [
	'#f7e26c',
	'#a8c8ff',
	'#ffb3a8',
	'#c4f0a8',
	'#e8a8ff',
	'#ffd9a8',
	'#a8e8e0',
	'#d4b8ff',
	'#ffc4d4',
	'#b8d4a8',
];

export function colorForId(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return PALETTE[Math.abs(h) % PALETTE.length];
}
