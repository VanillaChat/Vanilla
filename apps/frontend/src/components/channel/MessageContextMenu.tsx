import { Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { t } from '../../i18n';

export type CtxMenuState = {
	x: number;
	y: number;
	messageId: string;
	content: string;
	mine: boolean;
	canDelete: boolean;
};

type Props = {
	menu: () => CtxMenuState | null;
	closing: () => boolean;
	menuRef: (el: HTMLDivElement) => void;
	onReply: (id: string) => void;
	onCopyText: (text: string) => void;
	onCopyId: (id: string) => void;
	onCopyLink: (id: string) => void;
	onEdit: (id: string, content: string) => void;
	onDelete: (id: string, content: string) => void;
	onClose: () => void;
};

export function MessageContextMenu(props: Props) {
	return (
		<Show when={props.menu()}>
			{(menu) => (
				<Portal>
					<div
						ref={props.menuRef}
						class={`fixed z-50 w-52 rounded-xl bg-white dark:bg-[#1a1816] border border-stone-200 dark:border-stone-800 shadow-xl shadow-black/15 p-1 ${
							props.closing() ? 'animate-popover-out' : 'animate-popover-in'
						}`}
						style={{
							left: `${menu().x}px`,
							top: `${menu().y}px`,
							'transform-origin': 'top left',
						}}
					>
						<button
							type="button"
							onClick={() => {
								const id = menu().messageId;
								props.onClose();
								props.onReply(id);
							}}
							class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left text-stone-700 dark:text-stone-200"
						>
							<i class="fa-solid fa-reply text-xs w-4 text-stone-500" />
							<span>{t('context-reply')}</span>
						</button>
						<div class="my-1 h-px bg-stone-100 dark:bg-stone-800" />
						<button
							type="button"
							onClick={() => {
								props.onCopyText(menu().content);
								props.onClose();
							}}
							class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left text-stone-700 dark:text-stone-200"
						>
							<i class="fa-regular fa-copy text-xs w-4 text-stone-500" />
							<span>{t('context-copy-text')}</span>
						</button>
						<button
							type="button"
							onClick={() => {
								props.onCopyId(menu().messageId);
								props.onClose();
							}}
							class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left text-stone-700 dark:text-stone-200"
						>
							<i class="fa-solid fa-hashtag text-xs w-4 text-stone-500" />
							<span>{t('context-copy-id')}</span>
						</button>
						<button
							type="button"
							onClick={() => {
								props.onCopyLink(menu().messageId);
								props.onClose();
							}}
							class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left text-stone-700 dark:text-stone-200"
						>
							<i class="fa-solid fa-link text-xs w-4 text-stone-500" />
							<span>{t('context-copy-link')}</span>
						</button>
						<Show when={menu().mine || menu().canDelete}>
							<div class="my-1 h-px bg-stone-100 dark:bg-stone-800" />
						</Show>
						<Show when={menu().mine}>
							<button
								type="button"
								onClick={() => {
									props.onEdit(menu().messageId, menu().content);
									props.onClose();
								}}
								class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-stone-100 dark:hover:bg-stone-800/60 text-left text-stone-700 dark:text-stone-200"
							>
								<i class="fa-solid fa-pen text-xs w-4 text-stone-500" />
								<span>{t('context-edit')}</span>
							</button>
						</Show>
						<Show when={menu().canDelete}>
							<button
								type="button"
								onClick={() => {
									const id = menu().messageId;
									const content = menu().content;
									props.onClose();
									props.onDelete(id, content);
								}}
								class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 text-left"
							>
								<i class="fa-solid fa-trash text-xs w-4" />
								<span>{t('context-delete')}</span>
							</button>
						</Show>
					</div>
				</Portal>
			)}
		</Show>
	);
}
