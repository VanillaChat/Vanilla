/// <reference path="./worklet-env.d.ts" />
// Collects the 128-sample Web Audio quanta into fixed 5 ms frames and hands
// them straight to the media worker over a MessagePort.

class CaptureProcessor extends AudioWorkletProcessor {
	private readonly frame: number;
	private readonly channels: number;
	private buf: Float32Array;
	private fill = 0;
	private workerPort: MessagePort | null = null;
	private sumSq = 0;
	private count = 0;
	private sinceReport = 0;

	constructor(options?: { processorOptions?: Record<string, unknown> }) {
		super();
		const o = options?.processorOptions ?? {};
		this.frame = (o.frame as number) ?? 240;
		this.channels = (o.channels as number) ?? 1;
		this.buf = new Float32Array(this.frame * this.channels);
		this.port.onmessage = (e: MessageEvent) => {
			if (e.data?.port) this.workerPort = e.data.port as MessagePort;
		};
	}

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0];
		if (!input || input.length === 0) return true;
		const n = input[0].length;

		for (let i = 0; i < n; i++) {
			for (let c = 0; c < this.channels; c++) {
				const v = (input[c] ?? input[0])[i];
				this.buf[this.fill * this.channels + c] = v;
				this.sumSq += v * v;
			}
			this.count += this.channels;

			if (++this.fill === this.frame) {
				if (this.workerPort) {
					const out = this.buf;
					this.workerPort.postMessage({ pcm: out }, [out.buffer]);
					this.buf = new Float32Array(this.frame * this.channels);
				}
				this.fill = 0;
			}
		}

		this.sinceReport += n;
		if (this.sinceReport >= 2400) {
			this.port.postMessage({ level: Math.sqrt(this.sumSq / Math.max(1, this.count)) });
			this.sumSq = 0;
			this.count = 0;
			this.sinceReport = 0;
		}
		return true;
	}
}

registerProcessor('vanilla-capture', CaptureProcessor);
