import { ApiError, api } from './client';
import { type GatewayUser, upsertUser } from './gateway';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageKind = 'avatar' | 'banner';

function applyOwn(user: GatewayUser): GatewayUser {
	upsertUser(user);
	return user;
}

export async function updateProfile(patch: {
	bio?: string;
	avatar?: null;
	banner?: null;
}): Promise<GatewayUser> {
	return applyOwn(await api<GatewayUser>('/users/@me', { method: 'PATCH', json: patch }));
}

export async function uploadProfileImage(kind: ImageKind, file: File): Promise<GatewayUser> {
	const form = new FormData();
	form.set('image', file);
	const res = await fetch(`${process.env.API_URL ?? ''}/users/@me/${kind}`, {
		method: 'POST',
		body: form,
		credentials: 'include',
	});
	const text = await res.text();
	let body: unknown = null;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		body = text;
	}
	if (!res.ok) {
		const message =
			body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
				? body.message
				: `Request failed (${res.status})`;
		throw new ApiError(res.status, message, body);
	}
	return applyOwn(body as GatewayUser);
}
