import { createContext, type JSX, useContext } from 'solid-js';

export type LayoutCtx = {
	sidebarOpen: () => boolean;
	setSidebarOpen: (v: boolean) => void;
	toggleSidebar: () => void;
	membersOpen: () => boolean;
	setMembersOpen: (v: boolean) => void;
	toggleMembers: () => void;
	sidebarCollapsed: () => boolean;
	setSidebarCollapsed: (v: boolean) => void;
	sidebarPeeking: () => boolean;
	setSidebarPeeking: (v: boolean) => void;
	membersCollapsed: () => boolean;
	setMembersCollapsed: (v: boolean) => void;
	membersPeeking: () => boolean;
	setMembersPeeking: (v: boolean) => void;
	leftStyle: () => JSX.CSSProperties;
	rightStyle: () => JSX.CSSProperties;
	contentStyle: () => JSX.CSSProperties;
	isMobile: () => boolean;
};

export const LayoutContext = createContext<LayoutCtx>();

export function useLayout(): LayoutCtx {
	const c = useContext(LayoutContext);
	if (!c) throw new Error('LayoutContext missing');
	return c;
}
