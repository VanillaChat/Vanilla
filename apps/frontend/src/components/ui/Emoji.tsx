export function Emoji(props: { char: string; url: string; big?: boolean; title?: string }) {
	return (
		<img
			src={props.url}
			alt={props.char}
			title={props.title}
			draggable={false}
			loading="lazy"
			class="inline-block align-[-0.25em] select-text object-contain"
			classList={{ 'h-[1.3em] w-[1.3em]': !props.big, 'h-10 w-10 align-middle': props.big }}
		/>
	);
}
