// Media packet format. Mirror of voice/src/packet.rs; the known-vector test in
// protocol.test.ts and packet.rs must stay byte-identical.

export const HEADER_LEN = 16;
const VERSION = 1;

export const Kind = { Audio: 0, Video: 1 } as const;
export const Codec = { Lossless: 0, Opus: 1, Vp8: 2, H264: 3, Av1: 4, Vp9: 5 } as const;
export const Tag = { Mic: 0, ScreenAudio: 1, ScreenVideo: 2, Camera: 3 } as const;
export const Flag = { Redundant: 1, Keyframe: 2, EndOfFrame: 4, FrameStart: 32 } as const;

export const layerFlags = (layer: number) => (layer & 3) << 3;
export const layerOf = (flags: number) => (flags >> 3) & 3;

export type TagId = (typeof Tag)[keyof typeof Tag];

export interface PacketHeader {
	kind: number;
	codec: number;
	flags: number;
	tag: number;
	ssrc: number;
	seq: number;
	timestamp: number;
}

export function writePacket(h: PacketHeader, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(HEADER_LEN + payload.length);
	const view = new DataView(out.buffer);
	out[0] = (VERSION << 4) | (h.kind & 0x0f);
	out[1] = h.codec;
	out[2] = h.flags;
	out[3] = h.tag;
	view.setUint32(4, h.ssrc >>> 0, true);
	view.setUint32(8, h.seq >>> 0, true);
	view.setUint32(12, h.timestamp >>> 0, true);
	out.set(payload, HEADER_LEN);
	return out;
}

export function parsePacket(data: Uint8Array): { header: PacketHeader; body: Uint8Array } | null {
	if (data.length < HEADER_LEN || data[0] >> 4 !== VERSION) return null;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return {
		header: {
			kind: data[0] & 0x0f,
			codec: data[1],
			flags: data[2],
			tag: data[3],
			ssrc: view.getUint32(4, true),
			seq: view.getUint32(8, true),
			timestamp: view.getUint32(12, true),
		},
		body: data.subarray(HEADER_LEN),
	};
}

/** Returns the primary payload; the redundant block (unused on the reliable
 * WebSocket transport) is skipped. */
export function primaryPayload(header: PacketHeader, body: Uint8Array): Uint8Array | null {
	if ((header.flags & Flag.Redundant) === 0) return body;
	if (body.length < 4) return null;
	const len = body[0] | (body[1] << 8);
	if (4 + len > body.length) return null;
	return body.subarray(4 + len);
}
