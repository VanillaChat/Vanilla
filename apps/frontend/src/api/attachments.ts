import { ApiError } from './client';

export type Attachment = {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	width?: number | null;
	height?: number | null;
	url: string;
};

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 25_000_000;

export const attachmentUrl = (a: Pick<Attachment, 'url'>) => `${process.env.API_URL ?? ''}${a.url}`;

export const isInlineImage = (a: Attachment) =>
	a.contentType.startsWith('image/') && !!a.width && !!a.height;

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export type Upload = { promise: Promise<Attachment>; abort: () => void };

/** Uploads one file; fetch cannot report upload progress, so this uses XHR. */
export function uploadAttachment(file: File, onProgress: (fraction: number) => void): Upload {
	const xhr = new XMLHttpRequest();
	const promise = new Promise<Attachment>((resolve, reject) => {
		xhr.open('POST', `${process.env.API_URL ?? ''}/attachments`);
		xhr.withCredentials = true;
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) onProgress(e.loaded / e.total);
		};
		xhr.onerror = () => reject(new ApiError(0, 'Network error', null));
		xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
		xhr.onload = () => {
			let body: unknown = null;
			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				body = xhr.responseText || null;
			}
			if (xhr.status >= 200 && xhr.status < 300) return resolve(body as Attachment);
			const message =
				body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
					? body.message
					: `Request failed (${xhr.status})`;
			reject(new ApiError(xhr.status, message, body));
		};
		const form = new FormData();
		form.append('file', file, file.name);
		xhr.send(form);
	});
	return { promise, abort: () => xhr.abort() };
}
