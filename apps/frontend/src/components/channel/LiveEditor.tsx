import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { Annotation, EditorState, Prec, StateEffect } from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	placeholder as placeholderExt,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import { createEffect, onCleanup, onMount } from 'solid-js';
import { customEmojiById } from '../../state/emoji';
import { CUSTOM_EMOJI, type Deco, decorate } from '../../state/message-parse';
import {
	highlightRanges,
	isLanguageLoaded,
	loadLanguage,
	resolveLanguage,
} from '../message/highlight';
import type { EditorHandle } from './editor';

type Props = {
	value: () => string;
	placeholder: string;
	onInput: (value: string) => void;
	onKeyDown: (e: KeyboardEvent) => void;
	onPaste: (e: ClipboardEvent) => void;
	onBlur: () => void;
	onCursor: (text: string, caret: number) => void;
	handle: (h: EditorHandle) => void;
};

const fromProps = Annotation.define<boolean>();
const grammarLoaded = StateEffect.define<null>();
// Very long blocks are left plain: colouring re-runs on every keystroke.
const MAX_HIGHLIGHT_CHARS = 20_000;

const lineClass: Partial<Record<Deco['kind'], Decoration>> = {
	heading1: Decoration.line({ class: 'cm-md-h1' }),
	heading2: Decoration.line({ class: 'cm-md-h2' }),
	heading3: Decoration.line({ class: 'cm-md-h3' }),
	quote: Decoration.line({ class: 'cm-md-quote' }),
	subtext: Decoration.line({ class: 'cm-md-subtext' }),
	fence: Decoration.line({ class: 'cm-md-codeline' }),
	codeblock: Decoration.line({ class: 'cm-md-codeline' }),
};

class EmojiWidget extends WidgetType {
	constructor(
		readonly src: string,
		readonly name: string,
	) {
		super();
	}
	eq(other: EmojiWidget) {
		return other.src === this.src;
	}
	toDOM() {
		const img = document.createElement('img');
		img.src = this.src;
		img.alt = `:${this.name}:`;
		img.draggable = false;
		img.className = 'cm-emoji';
		return img;
	}
	ignoreEvent() {
		return false;
	}
}

const markClass = (kind: Deco['kind']) => Decoration.mark({ class: `cm-md-${kind}` });

function buildDecorations(view: EditorView): DecorationSet {
	const ranges = [];
	for (const d of decorate(view.state.doc.toString())) {
		if (d.kind === 'codebody') {
			const name = d.lang ? resolveLanguage(d.lang) : null;
			if (!name || d.to - d.from > MAX_HIGHLIGHT_CHARS) continue;
			if (!isLanguageLoaded(name)) {
				loadLanguage(name).then(() => view.dispatch({ effects: grammarLoaded.of(null) }));
				continue;
			}
			const code = view.state.doc.sliceString(d.from, d.to);
			for (const t of highlightRanges(code, name)) {
				ranges.push(Decoration.mark({ class: t.className }).range(d.from + t.from, d.from + t.to));
			}
		} else if (d.kind === 'customemoji') {
			const m = CUSTOM_EMOJI.exec(view.state.doc.sliceString(d.from, d.to));
			const emoji = m ? customEmojiById(m[2]) : undefined;
			if (m && emoji) {
				ranges.push(
					Decoration.replace({ widget: new EmojiWidget(emoji.src, m[1]) }).range(d.from, d.to),
				);
			} else {
				ranges.push(markClass(d.kind).range(d.from, d.to));
			}
		} else if (d.line) {
			const deco = lineClass[d.kind];
			if (deco) ranges.push(deco.range(view.state.doc.lineAt(d.from).from));
		} else {
			ranges.push(markClass(d.kind).range(d.from, d.to));
		}
	}
	return Decoration.set(ranges, true);
}

const markdownStyling = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}
		update(u: ViewUpdate) {
			if (
				u.docChanged ||
				u.transactions.some((tr) => tr.effects.some((e) => e.is(grammarLoaded)))
			) {
				this.decorations = buildDecorations(u.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);

// The caret steps over a rendered emoji as one character instead of walking through its text.
// Only the emoji widgets: marks (bold, code, ...) must stay editable character by character.
const emojiAtomic = EditorView.atomicRanges.of((view) => {
	const all = view.plugin(markdownStyling)?.decorations ?? Decoration.none;
	return all.update({ filter: (_from, _to, value) => !!value.spec.widget });
});

/**
 * The message box with markdown styled as you type. The text stays plain markdown (the
 * markers are only dimmed), so what is sent is exactly what is shown.
 */
export default function LiveEditor(props: Props) {
	let host: HTMLDivElement | undefined;
	let view: EditorView | undefined;

	onMount(() => {
		if (!host) return;
		view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: props.value(),
				extensions: [
					history(),
					markdownStyling,
					emojiAtomic,
					EditorView.lineWrapping,
					placeholderExt(props.placeholder),
					EditorView.contentAttributes.of({
						role: 'textbox',
						'aria-multiline': 'true',
						'aria-label': props.placeholder,
					}),
					Prec.highest(
						EditorView.domEventHandlers({
							keydown: (e) => {
								if (e.isComposing) return false;
								props.onKeyDown(e);
								return e.defaultPrevented;
							},
							paste: (e) => {
								props.onPaste(e);
								return e.defaultPrevented;
							},
							blur: () => {
								props.onBlur();
								return false;
							},
						}),
					),
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.updateListener.of((u) => {
						const text = u.state.doc.toString();
						if (u.docChanged && !u.transactions.some((tr) => tr.annotation(fromProps))) {
							props.onInput(text);
						}
						if (u.docChanged || u.selectionSet) props.onCursor(text, u.state.selection.main.head);
					}),
				],
			}),
		});
		props.handle({
			focus: () => view?.focus(),
			caret: () => view?.state.selection.main.head ?? 0,
			replace: (from, to, insert) => {
				view?.dispatch({
					changes: { from, to, insert },
					selection: { anchor: from + insert.length },
				});
				view?.focus();
			},
		});
	});

	createEffect(() => {
		const next = props.value();
		if (!view || next === view.state.doc.toString()) return;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: next },
			selection: { anchor: next.length },
			annotations: fromProps.of(true),
		});
	});

	onCleanup(() => view?.destroy());

	return <div ref={host} class="live-editor flex-1 min-w-0" />;
}
