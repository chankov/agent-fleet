export interface Selection {
	key?: string;
	index: number;
}

/** Keep selection on its stable key where possible, otherwise clamp its index. */
export function reconcileSelection(sel: Selection, rows: readonly { key: string }[]): void {
	if (rows.length === 0) {
		sel.index = 0;
		sel.key = undefined;
		return;
	}
	const keyedIndex = sel.key === undefined ? -1 : rows.findIndex((row) => row.key === sel.key);
	sel.index = keyedIndex >= 0 ? keyedIndex : Math.max(0, Math.min(sel.index, rows.length - 1));
	sel.key = rows[sel.index].key;
}

/** Move selection by delta, clamped without wraparound. */
export function moveSelection(sel: Selection, rows: readonly { key: string }[], delta: number): void {
	reconcileSelection(sel, rows);
	if (rows.length === 0) return;
	sel.index = Math.max(0, Math.min(rows.length - 1, sel.index + delta));
	sel.key = rows[sel.index].key;
}
