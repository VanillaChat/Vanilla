import { describe, expect, test } from 'bun:test';
import { type PcmFrame, StreamBuffer } from './jitter';

const N = 240;

function frame(seq: number, ts = seq * N, value = 0.5): PcmFrame {
	return { seq, ts, n: N, l: new Float32Array(N).fill(value), r: new Float32Array(N).fill(value) };
}

function render(b: StreamBuffer, blocks: number, len = 128) {
	const l = new Float32Array(len);
	const r = new Float32Array(len);
	const out: number[] = [];
	for (let i = 0; i < blocks; i++) {
		l.fill(0);
		r.fill(0);
		b.mixInto(l, r, 0, len, 1);
		out.push(l.reduce((a, v) => a + Math.abs(v), 0));
	}
	return out;
}

describe('StreamBuffer', () => {
	test('stays silent until the target is buffered, then plays', () => {
		const b = new StreamBuffer();
		b.push(frame(0));
		expect(render(b, 1)[0]).toBe(0);
		for (let i = 1; i < 4; i++) b.push(frame(i));
		expect(render(b, 1)[0]).toBeGreaterThan(0);
	});

	test('drops late and duplicate packets', () => {
		const b = new StreamBuffer();
		b.push(frame(5));
		b.push(frame(5));
		b.push(frame(4));
		expect(b.stats().late).toBe(2);
	});

	test('conceals a short gap with silence and counts it', () => {
		const b = new StreamBuffer();
		b.push(frame(0));
		b.push(frame(1));
		b.push(frame(3)); // seq 2 lost
		expect(b.stats().concealed).toBe(1);
		expect(b.stats().bufferedMs).toBeCloseTo((N * 4 * 1000) / 48000, 3);
	});

	test('real underrun raises the target, a muted pause does not', () => {
		const stalled = new StreamBuffer();
		for (let i = 0; i < 4; i++) stalled.push(frame(i));
		render(stalled, 30); // drain + underrun
		const before = stalled.stats().targetMs;
		stalled.push(frame(4));
		expect(stalled.stats().targetMs).toBeGreaterThan(before);

		const paused = new StreamBuffer();
		for (let i = 0; i < 4; i++) paused.push(frame(i));
		render(paused, 30);
		render(paused, 400); // > 250 ms of nothing: sender stopped
		const t = paused.stats().targetMs;
		paused.push(frame(200, 200 * N));
		expect(paused.stats().targetMs).toBe(t);
		expect(paused.stats().underruns).toBe(0);
	});

	test('burst arrival is trimmed so latency does not accumulate', () => {
		const b = new StreamBuffer();
		for (let i = 0; i < 100; i++) b.push(frame(i)); // 500 ms at once
		const s = b.stats();
		expect(s.bufferedMs).toBeLessThan(s.targetMs + 45);
		expect(s.dropped).toBeGreaterThan(0);
	});

	test('mixes streams additively and reports level', () => {
		const a = new StreamBuffer();
		const c = new StreamBuffer();
		for (let i = 0; i < 4; i++) {
			a.push(frame(i, i * N, 0.25));
			c.push(frame(i, i * N, 0.25));
		}
		render(a, 3);
		render(c, 3);
		const l = new Float32Array(128);
		const r = new Float32Array(128);
		a.mixInto(l, r, 0, 128, 1);
		c.mixInto(l, r, 0, 128, 1);
		expect(l[100]).toBeCloseTo(0.5, 5);
		expect(a.takeLevel()).toBeGreaterThan(0.2);
		expect(a.takeLevel()).toBe(0);
	});

	test('resetSeq accepts a new sequence space (layer switch) without counting late', () => {
		const b = new StreamBuffer();
		b.push(frame(500, 0));
		b.push(frame(501, N));
		b.resetSeq();
		b.push(frame(3, 2 * N)); // other layer, lower seq, continuous timestamps
		expect(b.stats().late).toBe(0);
		expect(b.stats().concealed).toBe(0);
	});

	test('wrapping sequence numbers are accepted', () => {
		const b = new StreamBuffer();
		b.push(frame(0xfffffffe, 1000));
		b.push(frame(0xffffffff, 1000 + N));
		b.push(frame(0, 1000 + 2 * N));
		expect(b.stats().late).toBe(0);
	});
});
