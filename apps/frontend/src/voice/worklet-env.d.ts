// Globals available inside an AudioWorkletGlobalScope (not part of lib.dom).
declare const sampleRate: number;
declare const currentTime: number;

declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: { processorOptions?: Record<string, unknown> });
	process(
		inputs: Float32Array[][],
		outputs: Float32Array[][],
		parameters: Record<string, Float32Array>,
	): boolean;
}

declare function registerProcessor(
	name: string,
	processorCtor: new (options?: {
		processorOptions?: Record<string, unknown>;
	}) => AudioWorkletProcessor,
): void;
