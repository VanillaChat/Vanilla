import { createResource, type JSX, Show } from 'solid-js';
import { highlight, loadLanguage, resolveLanguage } from './highlight';

type Props = {
	lang: string;
	text: string;
	plain: (text: string) => JSX.Element;
	plainOnly?: boolean;
};

export function CodeBlock(props: Props) {
	const language = () => (props.plainOnly ? null : resolveLanguage(props.lang));
	const [html] = createResource(
		() => {
			const name = language();
			return name ? { name, text: props.text } : null;
		},
		async ({ name, text }) => {
			await loadLanguage(name);
			return highlight(text, name);
		},
	);

	return (
		<pre class="my-1 rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-100 dark:bg-stone-900 p-3 text-sm font-mono overflow-x-auto whitespace-pre">
			<Show when={html()} fallback={<code>{props.plain(props.text)}</code>}>
				{(h) => <code class="hljs" innerHTML={h()} />}
			</Show>
		</pre>
	);
}
