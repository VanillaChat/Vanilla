import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { registerVideoSink } from '../../voice/engine';
import { voiceSettings } from '../../voice/settings';

function createRate() {
	const [rate, setRate] = createSignal(0);
	let count = 0;
	const timer = setInterval(() => {
		setRate(count);
		count = 0;
	}, 1000);
	onCleanup(() => clearInterval(timer));
	return { rate, tick: () => count++ };
}

function Stats(props: { lines: string[] }) {
	return (
		<div class="absolute top-2 left-2 pointer-events-none rounded-lg bg-black/70 px-2 py-1 font-mono text-[0.7rem] leading-snug text-green-300">
			{props.lines.map((l) => (
				<div>{l}</div>
			))}
		</div>
	);
}

export function RemoteVideo(props: { ssrc: number; tag: number }) {
	let canvas!: HTMLCanvasElement;
	const fps = createRate();
	const [size, setSize] = createSignal('');

	onMount(() => {
		const ctx = canvas.getContext('2d');
		const unregister = registerVideoSink(props.ssrc, props.tag, (frame) => {
			fps.tick();
			if (ctx) {
				if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
					canvas.width = frame.displayWidth;
					canvas.height = frame.displayHeight;
					setSize(`${frame.displayWidth}×${frame.displayHeight}`);
				}
				ctx.drawImage(frame, 0, 0);
			}
			frame.close();
		});
		onCleanup(unregister);
	});

	return (
		<div class="relative w-full h-full">
			<canvas ref={canvas} class="w-full h-full object-contain bg-black" />
			<Show when={voiceSettings().developerMode}>
				<Stats lines={[`Received: ${size() || '…'} @ ${fps.rate()} fps`]} />
			</Show>
		</div>
	);
}

export function LocalVideo(props: { stream: MediaStream | null }) {
	let video!: HTMLVideoElement;
	const fps = createRate();
	const [caps, setCaps] = createSignal('');

	createEffect(() => {
		video.srcObject = props.stream;
	});

	onMount(() => {
		let id = 0;
		const loop = () => {
			fps.tick();
			id = video.requestVideoFrameCallback(loop);
		};
		if (video.requestVideoFrameCallback) id = video.requestVideoFrameCallback(loop);
		onCleanup(() => video.cancelVideoFrameCallback?.(id));
	});

	createEffect(() => {
		if (!voiceSettings().developerMode) return;
		const read = () => {
			const s = props.stream?.getVideoTracks()[0]?.getSettings();
			if (!s) return;
			setCaps(`${s.width ?? '?'}×${s.height ?? '?'} @ ${Math.round(s.frameRate ?? 0)} fps`);
		};
		read();
		const timer = setInterval(read, 500);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<div class="relative w-full h-full">
			<video ref={video} autoplay muted playsinline class="w-full h-full object-contain bg-black" />
			<Show when={voiceSettings().developerMode}>
				<Stats lines={[`Capture: ${caps() || '…'}`, `Measured: ${fps.rate()} fps`]} />
			</Show>
		</div>
	);
}
