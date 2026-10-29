import { defaultAvatar, MARK_LEFT, MARK_RIGHT, MARK_TRANSFORM } from '../../state/default-avatar';

const SCALE = 58 / 162;

export function DefaultAvatar(props: { id: string }) {
	const spec = () => defaultAvatar(props.id);
	return (
		<svg viewBox="0 0 100 100" class="block w-full h-full" aria-hidden="true">
			<rect width="100" height="100" fill={spec().background} />
			<g transform={`translate(50 52) scale(${SCALE}) translate(-81 -67.5)`}>
				<g transform={MARK_TRANSFORM} fill={spec().mark}>
					<path d={MARK_LEFT} />
					<path d={MARK_RIGHT} />
				</g>
			</g>
		</svg>
	);
}
