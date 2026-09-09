/** Overlay options for a full-screen pi overlay. */
export const FULLSCREEN_OVERLAY = {
	overlay: true as const,
	overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
} as const;

/** Minimum body height below which an overlay degrades rather than breaks. */
export const MIN_BODY_ROWS = 6;

/** Return the fixed scrolling-body budget for a terminal. */
export function bodyRows(terminalRows: number | undefined, chromeRows: number, min = MIN_BODY_ROWS): number {
	const rows = terminalRows && terminalRows > 0 ? terminalRows : 30;
	return Math.max(min, rows - 1 - Math.max(0, chromeRows));
}

/** Pad with empty strings or truncate to exactly n lines. */
export function fitToHeight(lines: readonly string[], n: number): string[] {
	const height = Math.max(0, n);
	return [...lines.slice(0, height), ...Array(Math.max(0, height - lines.length)).fill("")];
}

/** Clamp a scroll offset to the available content window. */
export function clampScroll(offset: number, contentLength: number, viewport: number): number {
	const max = Math.max(0, contentLength - Math.max(0, viewport));
	return Math.max(0, Math.min(offset, max));
}
