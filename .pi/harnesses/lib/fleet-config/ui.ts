/**
 * fleet-config/ui — the pi overlay host shared by the Hub (`/af-config`,
 * Alt+,) and coms peers. Collection, rows and key handling live in the pure
 * modules; this file maps pi keys, owns the overlay lifecycle, the read-only
 * file viewer, and (phase 3) the confirm-then-CLI write flows.
 *
 * This module never writes a configuration file itself. A change is a CLI
 * dry run, the CLI's own plan shown to the human, an explicit confirmation,
 * a second dry run that must match the first, and only then the CLI with
 * `--yes`. The CLI keeps its lock, transaction journal and hash guards.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FULLSCREEN_OVERLAY, bodyRows, clampScroll, fitToHeight } from "../fleet-overlay.ts";
import { createPanelResources } from "../fleet-panel.ts";
import { safeTerminalText } from "../fleet-strip-view.ts";
import { readCachedLatestVersion } from "../update-check.ts";
import { resolveFleetCli, runFleetCli, runInspectCli, type CliResolution, type CliRunner, type FleetCliOutcome, type InspectReport } from "./cli-bridge.ts";
import { configureArgv, configureDiffLines, draftFromSnapshot, parsePathList, planDigest, planPreviewLines, sameDraft, setupArgv, summarizeConfigurePreview, summarizePlan, summarizeResult, type SetupDraft } from "./mutations.ts";
import { collectFleetConfigSnapshot, sourceDigests, type FleetConfigSnapshot, type InspectState, type SnapshotInput, type SourceId } from "./snapshot.ts";
import { fleetConfigTransition, KEYS } from "./transition.ts";
import { fleetConfigHeadlessText, FLEET_CONFIG_CHROME_ROWS, initialViewState, renderFleetConfig, resolveTabArgument, TAB_LABELS, type FleetConfigViewState } from "./view.ts";

export type FleetConfigDeps = Pick<SnapshotInput, "readHubOverrides" | "livePeerNames" | "runtimeRows"> & {
	latestKnownVersion?: () => string | null | undefined;
	/** Tests inject a fake CLI; production spawns the resolved CLI (D6) without a shell. */
	inspectRunner?: CliRunner;
	inspectTimeoutMs?: number;
};
export interface FleetConfigUiContext { cwd: string; hasUI: boolean; ui: Pick<ExtensionContext["ui"], "custom" | "notify"> & Partial<Pick<ExtensionContext["ui"], "input">> }
const metrics = { truncateToWidth, visibleWidth };
/** Strip terminal controls but keep indentation; report lines are pre-formatted. */
const safeLine = (value: string): string => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const VIEWER_MAX_BYTES = 256 * 1024;
export const TASK_TRIAGE_CONSENT_TEXT = "Active experimental task triage sends bounded task/clarification text and relevant repository metadata to the configured TypeSafe Jev provider (up to 40 KiB task, 64 KiB state, 100 assessments/session, 2 s each). File bodies, environment and credentials are excluded by design; sensitive input is refused, but secret detection is not guaranteed. This is a separate data consent: --yes alone is not consent.";

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
		return bytes.toString("utf8").split("\n").map((line, index) => `${String(index + 1).padStart(4)} │ ${safeLine(line.replace(/\t/g, "    "))}`);
	} catch (error) { return [`(cannot read ${relativePath}: ${(error as NodeJS.ErrnoException).code ?? "error"})`]; }
}

export function renderFileViewer(title: string, lines: readonly string[], scroll: number, width: number, bodyHeight: number, theme: { bold(text: string): string; fg(color: string, text: string): string }): string[] {
	return renderReport(`FLEET CONFIG · ${title} · read-only`, lines, scroll, width, bodyHeight, theme, "↑↓ PgUp PgDn scroll · q/Esc back");
}

/** Generic scrollable report overlay: title, lines, footer. Used by the viewer, plan preview and results. */
export function renderReport(title: string, lines: readonly string[], scroll: number, width: number, bodyHeight: number, theme: { bold(text: string): string; fg(color: string, text: string): string }, footer: string): string[] {
	const w = Math.max(1, width);
	const offset = clampScroll(scroll, lines.length, Math.max(1, bodyHeight));
	const body = lines.slice(offset, offset + Math.max(0, bodyHeight)).map(line => truncateToWidth(safeLine(line), w));
	return fitToHeight([truncateToWidth(theme.bold(safeTerminalText(title)), w), ...fitToHeight(body, Math.max(0, bodyHeight)), truncateToWidth(theme.fg("dim", `${footer} · ${Math.min(lines.length, offset + body.length)}/${lines.length} lines`), w)], bodyHeight + 2);
}

const outcomeLines = (outcome: Exclude<FleetCliOutcome, { ok: true }>): string[] => [
	`${outcome.reason}: ${outcome.detail}`,
	...(outcome.exitCode !== undefined && outcome.exitCode !== null ? [`exit code ${outcome.exitCode}`] : []),
	...(outcome.stderr ? ["", "CLI stderr:", ...outcome.stderr.split("\n").filter(Boolean).slice(0, 20).map(line => `  ${line}`)] : []),
];

export function createFleetConfigUi(deps: FleetConfigDeps = {}) {
	let startDigests: Partial<Record<SourceId, string>> | undefined;
	let inspectState: InspectState | undefined;
	const latestKnown = (): string | null => { try { return (deps.latestKnownVersion ?? readCachedLatestVersion)() ?? null; } catch { return null; } };
	const collect = (cwd: string): FleetConfigSnapshot => {
		const snapshot = collectFleetConfigSnapshot({ cwd, startDigests, readHubOverrides: deps.readHubOverrides, livePeerNames: deps.livePeerNames, runtimeRows: deps.runtimeRows, latestKnownVersion: latestKnown() });
		snapshot.inspect = inspectState ?? { status: "idle", resolution: resolution(snapshot) };
		return snapshot;
	};
	const resolution = (snapshot: FleetConfigSnapshot): CliResolution => resolveFleetCli({ sourceRoot: snapshot.overview.sourceRoot, recordedVersion: snapshot.overview.recordedVersion });
	const cli = (cwd: string, snapshot: FleetConfigSnapshot, argv: string[], allowMutation = false) => runFleetCli({ cwd, argv, resolution: resolution(snapshot), runner: deps.inspectRunner, timeoutMs: deps.inspectTimeoutMs, allowMutation });

	/** Run `agent-fleet inspect` through the CLI bridge; the result is attached to every later snapshot. */
	async function runInspect(cwd: string, snapshot: FleetConfigSnapshot): Promise<InspectState> {
		if (inspectState?.status === "running") return inspectState;
		const where = resolution(snapshot);
		inspectState = { status: "running", startedAt: Date.now(), resolution: where };
		const outcome = await runInspectCli({ cwd, resolution: where, runner: deps.inspectRunner, timeoutMs: deps.inspectTimeoutMs });
		inspectState = outcome.ok
			? { status: "ok", report: outcome.json as InspectReport, exitCode: outcome.exitCode, resolution: where, at: Date.now() }
			: { status: "failed", reason: outcome.reason, detail: outcome.detail, resolution: where, at: Date.now() };
		return inspectState;
	}

	/** Remember the on-disk digests at session start so the screen can mark later edits. */
	function recordBaseline(cwd: string): void {
		try { startDigests = sourceDigests(collectFleetConfigSnapshot({ cwd, readHubOverrides: undefined, livePeerNames: undefined, runtimeRows: undefined })); } catch { startDigests = undefined; }
	}

	function headlessText(cwd: string, args = ""): string {
		const snapshot = collect(cwd);
		const tab = resolveTabArgument(args, snapshot);
		return tab ? fleetConfigHeadlessText(snapshot, tab) : `Unknown /af-config tab "${safeTerminalText(args)}". Tabs: ${Object.values(TAB_LABELS).join(", ")}.`;
	}

	/** Scrollable report; with `confirm` the footer offers `y` and the promise says whether it was pressed. */
	async function showReport(ctx: FleetConfigUiContext, title: string, lines: readonly string[], confirm?: string): Promise<boolean> {
		let scroll = 0, confirmed = false;
		await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: unknown) => void) => ({
			render: (width: number) => renderReport(title, lines, scroll, width, bodyRows(tui.terminal?.rows, 2), theme, confirm ? `y ${confirm} · q/Esc cancel · ↑↓ PgUp PgDn scroll` : "↑↓ PgUp PgDn scroll · q/Esc back"),
			handleInput: (data: string) => {
				const input = toTransitionInput(data);
				const page = Math.max(1, bodyRows(tui.terminal?.rows, 2));
				if (input === "q" || input === KEYS.escape || input === "n") { done(); return; }
				if (input === "y" && confirm) { confirmed = true; done(); return; }
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
		return confirmed;
	}

	const openViewer = (ctx: FleetConfigUiContext, root: string, relativePath: string) => showReport(ctx, `FLEET CONFIG · ${relativePath} · read-only`, fileViewerLines(root, relativePath));

	/**
	 * Setup tab `a`: dry run → the CLI's plan → confirm → second dry run must match → `setup --yes`.
	 * Returns true when the CLI applied something (the caller reloads and drops the draft).
	 */
	async function applySetup(ctx: FleetConfigUiContext, snapshot: FleetConfigSnapshot, state: FleetConfigViewState): Promise<boolean> {
		const file = draftFromSnapshot(snapshot);
		const draft: SetupDraft = state.draft ?? file;
		const title = "FLEET CONFIG · setup plan (CLI dry run)";
		const preview = await cli(ctx.cwd, snapshot, setupArgv(draft, { dryRun: true }));
		if (!preview.ok) { await showReport(ctx, "FLEET CONFIG · setup preview failed", ["agent-fleet setup --dry-run did not produce a plan.", "", ...outcomeLines(preview), "", "Nothing was written."]); return false; }
		const plan = summarizePlan(preview.json);
		const lines = planPreviewLines(plan, draft);
		const manual = `Terminal equivalent: agent-fleet setup --preset ${draft.preset} --features ${draft.features.join(",") || "none"} --save-desired`;
		if (plan.stage === "unknown") { await showReport(ctx, title, [...lines, "", "Nothing was written."]); return false; }
		let repairConfig = false;
		if (plan.stage === "config-repair") {
			if (!await showReport(ctx, "FLEET CONFIG · desired file needs repair", [...lines, "", manual], "repair and continue")) return false;
			repairConfig = true;
		} else {
			if (plan.migrationBlocked || plan.conflicts.length) { await showReport(ctx, title, [...lines, "", "Resolve this in a terminal with the interactive CLI; the screen never guesses:", manual, "", "Nothing was written."]); return false; }
			const dirty = !sameDraft(draft, file);
			if (plan.noop && !dirty) { await showReport(ctx, title, [...lines, "", "Nothing to apply."]); return false; }
			if (plan.noop && dirty) lines.push("", "No item actions, but .ai/agent-fleet.json will be rewritten to the draft above.");
			if (!await showReport(ctx, title, [...lines, "", manual], "apply via agent-fleet setup --yes")) return false;
		}
		let taskTriageConsent = false;
		if (draft.features.includes("system1-task-triage") && (plan.stage === "config-repair" || (plan.taskTriage && !plan.taskTriage.alreadyApproved))) {
			taskTriageConsent = await showReport(ctx, "FLEET CONFIG · separate consent: task triage remote context", [TASK_TRIAGE_CONSENT_TEXT, "", "Confirm to pass --task-triage-consent; cancel keeps everything unwritten."], "approve remote task context");
			if (!taskTriageConsent) { ctx.ui.notify("Setup cancelled: task-triage consent was not given; nothing was written.", "warning"); return false; }
		}
		// The workspace may have moved while the human read the plan; the CLI re-plans on apply, so insist the preview still holds.
		const again = await cli(ctx.cwd, snapshot, setupArgv(draft, { dryRun: true }));
		if (!again.ok || planDigest(again.json) !== planDigest(preview.json)) {
			await showReport(ctx, "FLEET CONFIG · not applied", ["The workspace changed since the preview: a second dry run produced a different plan.", "Open the plan again (a) to review the current one.", ...(again.ok ? [] : ["", ...outcomeLines(again)]), "", "Nothing was written."]);
			return false;
		}
		state.busy = "applying via CLI…";
		const applied = await cli(ctx.cwd, snapshot, setupArgv(draft, { dryRun: false, taskTriageConsent, repairConfig }), true);
		state.busy = undefined;
		if (!applied.ok) { await showReport(ctx, "FLEET CONFIG · setup failed", ["agent-fleet setup --yes did not complete.", "", ...outcomeLines(applied), "", "The CLI's lock, journal and doctor --fix remain the recovery path."]); return true; }
		const result = summarizeResult(applied.json, applied.exitCode);
		const summary = Object.entries(result.summary).map(([key, value]) => `${key} ${value}`).join(" · ");
		const notable = result.results.filter(entry => !["applied", "unchanged", "adopted"].includes(entry.status));
		await showReport(ctx, result.ok ? "FLEET CONFIG · setup applied" : "FLEET CONFIG · setup incomplete", [
			result.ok ? "agent-fleet setup --yes completed." : `agent-fleet setup exited ${result.exitCode}${result.failure ? `: ${result.failure}` : ""}.`,
			summary ? `Summary → ${summary}` : "",
			...(notable.length ? ["", "Not applied as files:", ...notable.map(entry => `  ${entry.status.padEnd(8)} ${entry.id}${entry.detail ? ` — ${entry.detail}` : ""}`)] : []),
			"", "Restart the session to load the new configuration; this session keeps what it read at start.",
		].filter((line, index, all) => line !== "" || all[index - 1] !== ""));
		return true;
	}

	/** Overrides tab `a`: ask for rules/docs roots, `configure --dry-run` preview, confirm, `configure --yes --expect-hash`. */
	async function configureOverrides(ctx: FleetConfigUiContext, snapshot: FleetConfigSnapshot, state: FleetConfigViewState): Promise<boolean> {
		if (typeof ctx.ui.input !== "function") { ctx.ui.notify("This session has no input dialog; run agent-fleet configure --rules/--docs in a terminal.", "warning"); return false; }
		const hub = snapshot.overrides?.hub;
		const ask = async (key: "rules" | "docs", current: readonly string[]): Promise<string[] | null | undefined> => {
			const answer = await ctx.ui.input!(`configure --${key}: comma-separated checkout-relative roots to append (empty = skip)`, current.join(", "));
			if (answer === undefined) return undefined;
			const parsed = parsePathList(answer);
			if (parsed === null) ctx.ui.notify(`--${key}: paths must be checkout-relative without traversal, ':' or '#'.`, "warning");
			return parsed;
		};
		const rules = await ask("rules", hub?.rulesDirs ?? []);
		if (rules === undefined || rules === null) return false;
		const docs = await ask("docs", hub?.docsPaths ?? []);
		if (docs === undefined || docs === null) return false;
		if (!rules.length && !docs.length) { ctx.ui.notify("Nothing requested; configure needs --rules and/or --docs.", "info"); return false; }
		const request = { rules, docs };
		const preview = await cli(ctx.cwd, snapshot, configureArgv(request, { dryRun: true }));
		if (!preview.ok) { await showReport(ctx, "FLEET CONFIG · configure preview failed", [...outcomeLines(preview), "", "Nothing was written."]); return false; }
		const summary = summarizeConfigurePreview(preview.json);
		if (!summary) { await showReport(ctx, "FLEET CONFIG · configure preview", ["The CLI did not return a configure preview.", "", "Nothing was written."]); return false; }
		const lines = [`${summary.path} · expected hash ${summary.expectedHash.slice(0, 12)}…`, summary.write ? "Changes the CLI would write (- removed, + added):" : "No change: the requested roots are already present.", "", ...configureDiffLines(summary)];
		if (!summary.write) { await showReport(ctx, "FLEET CONFIG · configure preview", lines); return false; }
		if (!await showReport(ctx, "FLEET CONFIG · configure preview (CLI dry run)", lines, "apply via agent-fleet configure --yes")) return false;
		state.busy = "applying via CLI…";
		const applied = await cli(ctx.cwd, snapshot, configureArgv(request, { dryRun: false, expectedHash: summary.expectedHash }), true);
		state.busy = undefined;
		if (!applied.ok) { await showReport(ctx, "FLEET CONFIG · configure failed", [...outcomeLines(applied), "", "The CLI refuses when the file changed since the preview; open the preview again (a)."]); return true; }
		const changed = !!applied.json && typeof applied.json === "object" && (applied.json as { changed?: unknown }).changed === true;
		await showReport(ctx, "FLEET CONFIG · configure applied", [changed ? "Configuration applied by agent-fleet configure --yes." : "Configuration unchanged.", "", "Restart the session to load it; the Hub reads overrides once at start."]);
		return true;
	}

	/** `/af-config [tab]` and Alt+, — headless sessions get the same model as notify text and no write flows. */
	async function open(ctx: FleetConfigUiContext, args = ""): Promise<void> {
		if (!ctx.hasUI || typeof ctx.ui.custom !== "function") { ctx.ui.notify(headlessText(ctx.cwd, args), "info"); return; }
		let snapshot = collect(ctx.cwd);
		const tab = resolveTabArgument(args, snapshot);
		if (!tab) { ctx.ui.notify(`Unknown /af-config tab "${safeTerminalText(args)}". Tabs: ${Object.values(TAB_LABELS).join(", ")}.`, "warning"); return; }
		const state = initialViewState(tab);
		const resources = createPanelResources();
		let flowRunning = false;
		try {
			await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (result?: unknown) => void) => ({
				render: (width: number) => renderFleetConfig(snapshot, state, width, bodyRows(tui.terminal?.rows, FLEET_CONFIG_CHROME_ROWS), theme, metrics),
				handleInput: async (data: string) => {
					if (flowRunning) return;
					const intent = fleetConfigTransition(toTransitionInput(data), state, snapshot, bodyRows(tui.terminal?.rows, FLEET_CONFIG_CHROME_ROWS));
					if (intent === "close") { done(); return; }
					if (intent === "refresh") snapshot = collect(ctx.cwd);
					else if (intent === "inspect") {
						// Fire and forget: the overlay stays responsive while the CLI runs; the row shows "running".
						void runInspect(ctx.cwd, snapshot).then(() => { if (!resources.closed) { snapshot = collect(ctx.cwd); tui.requestRender(); } });
						snapshot = collect(ctx.cwd);
					}
					else if (intent === "apply" || intent === "configure") {
						flowRunning = true;
						try {
							const changed = intent === "apply" ? await applySetup(ctx, snapshot, state) : await configureOverrides(ctx, snapshot, state);
							if (changed) { inspectState = undefined; state.draft = undefined; }
						} catch (error) { ctx.ui.notify(`Fleet config: ${(error as Error).message}`, "error"); }
						finally { flowRunning = false; state.busy = undefined; }
						snapshot = collect(ctx.cwd);
					}
					else if (intent && typeof intent === "object" && "open" in intent) { await openViewer(ctx, snapshot.workspaceRoot, intent.open); snapshot = collect(ctx.cwd); }
					tui.requestRender();
				},
				invalidate() {}, dispose: () => resources.dispose(),
			}), FULLSCREEN_OVERLAY);
		} finally { resources.dispose(); }
	}

	return { open, headlessText, recordBaseline, collect, runInspect };
}

export type FleetConfigUi = ReturnType<typeof createFleetConfigUi>;
