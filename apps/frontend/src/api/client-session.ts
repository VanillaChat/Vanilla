const g = globalThis as { __vanillaClientSessionId?: string };

export function getClientSessionId(): string {
	if (!g.__vanillaClientSessionId) {
		g.__vanillaClientSessionId = crypto.randomUUID();
	}

	return g.__vanillaClientSessionId;
}
