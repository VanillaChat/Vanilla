import type { UserStatus } from '../api/gateway';
import { avatarBackdrop } from '../state/default-avatar';
import { DefaultAvatar } from './ui/DefaultAvatar';

export const statusColors: Record<UserStatus, string> = {
	ONLINE: '#7fbf7f',
	IDLE: '#e8c054',
	DND: '#e58474',
	LOOKING_TO_PLAY: '#a8c8ff',
	UNAVAILABLE: '#b8b0a4',
};

export const statusLabels: Record<UserStatus, string> = {
	ONLINE: 'online',
	IDLE: 'away',
	DND: 'do not disturb',
	LOOKING_TO_PLAY: 'looking to play',
	UNAVAILABLE: 'offline',
};

type AvatarUser = {
	id: string;
	username: string;
	avatar?: string | null;
};

export function Avatar(props: {
	user: AvatarUser;
	status?: UserStatus;
	size?: number;
	ringColor?: string;
}) {
	const size = props.size ?? 36;
	return (
		<div class="relative shrink-0" style={{ width: `${size}px`, height: `${size}px` }}>
			<div
				class="w-full h-full rounded-full overflow-hidden flex items-center justify-center font-display text-stone-900 shadow-[0_2px_6px_rgba(0,0,0,0.06)]"
				style={{
					'background-color': avatarBackdrop(props.user.id, !!props.user.avatar),
					'font-size': `${size * 0.45}px`,
				}}
			>
				{props.user.avatar ? (
					<img src={props.user.avatar} alt="" class="w-full h-full object-cover" />
				) : (
					<DefaultAvatar id={props.user.id} />
				)}
			</div>
			<span
				class="absolute -bottom-0.5 -right-0.5 rounded-full"
				style={{
					width: `${Math.max(8, size * 0.3)}px`,
					height: `${Math.max(8, size * 0.3)}px`,
					'background-color': statusColors[props.status ?? 'UNAVAILABLE'],
					'box-shadow': `0 0 0 2.5px ${props.ringColor ?? 'var(--page-bg)'}`,
				}}
			/>
		</div>
	);
}
