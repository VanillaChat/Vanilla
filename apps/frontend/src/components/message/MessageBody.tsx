import { createSignal, For, type JSX, Match, Show, Switch } from 'solid-js';
import { useProfile } from '../../contexts/profile';
import { customEmojiById, isEmojiOnly, splitEmoji } from '../../state/emoji';
import { currentUser, findUserByUsername } from '../../state/gateway-data';
import { inviteCodesIn, previewableLinks } from '../../state/links';
import { isBroadcast } from '../../state/mentions';
import { type Block, type Inline, linksIn, parseMessage } from '../../state/message-parse';
import { InviteEmbed } from '../channel/InviteEmbed';
import { LinkPreview } from '../channel/LinkPreview';
import { Emoji } from '../ui/Emoji';
import { CodeBlock } from './CodeBlock';
import { EmojiCard } from './EmojiCard';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LINK = 'text-sky-600 dark:text-sky-400';
const PING_SELF = 'bg-[#f7e26c]/60 dark:bg-[#f7e26c]/30 text-stone-900 dark:text-[#f7e26c]';
const PING_OTHER = 'bg-stone-200/70 dark:bg-stone-700/60 text-stone-700 dark:text-stone-200';
const CODE = 'rounded px-1 py-px bg-stone-200/70 dark:bg-stone-800 font-mono text-[0.85em]';

type Props = {
	text: string;
	/**
	 * `full`: markdown blocks, clickable links and mentions, and embeds, for the message list.
	 * `inline`: one line of the same formatting as inert spans, safe inside buttons and previews.
	 */
	mode?: 'full' | 'inline';
	highlight?: string[];
	maxLength?: number;
};

function excerpt(text: string, re: RegExp | null, max: number | undefined): string {
	if (!max || text.length <= max) return text;
	const hit = re ? text.search(re) : -1;
	const start = Math.max(0, hit - 80);
	const end = Math.min(text.length, start + max);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function Spoiler(props: { children: JSX.Element; inert: boolean }) {
	const [revealed, setRevealed] = createSignal(false);
	const base = 'rounded px-0.5 transition-colors';
	const hidden = 'bg-stone-700 dark:bg-stone-600 text-transparent select-none';
	return (
		<Show when={!props.inert} fallback={<span class={`${base} ${hidden}`}>{props.children}</span>}>
			<button
				type="button"
				onClick={() => setRevealed(true)}
				class={base}
				classList={{
					'bg-stone-200/70 dark:bg-stone-700/60': revealed(),
					[hidden]: !revealed(),
					'cursor-pointer': !revealed(),
				}}
			>
				{props.children}
			</button>
		</Show>
	);
}

export function MessageBody(props: Props) {
	const profile = useProfile();
	const full = () => props.mode !== 'inline';
	const pattern = () =>
		props.highlight?.length
			? new RegExp(`(${props.highlight.map(escapeRegExp).join('|')})`, 'gi')
			: null;
	const blocks = () => parseMessage(excerpt(props.text, pattern(), props.maxLength));
	const hrefs = () => linksIn(parseMessage(props.text));

	const marked = (text: string): JSX.Element => {
		const re = pattern();
		if (!re) return text;
		// `split` with one capture group puts the matches at the odd positions.
		return text
			.split(re)
			.map((part, i) =>
				i % 2 === 1 ? <mark class="bg-[#f7e26c] text-stone-900 rounded px-0.5">{part}</mark> : part,
			);
	};

	const jumbo = () => full() && isEmojiOnly(props.text);

	const withEmoji = (text: string): JSX.Element =>
		splitEmoji(text).map((part) =>
			part.emoji ? (
				<Emoji char={part.text} url={part.emoji.url} big={jumbo()} />
			) : (
				marked(part.text)
			),
		);

	const pingClass = (userId: string) => (userId === currentUser()?.id ? PING_SELF : PING_OTHER);

	const renderInline = (node: Inline): JSX.Element => {
		switch (node.type) {
			case 'text':
				return withEmoji(node.text);
			case 'emoji': {
				const e = customEmojiById(node.id);
				if (!e) return `:${node.name}:`;
				if (!full()) {
					return <Emoji char={`:${e.name}:`} url={e.src} big={jumbo()} />;
				}
				return <EmojiCard emoji={e} big={jumbo()} />;
			}
			case 'code':
				return <code class={CODE}>{marked(node.text)}</code>;
			case 'bold':
				return <strong>{renderInlines(node.children)}</strong>;
			case 'italic':
				return <em>{renderInlines(node.children)}</em>;
			case 'underline':
				return <span class="underline underline-offset-2">{renderInlines(node.children)}</span>;
			case 'strike':
				return <s>{renderInlines(node.children)}</s>;
			case 'spoiler':
				return <Spoiler inert={!full()}>{renderInlines(node.children)}</Spoiler>;
			case 'link':
				if (!full()) return <span class={`${LINK} break-all`}>{renderInlines(node.children)}</span>;
				return (
					<a
						href={node.href}
						target="_blank"
						rel="noopener noreferrer nofollow"
						title={node.href}
						class={`${LINK} hover:underline underline-offset-2`}
					>
						{renderInlines(node.children)}
					</a>
				);
			case 'mention': {
				if (isBroadcast(node.name)) {
					return <span class={`rounded px-1 font-medium ${PING_SELF}`}>{marked(node.text)}</span>;
				}
				const user = findUserByUsername(node.name);
				if (!user) return marked(node.text);
				const cls = `rounded px-1 font-medium ${pingClass(user.id)}`;
				if (!full()) return <span class={cls}>{marked(node.text)}</span>;
				return (
					<button
						type="button"
						onClick={(e) => profile.open(user, e, true)}
						class={`${cls} cursor-pointer transition-colors hover:brightness-95`}
					>
						{marked(node.text)}
					</button>
				);
			}
		}
	};
	const renderInlines = (nodes: Inline[]): JSX.Element => <For each={nodes}>{renderInline}</For>;

	const renderBlock = (block: Block): JSX.Element => (
		<Switch>
			<Match when={block.type === 'paragraph' && block}>
				{(b) => renderInlines((b() as Extract<Block, { type: 'paragraph' }>).children)}
			</Match>
			<Match when={block.type === 'heading' && (block as Extract<Block, { type: 'heading' }>)}>
				{(b) => (
					<div
						class="font-display font-semibold leading-snug mt-1 whitespace-normal"
						classList={{
							'text-2xl': b().level === 1,
							'text-xl': b().level === 2,
							'text-lg': b().level === 3,
						}}
					>
						{renderInlines(b().children)}
					</div>
				)}
			</Match>
			<Match when={block.type === 'subtext' && (block as Extract<Block, { type: 'subtext' }>)}>
				{(b) => (
					<div class="text-xs leading-snug text-stone-500 dark:text-stone-400 whitespace-normal">
						{renderInlines(b().children)}
					</div>
				)}
			</Match>
			<Match when={block.type === 'quote' && (block as Extract<Block, { type: 'quote' }>)}>
				{(b) => (
					<div class="border-l-4 border-stone-300 dark:border-stone-600 pl-3 my-0.5 text-stone-600 dark:text-stone-400">
						{renderInlines(b().children)}
					</div>
				)}
			</Match>
			<Match when={block.type === 'list' && (block as Extract<Block, { type: 'list' }>)}>
				{(b) => {
					const items = () => (
						<For each={b().items}>{(item) => <li>{renderInlines(item)}</li>}</For>
					);
					return (
						<Show
							when={b().ordered}
							fallback={<ul class="list-disc pl-6 my-0.5 whitespace-normal">{items()}</ul>}
						>
							<ol class="list-decimal pl-6 my-0.5 whitespace-normal">{items()}</ol>
						</Show>
					);
				}}
			</Match>
			<Match when={block.type === 'codeblock' && (block as Extract<Block, { type: 'codeblock' }>)}>
				{(b) => (
					<CodeBlock
						lang={b().lang}
						text={b().text}
						plain={marked}
						plainOnly={!!props.highlight?.length}
					/>
				)}
			</Match>
		</Switch>
	);

	const renderFlat = (block: Block): JSX.Element => {
		switch (block.type) {
			case 'list':
				return <For each={block.items}>{(item) => <>{renderInlines(item)} </>}</For>;
			case 'codeblock':
				return <code class={CODE}>{marked(block.text)}</code>;
			default:
				return renderInlines(block.children);
		}
	};

	return (
		<>
			<Show when={full()} fallback={<For each={blocks()}>{(b) => <>{renderFlat(b)} </>}</For>}>
				<For each={blocks()}>{renderBlock}</For>
			</Show>
			<Show when={full()}>
				<For each={inviteCodesIn(hrefs())}>{(code) => <InviteEmbed code={code} />}</For>
				<For each={previewableLinks(hrefs())}>{(url) => <LinkPreview url={url} />}</For>
			</Show>
		</>
	);
}
