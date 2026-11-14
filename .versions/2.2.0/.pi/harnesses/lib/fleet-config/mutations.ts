/**
 * fleet-config/mutations — the pure half of phase 3: a local draft of the
 * desired state, the exact CLI arguments it maps to, and projections of the
 * CLI's own preview/result JSON for the confirmation overlay.
 *
 * Nothing here writes or spawns. Every write goes through the CLI
 * (`setup --yes`, `configure --yes`) after the human confirms the exact plan
 * the CLI printed for a dry run; a second dry run must produce the same plan
 * digest or the apply is refused as "workspace changed since preview".
 */
import { createHash } from "node:crypto";
import type { FleetConfigSnapshot } from "./snapshot.ts";

export interface SetupDraft { preset: string; features: string[] }

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

/** Start from the file as written; the installer's catalogue (inspect) supplies the preset list. */
export function draftFromSnapshot(snapshot: FleetConfigSnapshot): SetupDraft {
	const setup = snapshot.setup;
	return { preset: setup?.preset ?? "default", features: sortedUnique((setup?.features ?? []).filter(feature => feature.enabled).map(feature => feature.name)) };
}

export function draftFeatureNames(snapshot: FleetConfigSnapshot, draft: SetupDraft): string[] {
	const catalogue = snapshot.inspect?.status === "ok" ? (snapshot.inspect.report.desired?.catalogue ?? []).map(feature => feature.name) : [];
	return sortedUnique([...(snapshot.setup?.features ?? []).map(feature => feature.name), ...catalogue, ...draft.features]);
}

export function toggleFeature(draft: SetupDraft, name: string): SetupDraft {
	const enabled = new Set(draft.features);
	enabled.has(name) ? enabled.delete(name) : enabled.add(name);
	return { preset: draft.preset, features: sortedUnique([...enabled]) };
}

export function cyclePreset(draft: SetupDraft, presets: readonly string[]): SetupDraft {
	const list = presets.length ? presets : ["default", "full"];
	const index = list.indexOf(draft.preset);
	return { ...draft, preset: list[(index + 1) % list.length] };
}

export function sameDraft(a: SetupDraft, b: SetupDraft): boolean {
	return a.preset === b.preset && a.features.length === b.features.length && a.features.every((name, index) => name === b.features[index]);
}

export interface SetupArgvOptions { dryRun: boolean; taskTriageConsent?: boolean; repairConfig?: boolean }

/** Exactly what the CLI receives; `--save-desired` persists the human file, `--allow-exec` is never passed. */
export function setupArgv(draft: SetupDraft, { dryRun, taskTriageConsent = false, repairConfig = false }: SetupArgvOptions): string[] {
	return [
		"setup", "--json", "--preset", draft.preset, "--features", draft.features.length ? draft.features.join(",") : "none", "--save-desired",
		...(dryRun ? ["--dry-run"] : ["--yes"]),
		...(taskTriageConsent && !dryRun ? ["--task-triage-consent"] : []),
		...(repairConfig && !dryRun ? ["--repair-config"] : []),
	];
}

export function configureArgv(request: { rules?: string[]; docs?: string[] }, options: { dryRun: boolean; expectedHash?: string }): string[] {
	return [
		"configure",
		...(request.rules?.length ? ["--rules", request.rules.join(",")] : []),
		...(request.docs?.length ? ["--docs", request.docs.join(",")] : []),
		...(options.dryRun ? ["--dry-run"] : ["--yes", "--json", ...(options.expectedHash ? ["--expect-hash", options.expectedHash] : [])]),
	];
}

export interface PlanAction { kind: string; id: string; reason: string | null; files: Array<{ path: string; state: string }>; operatorSteps: string[] }
export type PlanPreview =
	| {
		stage: "plan"; digest: string; verb: string;
		summary: Record<string, number>; byKind: Array<{ kind: string; count: number }>; actions: PlanAction[];
		conflicts: Array<{ id: string; reason: string | null }>; notes: string[];
		desired: { preset: string | null; features: string[] } | null; requestedFeatures: string[]; dependencyFeatures: string[]; resolvedItems: number | null;
		firstMigration: boolean; migrationBlocked: boolean; migrationError: string | null;
		stt: { write: boolean; warning: string | null; provider: string | null } | null;
		taskTriage: { alreadyApproved: boolean } | null;
		overridesWrite: boolean; noop: boolean;
	}
	| { stage: "config-repair"; path: string; removed: string[]; nextStep: string }
	| { stage: "unknown"; detail: string };

const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

/** Stable identity of what the human confirms: the CLI's actions, desired state and side writes, not timestamps. */
export function planDigest(json: unknown): string {
	if (!isRecord(json)) return createHash("sha256").update("not-a-plan").digest("hex");
	const actions = (Array.isArray(json.actions) ? json.actions : []).filter(isRecord)
		.map(action => [text(action.kind) ?? "", text(action.id) ?? "", text(action.target) ?? "", text(action.reason) ?? "", (Array.isArray(action.files) ? action.files : []).filter(isRecord).map(file => `${text(file.state) ?? ""}:${text(file.path) ?? ""}`).sort()])
		.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	const projection = {
		stage: json.stage ?? null, verb: json.verb ?? null, actions,
		conflicts: (Array.isArray(json.conflicts) ? json.conflicts : []).filter(isRecord).map(conflict => text(conflict.id) ?? "").sort(),
		desired: isRecord(json.desired) ? json.desired : null, writeDesired: Boolean(json.writeDesired),
		overridesWrite: Boolean(isRecord(json.overrides) && json.overrides.write), sttWrite: Boolean(isRecord(json.stt) && json.stt.write),
		configRepair: isRecord(json.configRepair) ? json.configRepair.removed ?? null : null,
	};
	return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function summarizePlan(json: unknown): PlanPreview {
	if (!isRecord(json)) return { stage: "unknown", detail: "the CLI did not return a plan object" };
	if (isRecord(json.configRepair)) {
		const repair = json.configRepair;
		return { stage: "config-repair", path: text(repair.path) ?? ".ai/agent-fleet.json", removed: (Array.isArray(repair.removed) ? repair.removed : []).map(String), nextStep: text(repair.nextStep) ?? "" };
	}
	if (!Array.isArray(json.actions)) return { stage: "unknown", detail: `unexpected ${text(json.stage) ?? text(json.verb) ?? "response"} without actions` };
	const actions: PlanAction[] = json.actions.filter(isRecord).filter(action => action.kind !== "keep").map(action => ({
		kind: text(action.kind) ?? "unknown", id: text(action.id) ?? "?", reason: text(action.reason),
		files: (Array.isArray(action.files) ? action.files : []).filter(isRecord).map(file => ({ path: text(file.path) ?? "", state: text(file.state) ?? "" })),
		operatorSteps: (Array.isArray(action.operatorSteps) ? action.operatorSteps : []).map(String),
	}));
	const counts = new Map<string, number>();
	for (const action of json.actions.filter(isRecord)) { const kind = text(action.kind) ?? "unknown"; counts.set(kind, (counts.get(kind) ?? 0) + 1); }
	const summary = isRecord(json.summary) ? Object.fromEntries(Object.entries(json.summary).filter(([, value]) => typeof value === "number")) as Record<string, number> : {};
	const selection = isRecord(json.selection) && isRecord(json.selection.desired) ? json.selection.desired : null;
	const requested: string[] = Array.isArray(selection?.requestedFeatures) ? selection!.requestedFeatures.map(String) : [];
	const effective: string[] = Array.isArray(selection?.features) ? selection!.features.map(String) : [];
	const desired = isRecord(json.desired) ? { preset: text(json.desired.preset), features: isRecord(json.desired.features) ? Object.entries(json.desired.features).filter(([, on]) => on === true).map(([name]) => name).sort() : [] } : null;
	const changes = summary.changes ?? actions.filter(action => ["create", "refresh", "repair", "remove"].includes(action.kind)).length;
	return {
		stage: "plan", digest: planDigest(json), verb: text(json.verb) ?? "setup",
		summary, byKind: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind)), actions,
		conflicts: (Array.isArray(json.conflicts) ? json.conflicts : []).filter(isRecord).map(conflict => ({ id: text(conflict.id) ?? "?", reason: text(conflict.reason) })),
		notes: (Array.isArray(json.notes) ? json.notes : []).filter(isRecord).map(note => text(note.detail) ?? JSON.stringify(note)),
		desired, requestedFeatures: requested, dependencyFeatures: effective.filter(name => !requested.includes(name)),
		resolvedItems: Array.isArray(isRecord(json.selection) ? json.selection.resolved : null) ? json.selection.resolved.length : null,
		firstMigration: Boolean(json.firstMigration), migrationBlocked: Boolean(json.migrationBlocked), migrationError: text(json.migrationError),
		stt: isRecord(json.stt) ? { write: Boolean(json.stt.write), warning: text(json.stt.warning), provider: text(json.stt.provider) } : null,
		taskTriage: isRecord(json.taskTriage) ? { alreadyApproved: Boolean(json.taskTriage.alreadyApproved) } : null,
		overridesWrite: Boolean(isRecord(json.overrides) && json.overrides.write),
		noop: changes === 0 && !Boolean(json.writeDesired) && !(isRecord(json.overrides) && json.overrides.write) && !(isRecord(json.stt) && json.stt.write),
	};
}

/** The confirmation overlay's lines; the CLI's words, grouped, never re-judged. */
export function planPreviewLines(preview: PlanPreview, draft: SetupDraft | null): string[] {
	if (preview.stage === "unknown") return [`Cannot preview: ${preview.detail}`];
	if (preview.stage === "config-repair") return [
		`The installer rejects ${preview.path} and offers to repair it first.`,
		`Keys it would remove: ${preview.removed.join(", ") || "(none listed)"}`,
		`CLI next step: ${preview.nextStep}`,
		"",
		"Confirming runs setup with --repair-config --yes: the retired keys are removed from the human file, then the plan is applied.",
	];
	const lines: string[] = [];
	if (draft) lines.push(`Desired state → preset ${draft.preset} · features ${draft.features.join(", ") || "none"} (saved to .ai/agent-fleet.json)`);
	if (preview.desired) lines.push(`CLI evaluation → preset ${preview.desired.preset ?? "—"} · requested ${preview.requestedFeatures.join(", ") || "none"} · via dependencies ${preview.dependencyFeatures.join(", ") || "none"}${preview.resolvedItems !== null ? ` · ${preview.resolvedItems} items after closure` : ""}`);
	lines.push(`Summary → ${preview.byKind.map(entry => `${entry.kind} ${entry.count}`).join(" · ") || "no actions"}${preview.summary.changes !== undefined ? ` · changes ${preview.summary.changes}` : ""}`);
	if (preview.migrationBlocked) lines.push(`BLOCKED: ${preview.migrationError}`);
	if (preview.conflicts.length) { lines.push(`CONFLICTS (${preview.conflicts.length}) — a human decision is required; nothing can be applied from here:`); for (const conflict of preview.conflicts) lines.push(`  ${conflict.id}${conflict.reason ? ` — ${conflict.reason}` : ""}`); }
	if (preview.stt?.warning) lines.push(`STT warning: ${preview.stt.warning}`);
	if (preview.stt?.write) lines.push(`STT: .ai/stt.json would be written (provider ${preview.stt.provider ?? "—"}; environment variable names only).`);
	if (preview.overridesWrite) lines.push("Overrides: .ai/agent-fleet-overrides.md is empty and would receive the generated agent-hub section.");
	if (preview.taskTriage && !preview.taskTriage.alreadyApproved) lines.push("Task triage: separate data consent is required before apply (asked on confirm).");
	for (const note of preview.notes) lines.push(`Note: ${note}`);
	if (preview.actions.length) {
		lines.push("", "Planned actions (keep omitted):");
		for (const action of preview.actions) {
			lines.push(`  ${action.kind.padEnd(8)} ${action.id}${action.reason ? ` — ${action.reason}` : ""}`);
			for (const file of action.files) lines.push(`             ${file.state}: ${file.path}`);
			for (const step of action.operatorSteps) lines.push(`             operator: ${step}`);
		}
	} else lines.push("", preview.noop ? "No changes: the workspace already matches this desired state." : "No item actions.");
	return lines;
}

export interface ApplyOutcome { ok: boolean; exitCode: number; summary: Record<string, number>; failure: string | null; results: Array<{ id: string; status: string; detail: string | null }> }

export function summarizeResult(json: unknown, exitCode: number): ApplyOutcome {
	if (!isRecord(json)) return { ok: false, exitCode, summary: {}, failure: "the CLI did not return a result object", results: [] };
	const summary = isRecord(json.summary) ? Object.fromEntries(Object.entries(json.summary).filter(([, value]) => typeof value === "number")) as Record<string, number> : {};
	const failure = isRecord(json.failure) ? text(json.failure.detail) ?? text(json.failure.message) ?? "failed" : text(json.failure);
	return {
		ok: exitCode === 0 && !failure, exitCode, summary, failure,
		results: (Array.isArray(json.results) ? json.results : []).filter(isRecord).map(result => ({ id: text(result.id) ?? "?", status: text(result.status) ?? "?", detail: text(result.detail) })),
	};
}

export interface ConfigurePreview { expectedHash: string; write: boolean; path: string; before: string[]; after: string[] }

export function summarizeConfigurePreview(json: unknown): ConfigurePreview | null {
	if (!isRecord(json) || json.verb !== "configure" || typeof json.expectedHash !== "string") return null;
	return { expectedHash: json.expectedHash, write: Boolean(json.write), path: text(json.path) ?? ".ai/agent-fleet-overrides.md", before: String(json.before ?? "").split("\n"), after: String(json.after ?? "").split("\n") };
}

/** Minimal line diff for the overrides preview: removed lines first with "-", added with "+", unchanged with " ". */
export function configureDiffLines(preview: ConfigurePreview): string[] {
	const before = new Set(preview.before), after = new Set(preview.after);
	const lines: string[] = [];
	for (const line of preview.before) if (!after.has(line)) lines.push(`- ${line}`);
	for (const line of preview.after) lines.push(`${before.has(line) ? " " : "+"} ${line}`);
	return lines;
}

/** Validation the CLI also performs; here only so the dialog can refuse obviously wrong input before spawning. */
export function parsePathList(value: string): string[] | null {
	const paths = value.split(",").map(path => path.trim()).filter(Boolean);
	if (!paths.length) return [];
	for (const path of paths) if (path.startsWith("/") || /[\r\n:#]/.test(path) || path.includes("\\") || path.split("/").some(part => part === "." || part === ".." || !part)) return null;
	return [...new Set(paths)];
}
