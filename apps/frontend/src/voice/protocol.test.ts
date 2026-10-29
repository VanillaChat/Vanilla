import { describe, expect, test } from 'bun:test';
import { Codec, Flag, Kind, parsePacket, primaryPayload, Tag, writePacket } from './protocol';

describe('packet format', () => {
	test('matches the Rust known vector', () => {
		const bytes = writePacket(
			{
				kind: Kind.Audio,
				codec: Codec.Lossless,
				flags: 0,
				tag: Tag.Mic,
				ssrc: 0xdeadbeef,
				seq: 7,
				timestamp: 1680,
			},
			new Uint8Array(),
		);
		expect(Array.from(bytes)).toEqual([
			0x10, 0, 0, 0, 0xef, 0xbe, 0xad, 0xde, 7, 0, 0, 0, 0x90, 0x06, 0, 0,
		]);
	});

	test('roundtrip and payload view', () => {
		const payload = new Uint8Array([1, 2, 3]);
		const pkt = writePacket(
			{
				kind: Kind.Video,
				codec: Codec.Vp8,
				flags: Flag.Keyframe,
				tag: Tag.ScreenVideo,
				ssrc: 5,
				seq: 0xffffffff,
				timestamp: 90,
			},
			payload,
		);
		const parsed = parsePacket(pkt);
		expect(parsed?.header.seq).toBe(0xffffffff);
		expect(parsed?.header.flags).toBe(Flag.Keyframe);
		expect(Array.from(parsed?.body ?? [])).toEqual([1, 2, 3]);
	});

	test('rejects garbage', () => {
		expect(parsePacket(new Uint8Array(4))).toBeNull();
		const bad = new Uint8Array(16);
		bad[0] = 0x20;
		expect(parsePacket(bad)).toBeNull();
	});

	test('skips redundant block', () => {
		const header = {
			kind: 0,
			codec: 0,
			flags: Flag.Redundant,
			tag: 0,
			ssrc: 1,
			seq: 1,
			timestamp: 0,
		};
		const body = new Uint8Array([2, 0, 240, 0, 9, 9, 7, 7, 7]);
		expect(Array.from(primaryPayload(header, body) ?? [])).toEqual([7, 7, 7]);
		expect(primaryPayload(header, new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
	});
});
