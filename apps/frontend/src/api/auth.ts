import { api } from './client';

export type RegisterRequest = {
	email: string;
	password: string;
	confirmPassword: string;
	username: string;
	inviteCode?: string;
};

export type RegisterResponse = {
	id: string;
	email: string;
	username: string;
};

export function register(payload: RegisterRequest): Promise<RegisterResponse> {
	return api<RegisterResponse>('/auth/register', {
		method: 'POST',
		json: payload,
	});
}

export type LoginRequest = {
	email: string;
	password: string;
};

export type LoginResponse = {
	id: string;
	email: string;
	username: string;
};

export function login(payload: LoginRequest): Promise<LoginResponse> {
	return api<LoginResponse>('/auth/login', {
		method: 'POST',
		json: payload,
	});
}

export function logout(): Promise<void> {
	return api<void>('/auth/logout', { method: 'POST' });
}

export type Session = {
	user: {
		id: string;
		username: string;
		tag: string;
		createdAt: number;
		bot: boolean;
		status: string;
		flags: number;
		bio: string | null;
		avatar: string | null;
		banner: string | null;
	};
	account: {
		id: string;
		email: string;
		emailVerified: boolean;
		locale: string;
	};
	settings: {
		theme: string;
		compactMode: boolean;
		compactShowAvatars: boolean;
		pendingDeletion: string | null;
		deleteAt: number | null;
	};
};

export function getSession(): Promise<Session> {
	return api<Session>('/auth/session', { method: 'GET' });
}
