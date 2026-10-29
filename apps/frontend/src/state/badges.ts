export type BadgeInfo = { icon: string; color: string };

export const BADGES: Record<string, BadgeInfo> = {
	staff: { icon: 'fa-shield-halved', color: '#f7e26c' },
	early_adopter: { icon: 'fa-seedling', color: '#7fbf7f' },
	contributor: { icon: 'fa-code-branch', color: '#a8c8ff' },
	supporter: { icon: 'fa-heart', color: '#e58474' },
	bug_hunter: { icon: 'fa-bug', color: '#c792ea' },
};

export const knownBadges = (ids: string[] | undefined) => (ids ?? []).filter((id) => id in BADGES);
