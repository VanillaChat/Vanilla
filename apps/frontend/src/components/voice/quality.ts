import { t } from '../../i18n';
import type { QualityReport } from '../../voice/messages';
import { voiceSettings } from '../../voice/settings';

export function qualityLabel(q: QualityReport | null): string {
	if (!q) return '';
	if (!voiceSettings().developerMode) return t('voice-connected');
	const kbps = q.bitrate > 0 ? ` · ${Math.round(q.bitrate / 1000)} kbps` : '';
	const rtt = q.rttMs !== null ? ` · ${Math.round(q.rttMs)} ms` : '';
	const rx = q.receiveSafe ? ` · ${t('voice-rx-safe')}` : '';
	if (q.codec === 'lossless') {
		return `${t('voice-status-lossless', { depth: q.bitDepth })}${kbps}${rtt}${rx}`;
	}
	const base = q.fallback ? t('voice-status-paused') : t('voice-status-opus');
	return `${base}${kbps}${rtt}${rx}`;
}
