export class ApiError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

export async function api<T>(
	path: string,
	init: RequestInit & { json?: unknown } = {},
): Promise<T> {
	const { json, headers, ...rest } = init;
	const res = await fetch(`${process.env.API_URL}${path}`, {
		...rest,
		headers: {
			'Content-Type': 'application/json',
			...(headers ?? {}),
		},
		body: json !== undefined ? JSON.stringify(json) : rest.body,
		credentials: 'include',
	});

	let body: unknown = null;
	const text = await res.text();
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}

	if (!res.ok) {
		const message =
			(body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
				? body.message
				: null) ?? `Request failed (${res.status})`;
		throw new ApiError(res.status, message, body);
	}

	return body as T;
}
