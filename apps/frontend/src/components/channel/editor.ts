export interface EditorHandle {
	focus(): void;
	caret(): number;
	replace(from: number, to: number, insert: string): void;
}
