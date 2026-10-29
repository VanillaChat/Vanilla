import { createSignal, For, onMount, Show } from 'solid-js';
import { type AuditEntry, fetchAuditLog } from '../api/audit';
import { errorText } from '../api/error-text';
import { t } from '../i18n';
import { PERM_LIST, roleCss } from '../state/permissions';
import { DefaultAvatar } from './ui/DefaultAvatar';

const PLAIN_FIELDS = new Set(['name', 'description', 'slowmode', 'role', 'channel', 'maxUses']);

function permissionNames(bits: number): string {
	return PERM_LIST.filter((p) => (bits & p.bit) !== 0)
		.map((p) => t(`perm-${p.key}`))
		.join(', ');
}

function show(field: string, value: unknown): string {
	if (value === null || value === undefined || value === '') return t('audit-none');
	if (field === 'hoist') return value ? t('audit-on') : t('audit-off');
	if (field === 'color') return roleCss(Number(value)) || t('audit-none');
	if (field === 'slowmode') return Number(value) === 0 ? t('audit-off') : `${value} s`;
	return String(value);
}

/** One line per changed field, e.g. `Name: old → new`. */
function describe(entry: AuditEntry): string[] {
	const lines: string[] = [];
	for (const [field, values] of Object.entries(entry.changes ?? {})) {
		const label = t(`audit-field-${field}`);
		const [from, to] = values;
		if (field === 'order') {
			lines.push(label);
		} else if (field === 'permissions') {
			const before = Number(from);
			const after = Number(to);
			const added = permissionNames(after & ~before);
			const removed = permissionNames(before & ~after);
			if (added) lines.push(`${label}: + ${added}`);
			if (removed) lines.push(`${label}: − ${removed}`);
		} else if (values.length === 1) {
			if (PLAIN_FIELDS.has(field) || field === 'hoist')
				lines.push(`${label}: ${show(field, from)}`);
		} else {
			lines.push(`${label}: ${show(field, from)} → ${show(field, to)}`);
		}
	}
	return lines;
}

function Row(props: { entry: AuditEntry }) {
	const actor = () => props.entry.actor;
	const sentence = () =>
		t(`audit-${props.entry.action.replace('.', '-')}`, {
			actor: actor()?.username ?? t('audit-unknown-actor'),
			target: props.entry.targetName ?? '',
		});
	return (
		<li class="flex gap-3 py-3.5">
			<span class="w-9 h-9 rounded-full overflow-hidden shrink-0">
				<Show when={actor()?.avatar} fallback={<DefaultAvatar id={props.entry.actorId} />}>
					<img src={actor()?.avatar ?? ''} alt="" class="w-full h-full object-cover" />
				</Show>
			</span>
			<div class="flex-1 min-w-0">
				<div class="text-base break-words">{sentence()}</div>
				<For each={describe(props.entry)}>
					{(line) => <div class="text-sm text-stone-500 break-words">{line}</div>}
				</For>
				<div class="text-xs text-stone-400 mt-0.5">
					{new Date(props.entry.createdAt).toLocaleString([], {
						dateStyle: 'medium',
						timeStyle: 'short',
					})}
				</div>
			</div>
		</li>
	);
}

export function AuditLogPanel(props: { guildId: string }) {
	const [entries, setEntries] = createSignal<AuditEntry[]>([]);
	const [hasMore, setHasMore] = createSignal(false);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);

	const load = async (before?: string) => {
		setLoading(true);
		setError(null);
		try {
			const page = await fetchAuditLog(props.guildId, before);
			setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
			setHasMore(page.hasMore);
		} catch (err) {
			setError(errorText(err, 'audit-failed'));
		} finally {
			setLoading(false);
		}
	};
	onMount(() => void load());

	return (
		<div class="p-8">
			<Show when={error()}>
				<p class="mb-3 text-sm text-red-600 dark:text-red-400">{error()}</p>
			</Show>
			<Show
				when={entries().length > 0}
				fallback={
					<Show when={!loading()}>
						<p class="py-8 text-center text-stone-400 italic font-display">{t('audit-empty')}</p>
					</Show>
				}
			>
				<ul class="divide-y divide-stone-100 dark:divide-stone-800">
					<For each={entries()}>{(entry) => <Row entry={entry} />}</For>
				</ul>
			</Show>
			<Show when={hasMore()}>
				<button
					type="button"
					disabled={loading()}
					onClick={() => load(entries().at(-1)?.id)}
					class="mt-4 w-full rounded-xl px-4 py-2.5 text-sm bg-stone-100 dark:bg-stone-800 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-50"
				>
					{t('audit-load-more')}
				</button>
			</Show>
		</div>
	);
}
