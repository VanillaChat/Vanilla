import { createSignal } from 'solid-js';
import {
	type Attachment,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS,
	uploadAttachment,
} from '../api/attachments';
import { errorText } from '../api/error-text';
import { t } from '../i18n';

export type PendingFile = {
	key: string;
	file: File;
	preview?: string;
	status: 'uploading' | 'done' | 'error';
	progress: number;
	attachment?: Attachment;
	error?: string;
	abort?: () => void;
};

const [pending, setPending] = createSignal<Record<string, PendingFile[]>>({});

export const pendingFor = (channelId: string): PendingFile[] => pending()[channelId] ?? [];
export const readyIds = (channelId: string) =>
	pendingFor(channelId).flatMap((p) => (p.attachment ? [p.attachment.id] : []));
export const isUploading = (channelId: string) =>
	pendingFor(channelId).some((p) => p.status === 'uploading');

let counter = 0;

function patch(channelId: string, key: string, change: Partial<PendingFile>) {
	setPending((all) => ({
		...all,
		[channelId]: (all[channelId] ?? []).map((p) => (p.key === key ? { ...p, ...change } : p)),
	}));
}

function release(p: PendingFile) {
	p.abort?.();
	if (p.preview) URL.revokeObjectURL(p.preview);
}

export function addFiles(channelId: string, files: File[]) {
	for (const file of files) {
		if (pendingFor(channelId).length >= MAX_ATTACHMENTS) break;
		const key = `f${Date.now()}-${counter++}`;
		const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
		const entry: PendingFile = { key, file, preview, status: 'uploading', progress: 0 };
		if (file.size > MAX_ATTACHMENT_BYTES || file.size === 0) {
			entry.status = 'error';
			entry.error = t(
				file.size === 0 ? 'attachments-errors-missing' : 'attachments-errors-tooLarge',
			);
		}
		setPending((all) => ({ ...all, [channelId]: [...(all[channelId] ?? []), entry] }));
		if (entry.status === 'error') continue;

		const upload = uploadAttachment(file, (progress) => patch(channelId, key, { progress }));
		patch(channelId, key, { abort: upload.abort });
		upload.promise.then(
			(attachment) =>
				patch(channelId, key, { status: 'done', progress: 1, attachment, abort: undefined }),
			(e) => {
				if (e instanceof DOMException && e.name === 'AbortError') return;
				patch(channelId, key, {
					status: 'error',
					error: errorText(e, 'attachments-upload-failed'),
					abort: undefined,
				});
			},
		);
	}
}

export function removePending(channelId: string, key: string) {
	const entry = pendingFor(channelId).find((p) => p.key === key);
	if (entry) release(entry);
	setPending((all) => ({
		...all,
		[channelId]: (all[channelId] ?? []).filter((p) => p.key !== key),
	}));
}

export function clearPending(channelId: string) {
	for (const p of pendingFor(channelId)) {
		if (p.preview) URL.revokeObjectURL(p.preview);
	}
	setPending((all) => ({ ...all, [channelId]: [] }));
}
