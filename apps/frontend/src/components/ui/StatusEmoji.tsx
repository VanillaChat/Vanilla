import { CUSTOM_EMOJI_RE, customEmojiById, emojiUrl } from '../../state/emoji';
import { Emoji } from './Emoji';

export function StatusEmoji(props: { emoji: string }) {
	const url = () => {
		const custom = CUSTOM_EMOJI_RE.exec(props.emoji);
		return custom ? (customEmojiById(custom[2])?.src ?? '') : emojiUrl(props.emoji);
	};
	return url() ? (
		<Emoji char={props.emoji} url={url()} />
	) : (
		<span>
			{CUSTOM_EMOJI_RE.exec(props.emoji)
				? `:${CUSTOM_EMOJI_RE.exec(props.emoji)?.[1]}:`
				: props.emoji}
		</span>
	);
}
