import { createResource, Show } from 'solid-js';
import { api } from '../../api/client';

type Preview = {
	url: string;
	title?: string | null;
	description?: string | null;
	siteName?: string | null;
	image?: string | null;
};

// One request per link for the whole session, however often messages re-render.
const cache = new Map<string, Promise<Preview | null>>();

function load(url: string): Promise<Preview | null> {
	let hit = cache.get(url);
	if (!hit) {
		hit = api<Preview>(`/unfurl?url=${encodeURIComponent(url)}`).catch(() => null);
		cache.set(url, hit);
	}
	return hit;
}

export function LinkPreview(props: { url: string }) {
	const [preview] = createResource(() => props.url, load);

	return (
		<Show when={preview()}>
			{(p) => (
				<a
					href={p().url}
					target="_blank"
					rel="noopener noreferrer nofollow"
					class="mt-2 block max-w-md rounded-xl border-l-4 border-[#f7e26c] border-y border-r border-y-stone-200 border-r-stone-200 dark:border-y-stone-700 dark:border-r-stone-700 bg-[#fdfaf3] dark:bg-stone-900/60 p-3 hover:bg-white dark:hover:bg-stone-900 transition-colors"
				>
					<Show when={p().siteName}>
						<div class="text-[0.65rem] uppercase tracking-wide text-stone-500 mb-0.5 truncate">
							{p().siteName}
						</div>
					</Show>
					<Show when={p().title}>
						<div class="font-display text-base text-sky-700 dark:text-sky-400 line-clamp-2 break-words">
							{p().title}
						</div>
					</Show>
					<Show when={p().description}>
						<div class="mt-0.5 text-sm text-stone-600 dark:text-stone-300 line-clamp-3 break-words">
							{p().description}
						</div>
					</Show>
					<Show when={p().image}>
						{(src) => (
							<img
								src={`${process.env.API_URL ?? ''}/unfurl/image?url=${encodeURIComponent(src())}`}
								alt=""
								loading="lazy"
								referrerpolicy="no-referrer"
								class="mt-2 max-h-64 w-full rounded-lg object-cover"
								onError={(e) => e.currentTarget.remove()}
							/>
						)}
					</Show>
				</a>
			)}
		</Show>
	);
}
