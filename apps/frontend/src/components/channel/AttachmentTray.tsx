import { For, Show } from 'solid-js';
import { formatBytes } from '../../api/attachments';
import { t } from '../../i18n';
import { type PendingFile, pendingFor, removePending } from '../../state/attachments';

function Chip(props: { channelId: string; p: PendingFile }) {
	return (
		<div
			class="relative w-24 shrink-0 rounded-xl overflow-hidden border bg-white dark:bg-stone-800"
			classList={{
				'border-stone-200 dark:border-stone-700': props.p.status !== 'error',
				'border-red-400': props.p.status === 'error',
			}}
			title={props.p.error ?? props.p.file.name}
		>
			<div class="h-20 flex items-center justify-center bg-stone-100 dark:bg-stone-900">
				<Show
					when={props.p.preview}
					fallback={<i class="fa-regular fa-file text-2xl text-stone-400" />}
				>
					{(src) => <img src={src()} alt="" class="w-full h-full object-cover" />}
				</Show>
			</div>
			<div class="px-1.5 py-1 text-[0.65rem] leading-tight">
				<div class="truncate">{props.p.file.name}</div>
				<div class="text-stone-500 truncate">
					{props.p.status === 'error' ? props.p.error : formatBytes(props.p.file.size)}
				</div>
			</div>
			<Show when={props.p.status === 'uploading'}>
				<div class="absolute inset-x-0 bottom-0 h-1 bg-stone-200 dark:bg-stone-700">
					<div
						class="h-full bg-[#f7e26c] transition-[width]"
						style={{ width: `${Math.round(props.p.progress * 100)}%` }}
					/>
				</div>
			</Show>
			<button
				type="button"
				onClick={() => removePending(props.channelId, props.p.key)}
				class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80"
				title={t('attachment-remove')}
				aria-label={t('attachment-remove')}
			>
				<i class="fa-solid fa-xmark text-[0.6rem]" />
			</button>
		</div>
	);
}

export function AttachmentTray(props: { channelId: () => string }) {
	return (
		<Show when={pendingFor(props.channelId()).length > 0}>
			<div class="flex gap-2 overflow-x-auto pt-1 pb-2">
				<For each={pendingFor(props.channelId())}>
					{(p) => <Chip channelId={props.channelId()} p={p} />}
				</For>
			</div>
		</Show>
	);
}
