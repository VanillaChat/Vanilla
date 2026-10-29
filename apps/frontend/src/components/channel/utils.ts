import type { Message } from '../../api/messages';
import { t } from '../../i18n';

export const formatCooldown = (s: number) => {
	if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
	if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
	return `${s}s`;
};

export const previewText = (m: Pick<Message, 'content' | 'attachments'>) =>
	m.content ||
	(m.attachments?.length ? t('attachment-label', { count: m.attachments.length }) : '');
