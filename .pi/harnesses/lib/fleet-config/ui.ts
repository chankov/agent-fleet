/**
 * fleet-config/ui — the pi overlay host shared by the Hub (`/af-config`,
 * Alt+,) and coms peers. Collection, rows and key handling live in the pure
 * modules; this file only maps pi keys, owns the overlay lifecycle and the
 * read-only file viewer. Phase 1 writes nothing.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULLSCREEN_OVERLAY, bodyRows, clampScroll, fitToHeight } from "../fleet-overlay.ts";
import { createPanelResources } from "../fleet-panel.ts";
import { safeTerminalText } from "../fleet-strip-view.ts";
import { collectFleetConfigSnapshot, sourceDigests, type FleetConfigSnapshot, type SnapshotInput, type SourceId } from "./snapshot.ts";
import { fleetConfigTransition, KEYS } from "./transition.ts";
import { fleetConfigHeadlessText, FLEET_CONFIG_CHROME_ROWS, initialViewState, renderFleetConfig, resolveTabArgument, TAB_LABELS } from "./view.ts";

export type FleetConfigDeps = Pick<SnapshotInput, "readHubOverrides" | "livePeerNames" | "runtimeRows"> & { latestKnownVersion?: () => string | null | undefined };
export interface FleetConfigUiContext { cwd: string; hasUI: boolean; ui: Pick<ExtensionContext["ui"], "custom" | "notify"> }
const metrics = { truncateToWidth, visibleWidth };
const VIEWER_MAX_BYTES = 256 * 1024;

/** Map pi key ids to the normalized sequences the pure transition understands. */
export function toTransitionInput(data: string): string {
	if (matchesKey(data, Key.up)) return KEYS.up;
	if (matchesKey(data, Key.down)) return KEYS.down;
	if (matchesKey(data, Key.left)) return KEYS.left;
	if (matchesKey(data, Key.right)) return KEYS.right;
	if (matchesKey(data, Key.pageUp)) return KEYS.pageUp;
	if (matchesKey(data, Key.pageDown)) return KEYS.pageDown;
	if (matchesKey(data, Key.enter)) return KEYS.enter;
	if (matchesKey(data, Key.escape)) return KEYS.escape;
	if (matchesKey(data, "shift+tab")) return KEYS.shiftTab;
	if (matchesKey(data, Key.tab)) return KEYS.tab;
	return data;
}

/** Read-only viewer lines for a workspace-relative file; never follows the user's edits anywhere. */
export function fileViewerLines(root: string, relativePath: string): string[] {
	try {
		const bytes = readFileSync(join(root, relativePath));
		if (bytes.length > VIEWER_MAX_BYTES) return [`(file is ${bytes.length} bytes; viewer shows files up to ${VIEWER_MAX_BYTES} bytes)`];
		if (bytes.includes(0)) return ["(binary file; not shown)"];
		return bytes.toString("utf8").split("\n").map((line, index) => `${String(index + 1).padStart(4)} │ ${safeTerminalText(line) || ""}`);
	} catch (error) { return [`(cannot read ${relativePath}: ${(error as NodeJS.ErrnoException).code ?? "error"})`]; }
}

export function renderFileViewer(title: string, lines: readonly string[], scroll: number, width: number, bodyHeight: number, theme: { bold(text: string): string; fg(color: string, text: string): string }): string[] {
	const w = Math.max(1, width);
	const offset = clampScroll(scroll, lines.length, Math.max(1, bodyHeight));
	const body = lines.slice(offset, offset + Math.max(0, bodyHeight)).map(line => truncateToWidth(line, w));
	return fitToHeight([truncateToWidth(theme.bold(`FLEET CONFIG · ${safeTerminalText(title)} · read-only`), w), ...fitToHeight(body, Math.max(0, bodyHeight)), truncateToWidth(theme.fg("dim", `↑↓ PgUp PgDn scroll · q/Esc back · ${Math.min(lines.length, offset + body.length)}/${lines.length} lines`), w)], bodyHeight + 2);
}

export function createFleetConfigUi(deps: FleetConfigDeps = {}) {
	let startDigests: Partial<Record<SourceId, string>> | undefined;
	const collect = (cwd: string): FleetConfigSnapshot => collectFleetConfigSnapshot({
		cwd, startDigests, readHubOverrides: deps.readHubOverrides, livePeerNames: deps.livePeerNames, runtimeRows: deps.runtimeRows,
		latestKnownVersion: (() => { try { return deps.latestKnownVersion?.() ?? null; } catch { return null; } })(),
	});

	/** Remember the on-disk digests at session start so the screen can mark later edits. */
	function recordBaseline(cwd: string): void {
		try { startDigests = sourceDigests(collectFleetConfigSnapshot({ cwd, readHubOverrides: undefined, livePeerNames: undefined, runtimeRows: undefined })); } catch { startDigests = undefined; }
	}

	function headlessText(cwd: string, args = ""): string {
		const snapshot = collect(cwd);
		const tab = resolveTabArgument(args, snapshot);
		return tab ? fleetConfigHeadlessText(snapshot, tab) : `Unknown /af-config tab "${safeTerminalText(args)}". Tabs: ${Object.values(TAB_LABELS).join(", ")}.`;
	}

	async function openViewer(ctx: FleetConfigUiContext, root: string, relativePath: string): Promise<void> {
		const lines = fileViewerLines(root, relativePath);
		let scroll = 0;
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: unknown) => void) => ({
			render: (width: number) => renderFileViewer(relativePath, lines, scroll, width, bodyRows(tui.terminal?.rows, 2), theme),
			handleInput: (data: string) => {
				const input = toTransitionInput(data);
				const page = Math.max(1, bodyRows(tui.terminal?.rows, 2));
				if (input === "q" || input === KEYS.escape) { done(); return; }
				if (input === KEYS.up) scroll = Math.max(0, scroll - 1);
				else if (input === KEYS.down) scroll = clampScroll(scroll + 1, lines.length, page);
				else if (input === KEYS.pageUp) scroll = Math.max(0, scroll - page);
				else if (input === KEYS.pageDown) scroll = clampScroll(scroll + page, lines.length, page);
				else if (input === "g") scroll = 0;
				else if (input === "G") scroll = clampScroll(lines.length, lines.length, page);
				tui.requestRender();
			},
			invalidate() {}, dispose() {},
		}), FULLSCREEN_OVERLAY);
	}

	/** `/af-config [tab]` and Alt+, — headless sessions get the same model as notify text. */
	async function open(ctx: FleetConfigUiContext, args = ""): Promise<void> {
		if (!ctx.hasUI || typeof ctx.ui.custom !== "function") { ctx.ui.notify(headlessText(ctx.cwd, args), "info"); return; }
		let snapshot = collect(ctx.cwd);
		const tab = resolveTabArgument(args, snapshot);
		if (!tab) { ctx.ui.notify(`Unknown /af-config tab "${safeTerminalText(args)}". Tabs: ${Object.values(TAB_LABELS).join(", ")}.`, "warning"); return; }
		const state = initialViewState(tab);
		const resources = createPanelResources();
		try {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: unknown) => void) => ({
				render: (width: number) => renderFleetConfig(snapshot, state, width, bodyRows(tui.terminal?.rows, FLEET_CONFIG_CHROME_ROWS), theme, metrics),
				handleInput: async (data: string) => {
					const intent = fleetConfigTransition(toTransitionInput(data), state, snapshot, bodyRows(tui.terminal?.rows, FLEET_CONFIG_CHROME_ROWS));
					if (intent === "close") { done(); return; }
					if (intent === "refresh") snapshot = collect(ctx.cwd);
					else if (intent && typeof intent === "object" && "open" in intent) { await openViewer(ctx, snapshot.workspaceRoot, intent.open); snapshot = collect(ctx.cwd); }
					tui.requestRender();
				},
				invalidate() {}, dispose: () => resources.dispose(),
			}), FULLSCREEN_OVERLAY);
		} finally { resources.dispose(); }
	}

	return { open, headlessText, recordBaseline, collect };
}

export type FleetConfigUi = ReturnType<typeof createFleetConfigUi>;
