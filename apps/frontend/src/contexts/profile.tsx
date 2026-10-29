import { createContext, useContext } from 'solid-js';
import type { GatewayUser } from '../api/gateway';

export type ProfileCtx = {
	open: (user: GatewayUser, e: MouseEvent, preferRight?: boolean, preferAbove?: boolean) => void;
	openSettings: (section?: 'voice' | 'updates') => void;
};

export const ProfileContext = createContext<ProfileCtx>();

export function useProfile(): ProfileCtx {
	const c = useContext(ProfileContext);
	if (!c) throw new Error('ProfileContext missing');
	return c;
}
