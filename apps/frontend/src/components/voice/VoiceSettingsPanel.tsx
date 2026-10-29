import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { t } from '../../i18n';
import {
	audioInputs,
	audioOutputs,
	cleanerActive,
	isLoopback,
	micLevel,
	restartMic,
	setInputVolume,
	setOutputDevice,
	setOutputVolume,
	setVoiceMode,
	toggleLoopback,
	voiceStatus,
} from '../../voice/engine';
import type { VoiceMode } from '../../voice/messages';
import { SCREEN_PRESETS, updateVoiceSettings, voiceSettings } from '../../voice/settings';
import { Checkbox } from '../ui/Checkbox';
import { Select } from '../ui/Select';
import { Slider as UiSlider } from '../ui/Slider';
import { InfoTip, Tooltip } from '../ui/Tooltip';

const MODES: Array<{ id: VoiceMode; label: string; desc: string }> = [
	{ id: 'AUTO', label: 'voice-mode-auto', desc: 'voice-mode-auto-desc' },
	{ id: 'VOICE_LOSSLESS', label: 'voice-mode-voice', desc: 'voice-mode-voice-desc' },
	{ id: 'STUDIO_LOSSLESS', label: 'voice-mode-studio', desc: 'voice-mode-studio-desc' },
	{ id: 'MUSIC_LOSSLESS', label: 'voice-mode-music', desc: 'voice-mode-music-desc' },
];

function Section(props: { title: string; hint?: string; children: JSX.Element }) {
	return (
		<div class="space-y-2">
			<div class="flex items-center gap-1.5 text-xs font-display italic text-stone-500">
				<span>{props.title}</span>
				<Show when={props.hint}>{(hint) => <InfoTip text={hint()} />}</Show>
			</div>
			{props.children}
		</div>
	);
}

function Slider(props: {
	label: string;
	value: number;
	max: number;
	onInput: (v: number) => void;
}) {
	return (
		<div class="block text-sm text-stone-700 dark:text-stone-200">
			<span class="flex justify-between mb-1">
				<span>{props.label}</span>
				<span class="text-stone-400">{Math.round(props.value * 100)}%</span>
			</span>
			<UiSlider
				label={props.label}
				min={0}
				max={props.max}
				step={0.01}
				value={props.value}
				onInput={props.onInput}
			/>
		</div>
	);
}

function meterPos(level: number): number {
	const db = 20 * Math.log10(Math.max(level, 1e-5));
	return Math.min(100, Math.max(0, ((db + 80) / 60) * 100));
}

export function VoiceSettingsPanel() {
	const s = voiceSettings;
	const [capturing, setCapturing] = createSignal(false);

	const captureKey = (e: KeyboardEvent) => {
		e.preventDefault();
		if (e.code !== 'Escape') updateVoiceSettings({ pushToTalkKey: e.code });
		setCapturing(false);
		window.removeEventListener('keydown', captureKey, true);
	};

	const startCapture = () => {
		setCapturing(true);
		window.addEventListener('keydown', captureKey, true);
	};

	const deviceOptions = (devices: () => MediaDeviceInfo[]) =>
		createMemo(() => [
			{ value: '', label: t('voice-default-device') },
			...devices().map((d) => ({ value: d.deviceId, label: d.label || d.deviceId })),
		]);
	const inputOptions = deviceOptions(audioInputs);
	const outputOptions = deviceOptions(audioOutputs);
	const presetOptions = Object.entries(SCREEN_PRESETS).map(([value, p]) => ({
		value: value as keyof typeof SCREEN_PRESETS,
		label: p.label,
	}));

	const changeProcessing = (patch: Parameters<typeof updateVoiceSettings>[0]) => {
		updateVoiceSettings(patch);
		if (voiceStatus() === 'connected') void restartMic();
	};

	return (
		<div class="w-full space-y-6 text-left">
			<Section title={t('voice-mode')} hint={t('voice-lossless-note')}>
				<div class="space-y-1.5">
					<For each={MODES}>
						{(m) => (
							<Tooltip text={t(m.desc)} class="flex w-full">
								<button
									type="button"
									onClick={() => setVoiceMode(m.id)}
									class="w-full text-left rounded-xl px-3 py-2 border transition-colors"
									classList={{
										'border-[#f7e26c] bg-[#f7e26c]/20': s().mode === m.id,
										'border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800/40':
											s().mode !== m.id,
									}}
								>
									<div class="text-sm font-medium text-stone-800 dark:text-stone-100">
										{t(m.label)}
									</div>
								</button>
							</Tooltip>
						)}
					</For>
				</div>
			</Section>

			<Section title={t('voice-input-device')}>
				<Select
					options={inputOptions()}
					value={s().inputDeviceId}
					onChange={(v) => changeProcessing({ inputDeviceId: v })}
				/>
				<div class="relative h-2 rounded-full bg-stone-100 dark:bg-stone-800 overflow-hidden">
					<div
						class="h-full bg-green-500 transition-[width] duration-75"
						style={{ width: `${meterPos(micLevel())}%` }}
					/>
					<Show when={s().noiseGate}>
						<div
							class="absolute top-0 bottom-0 w-0.5 bg-[#c9a800]"
							style={{ left: `${((s().noiseGateThreshold + 80) / 60) * 100}%` }}
						/>
					</Show>
				</div>
				<Slider
					label={t('voice-input-volume')}
					value={s().inputVolume}
					max={2}
					onInput={setInputVolume}
				/>
			</Section>

			<Section title={t('voice-output-device')}>
				<Select
					options={outputOptions()}
					value={s().outputDeviceId}
					onChange={(v) => void setOutputDevice(v)}
				/>
				<Slider
					label={t('voice-output-volume')}
					value={s().outputVolume}
					max={1}
					onInput={setOutputVolume}
				/>
			</Section>

			<Show when={voiceStatus() === 'connected'}>
				<Checkbox
					label={t('voice-loopback')}
					hint={t('voice-loopback-hint')}
					checked={isLoopback()}
					onChange={toggleLoopback}
				/>
			</Show>

			<Section title={t('voice-processing')} hint={t('voice-processing-hint')}>
				<div class="space-y-2">
					<Checkbox
						label={t('voice-echo')}
						checked={s().echoCancellation}
						onChange={(v) => changeProcessing({ echoCancellation: v })}
					/>
					<Checkbox
						label={t('voice-ai-noise')}
						hint={
							s().aiNoiseSuppression && voiceStatus() === 'connected' && !cleanerActive().suppress
								? t('voice-ai-noise-failed')
								: t('voice-ai-noise-hint')
						}
						checked={s().aiNoiseSuppression}
						onChange={(v) => changeProcessing({ aiNoiseSuppression: v })}
					/>
					<Checkbox
						label={t('voice-noise')}
						checked={s().noiseSuppression}
						onChange={(v) => changeProcessing({ noiseSuppression: v })}
					/>
					<Checkbox
						label={t('voice-agc')}
						checked={s().autoGainControl}
						onChange={(v) => changeProcessing({ autoGainControl: v })}
					/>
					<Checkbox
						label={t('voice-gate')}
						hint={t('voice-gate-hint')}
						checked={s().noiseGate}
						onChange={(v) => changeProcessing({ noiseGate: v })}
					/>
					<Show when={s().noiseGate}>
						<div class="block text-sm text-stone-700 dark:text-stone-200">
							<span class="flex justify-between mb-1">
								<span>{t('voice-gate-threshold')}</span>
								<span class="text-stone-400">{s().noiseGateThreshold} dB</span>
							</span>
							<UiSlider
								label={t('voice-gate-threshold')}
								min={-80}
								max={-20}
								value={s().noiseGateThreshold}
								onInput={(v) => updateVoiceSettings({ noiseGateThreshold: v })}
								onCommit={() => changeProcessing({})}
							/>
						</div>
					</Show>
				</div>
			</Section>

			<Checkbox
				label={t('voice-sounds')}
				hint={t('voice-sounds-hint')}
				checked={s().soundEffects}
				onChange={(v) => updateVoiceSettings({ soundEffects: v })}
			/>

			<Section title={t('voice-ptt')}>
				<Checkbox
					label={t('voice-ptt')}
					checked={s().pushToTalk}
					onChange={(v) => updateVoiceSettings({ pushToTalk: v })}
				/>
				<Show when={s().pushToTalk}>
					<button
						type="button"
						onClick={startCapture}
						class="rounded-xl border border-stone-200 dark:border-stone-700 px-3 py-1.5 text-sm text-stone-700 dark:text-stone-200"
					>
						{capturing() ? t('voice-ptt-press') : s().pushToTalkKey}
					</button>
				</Show>
			</Section>

			<Section title={t('voice-screen-quality')} hint={t('voice-screen-quality-hint')}>
				<Select
					options={presetOptions}
					value={s().screenPreset}
					onChange={(v) => updateVoiceSettings({ screenPreset: v })}
				/>
			</Section>
		</div>
	);
}
