/**
 * fleet-config/view — pure rows + rendering for the /af-config overlay.
 * No I/O. Every string that originates in a file passes safeTerminalText.
 */
import { clampScroll, fitToHeight } from "../fleet-overlay.ts";
import { reconcileSelection, type Selection } from "../fleet-selection.ts";
import { safeTerminalText, type TextMetrics } from "../fleet-strip-view.ts";
import type { ThemeLike } from "../fleet-dashboard-view.ts";
import { isNewerVersion, PACKAGE_NAME } from "../update-check.ts";
import type { InspectReport } from "./cli-bridge.ts";
import { draftFeatureNames, draftFromSnapshot, sameDraft, type SetupDraft } from "./mutations.ts";
import { problemCount, SOURCE_IDS, SOURCE_PATHS, type FleetConfigSnapshot, type SourceId } from "./snapshot.ts";

export const FLEET_CONFIG_CHROME_ROWS = 3;
export const TAB_IDS = ["overview", "setup", "state", "overrides", "aiState", "system1", "stt", "fleet", "safety", "runtime"] as const;
export type TabId = typeof TAB_IDS[number];
export const TAB_LABELS: Record<TabId, string> = { overview: "Overview", setup: "Setup", state: "State", overrides: "Overrides", aiState: "AI State", system1: "System 1", stt: "STT", fleet: "Fleet", safety: "Safety", runtime: "Runtime" };

export type RowLevel = "ok" | "info" | "warn" | "error";
export interface ConfigRow { key: string; label: string; detail: string; origin: string; level?: RowLevel; expandable?: boolean; depth?: number; path?: string; feature?: string }
/** `draft` is the unsaved desired state edited on the Setup tab; undefined means "as the file says". */
export interface FleetConfigViewState { tab: TabId; selection: Selection; expanded: Set<string>; scrollOffset: number; draft?: SetupDraft; busy?: string }

export function initialViewState(tab: TabId = "overview"): FleetConfigViewState { return { tab, selection: { index: 0 }, expanded: new Set(), scrollOffset: 0 }; }

/** Tabs available for this snapshot: Runtime only when the host supplied rows. */
export function fleetConfigTabs(snapshot: FleetConfigSnapshot): TabId[] { return TAB_IDS.filter(tab => tab !== "runtime" || snapshot.runtime !== null); }

/** Resolve `/af-config <tab>` arguments by id, label or unambiguous prefix. */
export function resolveTabArgument(argument: string | undefined, snapshot: FleetConfigSnapshot): TabId | null {
	const wanted = (argument ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
	if (!wanted) return "overview";
	const tabs = fleetConfigTabs(snapshot);
	const normalized = (tab: TabId) => [tab.toLowerCase(), TAB_LABELS[tab].toLowerCase().replace(/[\s_-]+/g, "")];
	const exact = tabs.find(tab => normalized(tab).includes(wanted));
	if (exact) return exact;
	const prefixed = tabs.filter(tab => normalized(tab).some(name => name.startsWith(wanted)));
	return prefixed.length === 1 ? prefixed[0] : null;
}

const s = safeTerminalText;
const onOff = (value: boolean) => value ? "on" : "off";
const presence = (value: boolean | null) => value === null ? "—" : value ? "present" : "absent";
const sourceLevel = (status: string): RowLevel => status === "present" ? "ok" : status === "missing" ? "info" : "error";
const sourceDetail = (snapshot: FleetConfigSnapshot, id: SourceId) => {
	const file = snapshot.sources[id];
	const parts = [file.status, ...(file.bytes !== undefined ? [`${file.bytes} B`] : []), ...file.problems];
	if (snapshot.changedSinceStart.includes(id)) parts.push("changed since session start");
	return parts.join(" · ");
};
const row = (key: string, label: string, detail: string, origin = "", extra: Partial<ConfigRow> = {}): ConfigRow => ({ key, label: s(label), detail: s(detail), origin: s(origin), ...extra });
const INSPECT = "agent-fleet inspect";
const inspectReport = (snapshot: FleetConfigSnapshot): InspectReport | null => snapshot.inspect?.status === "ok" ? snapshot.inspect.report : null;
const cliWhere = (snapshot: FleetConfigSnapshot): string => {
	const resolution = snapshot.inspect?.resolution;
	if (!resolution || resolution.kind === "unavailable") return "unavailable";
	return resolution.kind === "source" ? `${resolution.root}/bin/cli.js` : `npx ${PACKAGE_NAME}@${resolution.version}`;
};

/** Installer evaluation rows: the CLI's own words, never re-derived. */
function inspectRows(snapshot: FleetConfigSnapshot, expanded: Set<string>): ConfigRow[] {
	const state = snapshot.inspect;
	if (!state) return [];
	const where = cliWhere(snapshot);
	if (state.status === "idle") return [row("inspect/idle", "Installer evaluation", state.resolution.kind === "unavailable" ? `unavailable — ${state.resolution.reason}` : `press i to run ${INSPECT} via ${where}`, INSPECT, { level: state.resolution.kind === "unavailable" ? "warn" : "info" })];
	if (state.status === "running") return [row("inspect/running", "Installer evaluation", `running ${INSPECT} via ${where}…`, INSPECT, { level: "info" })];
	if (state.status === "failed") return [row("inspect/failed", "Installer evaluation", `${state.reason}: ${state.detail} (${where})`, INSPECT, { level: "error" })];
	const report = state.report;
	const verify = report.verify;
	const doctor = report.doctor;
	const rows = [row("inspect/ok", "Installer evaluation", `${INSPECT} v${report.packageVersion} via ${where} · ${new Date(state.at).toISOString()}`, INSPECT, { level: "ok" })];
	if (verify?.error) rows.push(row("inspect/verify-error", "  verify", verify.error, INSPECT, { level: "error" }));
	else if (verify?.summary) {
		const sum = verify.summary;
		rows.push(row("inspect/verify", "  verify", `${sum.total} items · installed ${sum.installed} · broken ${sum.broken} · outdated ${sum.upgradable} · problems ${sum.problems} · advisories ${sum.advisories}${sum.versionDrift ? ` · recorded ${verify.recordedVersion ?? "—"} ≠ running ${report.packageVersion}` : ""}${verify.baseAvailable === false ? " · no base snapshot" : ""}`, INSPECT, { level: sum.broken || sum.problems ? "warn" : "ok" }));
	}
	const verifyFindings = verify?.findings ?? [];
	rows.push(row("inspect/verify-findings", "  verify findings", String(verifyFindings.length), INSPECT, { expandable: verifyFindings.length > 0, level: verifyFindings.some(finding => finding.severity === "problem") ? "warn" : "info" }));
	if (expanded.has("inspect/verify-findings")) verifyFindings.forEach((finding, index) => rows.push(row(`inspect/verify-findings/${index}`, `    ${finding.type}`, `${finding.path} — ${finding.issue} · fix: ${finding.fix}`, INSPECT, { depth: 2, level: finding.severity === "problem" ? "warn" : "info" })));
	if (doctor?.error) rows.push(row("inspect/doctor-error", "  doctor", doctor.error, INSPECT, { level: "error" }));
	else {
		const findings = doctor?.findings ?? [];
		const preflight = doctor?.preflight;
		rows.push(row("inspect/doctor-findings", "  doctor findings", `${findings.length}${preflight ? ` · preflight ${preflight.status}${preflight.missingFiles.length ? ` · ${preflight.missingFiles.length} required file${preflight.missingFiles.length === 1 ? "" : "s"} missing` : ""}` : ""}`, INSPECT, { expandable: findings.length > 0, level: findings.length ? "warn" : "ok" }));
		if (expanded.has("inspect/doctor-findings")) findings.forEach((finding, index) => rows.push(row(`inspect/doctor-findings/${index}`, `    ${finding.type}`, `${finding.path} — ${finding.issue} · fix: ${finding.fix}`, INSPECT, { depth: 2, level: "warn" })));
		if (preflight?.remediation.length) rows.push(row("inspect/remediation", "  remediation (not run)", preflight.remediation.join("; "), INSPECT, { level: "info" }));
	}
	return rows;
}

function overviewRows(snapshot: FleetConfigSnapshot, expanded: Set<string>): ConfigRow[] {
	const o = snapshot.overview;
	const rows: ConfigRow[] = [
		row("ov/workspace", "Workspace", snapshot.workspaceRoot, "runtime"),
		row("ov/installation", "Installation", o.installationStatus + (o.installationReason ? ` (${o.installationReason})` : ""), SOURCE_PATHS.state, { level: o.installationStatus === "local" ? "ok" : o.installationStatus === "missing" ? "info" : "error" }),
		row("ov/version", "Recorded version", `${o.recordedVersion ?? "—"} · method ${o.method ?? "—"} · installed ${o.installedAt ?? "—"} · updated ${o.updatedAt ?? "—"}`, SOURCE_PATHS.state),
	];
	if (o.latestKnownVersion) rows.push(row("ov/latest", "Latest known version", `${o.latestKnownVersion}${o.recordedVersion && isNewerVersion(o.latestKnownVersion, o.recordedVersion) ? " · newer than recorded" : ""}`, "update-check cache", { level: o.recordedVersion && isNewerVersion(o.latestKnownVersion, o.recordedVersion) ? "warn" : "ok" }));
	rows.push(row("ov/sourceRoot", "Source root", `${o.sourceRoot ?? "—"} · ${presence(o.sourceRootPresent)}`, SOURCE_PATHS.state, { level: o.sourceRootPresent === false ? "warn" : "ok" }));
	rows.push(row("ov/transaction", "Transaction journal", o.transactionPending ? "present — an installer transaction did not finish; run agent-fleet setup" : "none", SOURCE_PATHS.transaction, { level: o.transactionPending ? "warn" : "ok" }));
	rows.push(row("ov/problems", "Problems", `${problemCount(snapshot)} · changed since start: ${snapshot.changedSinceStart.length}`, "", { level: problemCount(snapshot) ? "warn" : "ok" }));
	rows.push(...inspectRows(snapshot, expanded));
	for (const id of SOURCE_IDS) rows.push(row(`ov/source/${id}`, `  ${SOURCE_PATHS[id]}`, sourceDetail(snapshot, id), "", { level: snapshot.changedSinceStart.includes(id) ? "warn" : sourceLevel(snapshot.sources[id].status), path: snapshot.sources[id].status === "present" ? SOURCE_PATHS[id] : undefined }));
	return rows;
}

function setupRows(snapshot: FleetConfigSnapshot, draftState?: FleetConfigViewState): ConfigRow[] {
	const path = SOURCE_PATHS.desired;
	if (!snapshot.setup) return [row("setup/none", "Desired state", sourceDetail(snapshot, "desired"), path, { level: sourceLevel(snapshot.sources.desired.status) })];
	const report = inspectReport(snapshot);
	const desired = report?.desired;
	const catalogue = new Map((desired?.catalogue ?? []).map(feature => [feature.name, feature]));
	const file = draftFromSnapshot(snapshot);
	const draft = draftState?.draft ?? file;
	const dirty = !sameDraft(draft, file);
	const rows = [
		row("setup/preset", "Preset", `${dirty && draft.preset !== file.preset ? `${file.preset} → ${draft.preset} (draft)` : snapshot.setup.preset ?? "—"}${desired?.presets?.length ? ` · known presets: ${desired.presets.join(", ")}` : ""}`, path, { path, level: dirty && draft.preset !== file.preset ? "warn" : "info" }),
		row("setup/schema", "Schema version", String(snapshot.setup.schemaVersion ?? "—"), path),
	];
	if (desired?.status === "invalid" && desired.error) rows.push(row("setup/invalid", "Installer rejects this file", desired.error, INSPECT, { level: "error" }));
	if (dirty) rows.push(row("setup/draft", "Draft (not saved)", `preset ${draft.preset} · features ${draft.features.join(", ") || "none"} · a previews the CLI plan, u discards`, "draft", { level: "warn" }));
	const inFile = new Set(snapshot.setup.features.map(feature => feature.name));
	for (const name of draftFeatureNames(snapshot, draft)) {
		const info = catalogue.get(name);
		const fileOn = snapshot.setup.features.find(feature => feature.name === name)?.enabled ?? false;
		const draftOn = draft.features.includes(name);
		const base = inFile.has(name) ? onOff(fileOn) : "not in file (off)";
		const state = draftOn !== fileOn ? `${base} → ${onOff(draftOn)} (draft)` : base;
		const extra = info
			? ` · ${info.stability}${info.available ? "" : ` · unavailable on ${report!.platform}`}${info.requiresFeatures.length ? ` · requires ${info.requiresFeatures.join(", ")}` : ""}${info.effective && !fileOn ? " · effective through a dependency" : ""}${info.items.length ? ` · ${info.items.length} item${info.items.length === 1 ? "" : "s"}` : ""}`
			: report ? " · not in the installed catalogue" : "";
		rows.push(row(`setup/feature/${name}`, `  ${name}`, state + extra, inFile.has(name) ? path : INSPECT, { level: draftOn !== fileOn ? "warn" : info && !info.available && draftOn ? "error" : draftOn ? "ok" : "info", path: inFile.has(name) ? path : undefined, feature: name }));
	}
	if (desired?.featureError) rows.push(row("setup/feature-error", "Effective selection", desired.featureError, INSPECT, { level: "error" }));
	else if (desired?.effective) rows.push(row("setup/effective", "Effective selection", `${desired.status === "invalid" ? "from the default desired state (file rejected) · " : ""}${desired.effective.features.join(", ") || "no features"} · ${desired.effective.roots} roots → ${desired.effective.selected} items`, INSPECT, { level: desired.status === "invalid" ? "warn" : "ok" }));
	else rows.push(row("setup/note", "Availability, dependencies, retired names", "press i to evaluate with agent-fleet inspect (not re-derived here)", "", { level: "info" }));
	return rows;
}

function stateRows(snapshot: FleetConfigSnapshot, expanded: Set<string>): ConfigRow[] {
	const path = SOURCE_PATHS.state;
	if (!snapshot.state) return [row("state/none", "Install record", sourceDetail(snapshot, "state"), path, { level: sourceLevel(snapshot.sources.state.status) })];
	const f = snapshot.state.files;
	const rows = [row("state/files", "Recorded files", `${f.total} · unchanged ${f.unchanged} · modified ${f.modified} · missing ${f.missing}${f.other ? ` · other ${f.other}` : ""}`, path, { level: f.modified || f.missing ? "warn" : "ok", path })];
	const verify = inspectReport(snapshot)?.verify;
	const verifyItems = new Map((verify?.items ?? []).map(item => [item.id, item]));
	if (verify?.summary) rows.push(row("state/installer", "Installer item states", `${Object.entries(verify.summary.byState).map(([state, count]) => `${state} ${count}`).join(" · ")}${verify.summary.broken ? " · repair: agent-fleet setup" : ""}`, INSPECT, { level: verify.summary.broken ? "warn" : "ok" }));
	else if (verify?.error) rows.push(row("state/installer", "Installer item states", verify.error, INSPECT, { level: "error" }));
	else rows.push(row("state/note", "Item states, drift and repair", "press i to evaluate with agent-fleet inspect (not re-derived here)", "", { level: "info" }));
	for (const kind of snapshot.state.byKind) {
		const kindKey = `state/kind/${kind.kind}`;
		rows.push(row(kindKey, kind.kind, `${kind.count} item${kind.count === 1 ? "" : "s"}`, path, { expandable: true }));
		if (!expanded.has(kindKey)) continue;
		for (const item of snapshot.state.items.filter(item => item.kind === kind.kind)) {
			const itemKey = `state/item/${item.id}`;
			const counts = { unchanged: 0, modified: 0, missing: 0, other: 0 };
			for (const file of item.files) counts[file.check === "unchanged" || file.check === "modified" || file.check === "missing" ? file.check : "other"]++;
			const bad = counts.modified + counts.missing + counts.other;
			const installer = verifyItems.get(item.id);
			rows.push(row(itemKey, `  ${item.id}`, `${installer ? `${installer.state}${installer.detail ? ` (${installer.detail})` : ""} · ` : ""}${item.version ? `v${item.version} · ` : ""}${item.method ?? ""}${item.method ? " · " : ""}${item.files.length} file${item.files.length === 1 ? "" : "s"}${bad ? ` · ${counts.modified} modified · ${counts.missing} missing${counts.other ? ` · ${counts.other} other` : ""}` : " · unchanged"}`, path, { expandable: item.files.length > 0, level: bad ? "warn" : "ok", depth: 1 }));
			if (expanded.has(itemKey)) for (const file of item.files) rows.push(row(`${itemKey}/${file.path}`, `    ${file.path}`, file.check, file.path, { level: file.check === "unchanged" ? "ok" : "warn", depth: 2, path: file.check === "missing" ? undefined : file.path }));
		}
	}
	return rows;
}

function overridesRows(snapshot: FleetConfigSnapshot, expanded: Set<string>): ConfigRow[] {
	const path = SOURCE_PATHS.overrides;
	const rows = [row("ovr/file", "Overrides file", sourceDetail(snapshot, "overrides"), path, { level: snapshot.changedSinceStart.includes("overrides") ? "warn" : sourceLevel(snapshot.sources.overrides.status), path: snapshot.sources.overrides.status === "present" ? path : undefined })];
	if (snapshot.changedSinceStart.includes("overrides")) rows.push(row("ovr/restart", "Loaded at session start", "the file changed afterwards — the running session still uses the values read at start; restart to apply", "", { level: "warn" }));
	if (!snapshot.overrides) return rows;
	for (const section of snapshot.overrides.sections) {
		const key = `ovr/section/${section.name}`;
		rows.push(row(key, `## ${section.name}`, `${section.keys.length} key${section.keys.length === 1 ? "" : "s"}${section.alias ? " · alias of agent-hub" : ""}${section.canonical === "agent-hub" ? " · read by the Hub at session start" : ""}`, path, { expandable: section.keys.length > 0, path }));
		if (expanded.has(key)) for (const entry of section.keys) rows.push(row(`${key}/${entry.key}#${entry.line}`, `  ${entry.key}`, entry.value, `${path}:${entry.line}`, { depth: 1, path }));
	}
	const hub = snapshot.overrides.hub;
	if (hub) {
		rows.push(row("ovr/hub", "Effective Hub values", "as parsed by the Hub (invalid keys fall back to defaults and appear as warnings)", "runtime", { expandable: true }));
		if (expanded.has("ovr/hub")) {
			const effective: Array<[string, string]> = [
				["language", hub.language], ["rules", hub.rulesDirs.join(", ") || "—"], ["docs", hub.docsPaths.join(", ") || "—"],
				["watchdog", `${hub.watchdogSetting}${hub.watchdogJudgeModel ? ` · judge ${hub.watchdogJudgeModel}` : ""}`],
				["run-history-keep", hub.runHistoryKeep === null ? "off" : String(hub.runHistoryKeep)],
				["recon-search-timeout-s", hub.reconSearchTimeoutMs === null ? "off" : String(hub.reconSearchTimeoutMs / 1000)],
				["agent-turn-timeout-s", hub.budgetOverrides.agentTurnMs === undefined ? "task-tier default" : hub.budgetOverrides.agentTurnMs === null ? "off" : String(hub.budgetOverrides.agentTurnMs / 1000)],
				["session-recycle-runs", hub.budgetOverrides.recycleRuns === undefined ? "task-tier default" : hub.budgetOverrides.recycleRuns === null ? "off" : String(hub.budgetOverrides.recycleRuns)],
				["poll-panel", hub.pollPanel ?? "—"],
			];
			for (const [label, detail] of effective) rows.push(row(`ovr/hub/${label}`, `  ${label}`, detail, "runtime", { depth: 1 }));
			for (const [persona, model] of Object.entries(hub.personaModels)) rows.push(row(`ovr/hub/model.${persona}`, `  model.${persona}`, model, "runtime", { depth: 1 }));
			for (const [persona, list] of Object.entries(hub.personaModelLists)) rows.push(row(`ovr/hub/models.${persona}`, `  models.${persona}`, list.join(", "), "runtime", { depth: 1 }));
			for (const [persona, level] of Object.entries(hub.personaThinking)) rows.push(row(`ovr/hub/thinking.${persona}`, `  thinking.${persona}`, level, "runtime", { depth: 1 }));
			for (const [persona, depth] of Object.entries(hub.personaDelegateDepth)) rows.push(row(`ovr/hub/delegate-depth.${persona}`, `  delegate-depth.${persona}`, String(depth), "runtime", { depth: 1 }));
			hub.warnings.forEach((warning, index) => rows.push(row(`ovr/hub/warning/${index}`, "  warning", warning, "runtime", { depth: 1, level: "warn" })));
		}
	}
	return rows;
}

function aiStateRows(snapshot: FleetConfigSnapshot): ConfigRow[] {
	const path = SOURCE_PATHS.aiState;
	const rows = [row("ai/file", "AI state (provenance)", sourceDetail(snapshot, "aiState"), path, { level: sourceLevel(snapshot.sources.aiState.status), path: snapshot.sources.aiState.status === "present" ? path : undefined })];
	const provenance = inspectReport(snapshot)?.provenance;
	if (provenance?.status) rows.push(row("ai/installer", "Installer provenance check", `${provenance.status}${provenance.error ? ` · ${provenance.error}` : ""} · ${provenance.entries ?? 0} entries`, INSPECT, { level: provenance.status === "corrupt" ? "error" : provenance.status === "valid" ? "ok" : "info" }));
	if (!snapshot.aiState) return rows;
	if (!snapshot.aiState.entries.length) rows.push(row("ai/empty", "Accepted project files", "none recorded", path, { level: "info" }));
	for (const entry of snapshot.aiState.entries) rows.push(row(`ai/entry/${entry.path}`, `  ${entry.path}`, `${entry.origin}${entry.templateId ? ` ${entry.templateId}@${entry.sourceVersion ?? "?"}` : ""} · ${entry.acceptedDecision || "—"} · ${entry.evidenceCount} evidence · ${entry.local}`, path, { level: entry.local === "unchanged" ? "ok" : entry.local === "local-edit" ? "warn" : entry.local === "deleted" ? "error" : "info", path: entry.local === "deleted" ? undefined : entry.path }));
	rows.push(row("ai/note", "Source updates and conflicts", "only agent-fleet setup compares against the package catalogue; inspect reports the record's validity", "", { level: "info" }));
	return rows;
}

function system1Rows(snapshot: FleetConfigSnapshot): ConfigRow[] {
	const path = SOURCE_PATHS.system1;
	const s1 = snapshot.system1;
	const rows = [row("s1/file", "System 1 config", sourceDetail(snapshot, "system1"), path, { level: sourceLevel(snapshot.sources.system1.status), path: snapshot.sources.system1.status === "present" ? path : undefined })];
	if (!s1) return rows;
	rows.push(row("s1/selected", "Selected by desired state", onOff(s1.selected), SOURCE_PATHS.desired, { level: s1.selected ? "ok" : "info" }));
	rows.push(row("s1/status", "Document status", `${s1.status}${s1.errors ? ` · ${s1.errors} validation error${s1.errors === 1 ? "" : "s"}` : ""}`, path, { level: s1.status === "ready" ? "ok" : s1.status === "off" || s1.status === "missing" ? "info" : "error" }));
	rows.push(row("s1/provider", "Provider", `${s1.mode ?? "—"} · ${s1.provider ?? "—"} · ${s1.model ?? "—"}`, path));
	rows.push(row("s1/key", "API key variable", `${s1.apiKeyEnv ?? "—"} · ${presence(s1.apiKeyPresent)} in this process (value never shown)`, path, { level: s1.apiKeyPresent === false ? "warn" : "ok" }));
	rows.push(row("s1/readiness", "Readiness", `${s1.readiness.status}${s1.readiness.reason ? ` (${s1.readiness.reason})` : ""}`, "runtime", { level: s1.readiness.status === "ready" ? "ok" : s1.readiness.status === "skipped" ? "info" : "error" }));
	for (const consumer of s1.consumers) rows.push(row(`s1/consumer/${consumer.name}`, `  ${consumer.name}`, `${consumer.status}${consumer.mode ? ` · mode ${consumer.mode}` : ""}`, path, { level: consumer.status === "ready" ? "ok" : consumer.status === "off" ? "info" : "error" }));
	rows.push(row("s1/note", "Consent and remote context", "selection is not activation; consent stays a human decision in the file", "", { level: "info" }));
	return rows;
}

function sttRows(snapshot: FleetConfigSnapshot): ConfigRow[] {
	const path = SOURCE_PATHS.stt;
	const rows = [row("stt/file", "STT config", sourceDetail(snapshot, "stt"), path, { level: sourceLevel(snapshot.sources.stt.status), path: snapshot.sources.stt.status === "present" ? path : undefined })];
	if (!snapshot.stt) return rows;
	rows.push(row("stt/provider", "Provider", `${snapshot.stt.providerType ?? "—"} · language ${snapshot.stt.language ?? "—"}`, path));
	if (!snapshot.stt.envNames.length) rows.push(row("stt/env/none", "Environment variables", "none declared", path, { level: "info" }));
	for (const name of snapshot.stt.envNames) rows.push(row(`stt/env/${name.name}`, `  ${name.name}`, `${presence(name.present)} in this process (value never shown)`, path, { level: name.present ? "ok" : "warn" }));
	return rows;
}

function fleetRows(snapshot: FleetConfigSnapshot, expanded: Set<string>): ConfigRow[] {
	const rows: ConfigRow[] = [];
	const f = snapshot.fleet;
	rows.push(row("fleet/teams", "Teams", `${f.teams.length} · ${sourceDetail(snapshot, "teams")}`, SOURCE_PATHS.teams, { expandable: f.teams.length > 0, level: sourceLevel(snapshot.sources.teams.status), path: snapshot.sources.teams.status === "present" ? SOURCE_PATHS.teams : undefined }));
	if (expanded.has("fleet/teams")) for (const team of f.teams) rows.push(row(`fleet/team/${team.name}`, `  ${team.name}`, team.members.join(", ") || "—", SOURCE_PATHS.teams, { depth: 1 }));
	rows.push(row("fleet/peers", "Peers", `${f.peers.length} · ${sourceDetail(snapshot, "peers")}`, SOURCE_PATHS.peers, { expandable: f.peers.length > 0, level: sourceLevel(snapshot.sources.peers.status), path: snapshot.sources.peers.status === "present" ? SOURCE_PATHS.peers : undefined }));
	if (expanded.has("fleet/peers")) for (const peer of f.peers) rows.push(row(`fleet/peer/${peer.team}/${peer.name}`, `  ${peer.team}/${peer.name}`, `${peer.runner}${peer.model ? ` · ${peer.model}` : ""}${peer.persona && peer.persona !== peer.name ? ` · persona ${peer.persona}` : ""}${peer.extensions ? ` · ext ${peer.extensions}` : ""}${peer.envFile ? ` · env_file ${peer.envFile} ${presence(peer.envFilePresent)}` : ""}${peer.live ? " · LIVE" : ""}`, SOURCE_PATHS.peers, { depth: 1, level: peer.envFilePresent === false ? "warn" : peer.live ? "ok" : "info" }));
	if (f.dispatch) {
		rows.push(row("fleet/dispatch", "Dispatch policy", `default ${f.dispatch.default ?? "—"} · grace ${f.dispatch.graceS ?? "—"}s · ${f.dispatch.substitutions.length} substitution${f.dispatch.substitutions.length === 1 ? "" : "s"}`, SOURCE_PATHS.dispatch, { expandable: f.dispatch.substitutions.length > 0, path: SOURCE_PATHS.dispatch }));
		if (expanded.has("fleet/dispatch")) for (const sub of f.dispatch.substitutions) rows.push(row(`fleet/dispatch/${sub.member}`, `  ${sub.member}`, `prefer ${sub.prefer} · fallback ${sub.fallback}${sub.timeoutS ? ` · timeout ${sub.timeoutS}s` : ""} · ${sub.live ? "LIVE" : "not in pool"}`, SOURCE_PATHS.dispatch, { depth: 1, level: sub.live ? "ok" : sub.fallback === "none" ? "warn" : "info" }));
	} else rows.push(row("fleet/dispatch", "Dispatch policy", `${sourceDetail(snapshot, "dispatch")} · everything native`, SOURCE_PATHS.dispatch, { level: sourceLevel(snapshot.sources.dispatch.status) }));
	rows.push(row("fleet/voices", "Voice panels", `${f.voices.length} · ${sourceDetail(snapshot, "voices")}`, SOURCE_PATHS.voices, { expandable: f.voices.length > 0, level: sourceLevel(snapshot.sources.voices.status), path: snapshot.sources.voices.status === "present" ? SOURCE_PATHS.voices : undefined }));
	if (expanded.has("fleet/voices")) for (const panel of f.voices) rows.push(row(`fleet/voices/${panel.panel}`, `  ${panel.panel}`, panel.voices.map(voice => `${voice.name} ${voice.model}${voice.thinking ? `/${voice.thinking}` : ""}${voice.integrator ? " (integrator)" : ""}`).join(", ") || "—", SOURCE_PATHS.voices, { depth: 1 }));
	return rows;
}

function safetyRows(snapshot: FleetConfigSnapshot): ConfigRow[] {
	const rows = [row("safety/rules", "Damage-control rules", snapshot.safety.rules ? `${snapshot.safety.rules.reduce((sum, rule) => sum + rule.count, 0)} rules in ${snapshot.safety.rules.length} categories` : sourceDetail(snapshot, "damageRules"), SOURCE_PATHS.damageRules, { level: sourceLevel(snapshot.sources.damageRules.status), path: snapshot.sources.damageRules.status === "present" ? SOURCE_PATHS.damageRules : undefined })];
	for (const rule of snapshot.safety.rules ?? []) rows.push(row(`safety/rules/${rule.category}`, `  ${rule.category}`, String(rule.count), SOURCE_PATHS.damageRules, { depth: 1 }));
	const policy = snapshot.safety.autoPolicy;
	rows.push(row("safety/auto", "Auto policy (user opt-in)", `${policy.status} · ${policy.rules} rule${policy.rules === 1 ? "" : "s"}${policy.expired ? ` · ${policy.expired} expired` : ""} · digest ${policy.digest.slice(0, 12)}`, SOURCE_PATHS.autoPolicy, { level: policy.status === "invalid" ? "error" : policy.status === "valid" ? "ok" : "info", path: snapshot.sources.autoPolicy.status === "present" ? SOURCE_PATHS.autoPolicy : undefined }));
	rows.push(row("safety/exemptions", "Active exemptions", "/af-allowed lists them; /af-allow and /af-revoke change them", "runtime", { level: "info" }));
	return rows;
}

export function fleetConfigRows(snapshot: FleetConfigSnapshot, tab: TabId, expanded: Set<string> = new Set(), state?: FleetConfigViewState): ConfigRow[] {
	switch (tab) {
		case "overview": return overviewRows(snapshot, expanded);
		case "setup": return setupRows(snapshot, state);
		case "state": return stateRows(snapshot, expanded);
		case "overrides": return overridesRows(snapshot, expanded);
		case "aiState": return aiStateRows(snapshot);
		case "system1": return system1Rows(snapshot);
		case "stt": return sttRows(snapshot);
		case "fleet": return fleetRows(snapshot, expanded);
		case "safety": return safetyRows(snapshot);
		case "runtime": return (snapshot.runtime ?? []).map((entry, index) => row(`runtime/${index}`, entry.label, entry.detail, entry.origin ?? "runtime"));
	}
}

export function keepSelectionVisible(state: FleetConfigViewState, rows: readonly ConfigRow[], bodyHeight: number): void {
	const viewport = Math.max(1, bodyHeight);
	if (state.selection.index < state.scrollOffset) state.scrollOffset = state.selection.index;
	else if (state.selection.index >= state.scrollOffset + viewport) state.scrollOffset = state.selection.index - viewport + 1;
	state.scrollOffset = clampScroll(state.scrollOffset, rows.length, viewport);
}

/** Full labels when they fit, otherwise abbreviated inactive tabs, otherwise numbers only. */
export function tabBarText(tabs: readonly TabId[], active: TabId, width: number, theme: ThemeLike, metrics: TextMetrics): string {
	const build = (label: (tab: TabId) => string, padded: boolean) => tabs.map((tab, index) => {
		const number = (index + 1) % 10;
		if (tab === active) return theme.fg("accent", `[${number} ${TAB_LABELS[tab]}]`);
		const text = label(tab) ? `${number} ${label(tab)}` : String(number);
		return theme.fg("dim", padded ? ` ${text} ` : text);
	}).join(" ");
	const variants: Array<[(tab: TabId) => string, boolean]> = [[tab => TAB_LABELS[tab], true], [tab => TAB_LABELS[tab].replace(/\s+/g, "").slice(0, 3), false], [() => "", false]];
	for (const [label, padded] of variants) {
		const bar = build(label, padded);
		if (metrics.visibleWidth(bar) <= width) return bar;
	}
	return build(() => "", false);
}

const levelColor: Record<RowLevel, string> = { ok: "success", info: "muted", warn: "warning", error: "error" };
const glyph: Record<RowLevel, string> = { ok: "●", info: "○", warn: "▲", error: "✗" };

/** Fixed-height rendering: title, tab bar, body rows, footer. */
export function renderFleetConfig(snapshot: FleetConfigSnapshot, state: FleetConfigViewState, width: number, bodyHeight: number, theme: ThemeLike, metrics: TextMetrics): string[] {
	const w = Math.max(1, width);
	const fit = (text: string) => metrics.truncateToWidth(text, w);
	const tabs = fleetConfigTabs(snapshot);
	if (!tabs.includes(state.tab)) state.tab = "overview";
	const rows = fleetConfigRows(snapshot, state.tab, state.expanded, state);
	reconcileSelection(state.selection, rows);
	keepSelectionVisible(state, rows, bodyHeight);
	const problems = problemCount(snapshot);
	const inspectLabel = snapshot.inspect && snapshot.inspect.status !== "idle" ? ` · inspect ${snapshot.inspect.status}` : "";
	const draftLabel = state.draft && !sameDraft(state.draft, draftFromSnapshot(snapshot)) ? " · draft" : "";
	const busyLabel = state.busy ? ` · ${s(state.busy)}` : "";
	const title = fit(theme.bold(`FLEET CONFIG  ${s(snapshot.workspaceRoot)} · v${snapshot.overview.recordedVersion ?? "—"} · ${problems} source problem${problems === 1 ? "" : "s"}${snapshot.changedSinceStart.length ? ` · ${snapshot.changedSinceStart.length} changed since start` : ""}${inspectLabel}${draftLabel}${busyLabel} · writes only via CLI`));
	const tabBar = fit(tabBarText(tabs, state.tab, w, theme, metrics));
	const visible = rows.slice(state.scrollOffset, state.scrollOffset + Math.max(0, bodyHeight));
	const body = visible.map(entry => {
		const selected = state.selection.key === entry.key;
		const level = entry.level ?? "info";
		const marker = entry.expandable ? (state.expanded.has(entry.key) ? "▾" : "▸") : glyph[level];
		const origin = entry.origin ? theme.fg("dim", `  [${entry.origin}]`) : "";
		const line = `${selected ? ">" : " "} ${theme.fg(levelColor[level], marker)} ${entry.label} ${theme.fg("dim", "—")} ${entry.detail}${origin}`;
		return fit(selected ? theme.bold(line) : line);
	});
	const empty = rows.length === 0 ? [fit(theme.fg("muted", "  nothing to show on this tab"))] : [];
	const tabKeys = state.tab === "setup" ? "Space toggle · p preset · a apply via CLI · u discard · " : state.tab === "overrides" ? "a configure rules/docs via CLI · " : "";
	const footer = fit(theme.fg("dim", `${tabKeys}←→/Tab · 1-9 · ↑↓ PgUp PgDn · Enter expand · o open · i inspect · r reload · q close · ${state.scrollOffset + Math.min(rows.length, visible.length)}/${rows.length}`));
	return fitToHeight([title, tabBar, ...fitToHeight([...empty, ...body], Math.max(0, bodyHeight)), footer], bodyHeight + FLEET_CONFIG_CHROME_ROWS);
}

/** Headless rendering (no UI): the Overview tab as plain text for ctx.ui.notify. */
export function fleetConfigHeadlessText(snapshot: FleetConfigSnapshot, tab: TabId = "overview"): string {
	const rows = fleetConfigRows(snapshot, tab, new Set());
	return [`Fleet config · ${TAB_LABELS[tab]} · ${snapshot.workspaceRoot}`, ...rows.map(entry => `${entry.label.trim()}: ${entry.detail}${entry.origin ? ` [${entry.origin}]` : ""}`)].join("\n");
}
