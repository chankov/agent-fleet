/**
 * fleet-config/snapshot — deterministic, side-effect-free collection of the
 * configuration facts a live Fleet session can show without a model.
 *
 * Boundaries (see docs/plans/todo/PLAN-fleet-config-screen.md):
 *   - Only file facts: existence, size, parse, sha256 against a recorded hash,
 *     environment variable present/absent. Installer rules (item states,
 *     action kinds, feature availability) stay in bin/lib and arrive through
 *     the CLI in a later phase; nothing here re-derives them.
 *   - No secrets: environment values, env_file contents and key material are
 *     never read, rendered or logged. Only variable names and presence.
 *   - Symbolic links under .ai/ are refused exactly like installation-state.js.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readInstallationState } from "../installation-state.js";
import { safeSourceRead } from "../safe-source-read.js";
import { loadDamageAutoPolicy } from "../damage-auto-policy.ts";
import { loadSystem1Snapshot, readSystem1Selected } from "../system1/config-loader.js";
import { resolveSystem1Readiness } from "../system1/config.js";
import { workspaceRoot } from "../workspace-context.ts";
import type { CliResolution, InspectReport } from "./cli-bridge.ts";

export type SourceStatus = "present" | "missing" | "invalid" | "refused";
export interface SourceFile { path: string; status: SourceStatus; digest?: string; bytes?: number; problems: string[] }

export const SOURCE_IDS = [
	"desired", "state", "setup", "transaction", "overrides", "aiState", "system1", "stt",
	"teams", "peers", "dispatch", "voices", "damageRules", "autoPolicy",
] as const;
export type SourceId = typeof SOURCE_IDS[number];
export const SOURCE_PATHS: Record<SourceId, string> = {
	desired: ".ai/agent-fleet.json",
	state: ".ai/agent-fleet-state.json",
	setup: ".ai/agent-fleet-setup.md",
	transaction: ".ai/agent-fleet-transaction.json",
	overrides: ".ai/agent-fleet-overrides.md",
	aiState: ".ai/agent-fleet-ai-state.json",
	system1: ".ai/system1.json",
	stt: ".ai/stt.json",
	teams: ".pi/agents/teams.yaml",
	peers: ".pi/agents/peers.yaml",
	dispatch: ".pi/agents/dispatch-policy.yaml",
	voices: ".pi/agents/voices.yaml",
	damageRules: ".pi/damage-control-rules.yaml",
	autoPolicy: ".pi/damage-control-auto-policy.yaml",
};
const MAX_SOURCE_BYTES = 1024 * 1024;

/** The subset of the Hub's parsed overrides the screen renders; injected so this module stays independent of agent-hub. */
export interface HubOverridesLike {
	language: string;
	personaModels: Record<string, string>;
	personaModelLists: Record<string, string[]>;
	personaThinking: Record<string, string>;
	personaDelegateDepth: Record<string, number>;
	rulesDirs: string[];
	docsPaths: string[];
	reconSearchTimeoutMs: number | null;
	budgetOverrides: { agentTurnMs?: number | null; recycleRuns?: number | null };
	watchdogSetting: string;
	watchdogJudgeModel: string | null;
	runHistoryKeep: number | null;
	pollPanel: string | null;
	warnings: string[];
}

export interface RuntimeRow { label: string; detail: string; origin?: string }

export interface SnapshotInput {
	cwd: string;
	/** Only `name in env` and emptiness are consulted; values never leave this function. */
	env?: NodeJS.ProcessEnv;
	now?: number;
	/** Digests recorded when the session started, keyed by source id. */
	startDigests?: Partial<Record<SourceId, string>>;
	/** Hub-only: the overrides parser the Hub itself uses. */
	readHubOverrides?: (cwd: string) => HubOverridesLike;
	/** Names of peers currently registered in the coms pool (Hub or peer supplies its own scope). */
	livePeerNames?: () => readonly string[];
	/** Hub-only: in-memory facts (work mode, roster, identity). */
	runtimeRows?: () => readonly RuntimeRow[];
	/** Cached latest published version, if the update check has one. */
	latestKnownVersion?: string | null;
}

/** Phase 2: the installer evaluation obtained through the CLI; attached by the UI host, never collected here. */
export type InspectState =
	| { status: "idle"; resolution: CliResolution }
	| { status: "running"; startedAt: number; resolution: CliResolution }
	| { status: "ok"; report: InspectReport; exitCode: number; resolution: CliResolution; at: number }
	| { status: "failed"; reason: string; detail: string; resolution: CliResolution; at: number };

export type FileCheck = "unchanged" | "modified" | "missing" | "link" | "unreadable";
export interface StateItemView { id: string; kind: string; version?: string; method?: string; files: Array<{ path: string; check: FileCheck }> }
export interface OverrideSection { name: string; canonical: string; alias: boolean; keys: Array<{ key: string; value: string; line: number }> }
export interface AiStateEntryView { path: string; origin: string; templateId?: string; sourceVersion?: string; acceptedDecision: string; evidenceCount: number; local: "unchanged" | "local-edit" | "deleted" | "unknown" }
export interface EnvNameView { name: string; present: boolean }

export interface FleetConfigSnapshot {
	workspaceRoot: string;
	collectedAt: number;
	sources: Record<SourceId, SourceFile>;
	changedSinceStart: SourceId[];
	overview: {
		recordedVersion: string | null; latestKnownVersion: string | null; method: string | null;
		sourceRoot: string | null; sourceRootPresent: boolean | null; installedAt: string | null; updatedAt: string | null;
		transactionPending: boolean; installationStatus: string; installationReason?: string;
	};
	setup: { preset: string | null; schemaVersion: number | null; features: Array<{ name: string; enabled: boolean }> } | null;
	state: { items: StateItemView[]; byKind: Array<{ kind: string; count: number }>; files: { total: number; unchanged: number; modified: number; missing: number; other: number } } | null;
	overrides: { sections: OverrideSection[]; hub: HubOverridesLike | null } | null;
	aiState: { entries: AiStateEntryView[] } | null;
	system1: { selected: boolean; status: string; mode: string | null; provider: string | null; model: string | null; apiKeyEnv: string | null; apiKeyPresent: boolean | null; readiness: { status: string; reason?: string }; consumers: Array<{ name: string; status: string; mode: string | null }>; errors: number } | null;
	stt: { providerType: string | null; language: string | null; envNames: EnvNameView[] } | null;
	fleet: {
		teams: Array<{ name: string; members: string[] }>;
		peers: Array<{ team: string; name: string; persona: string | null; runner: string; model: string | null; extensions: string | null; envFile: string | null; envFilePresent: boolean | null; live: boolean }>;
		dispatch: { default: string | null; graceS: number | null; substitutions: Array<{ member: string; prefer: string; fallback: string; timeoutS: number | null; live: boolean }> } | null;
		voices: Array<{ panel: string; voices: Array<{ name: string; model: string; thinking: string | null; integrator: boolean }> }>;
	};
	safety: { rules: Array<{ category: string; count: number }> | null; autoPolicy: { status: string; digest: string; rules: number; expired: number } };
	runtime: RuntimeRow[] | null;
	inspect?: InspectState;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

function readSource(root: string, id: SourceId): { file: SourceFile; bytes?: Buffer } {
	const path = SOURCE_PATHS[id];
	const full = join(root, path);
	let stat;
	try { stat = lstatSync(full); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: { path, status: "missing", problems: [] } };
		return { file: { path, status: "refused", problems: ["unreadable"] } };
	}
	if (stat.isSymbolicLink()) return { file: { path, status: "refused", problems: ["symbolic link refused"] } };
	if (!stat.isFile()) return { file: { path, status: "refused", problems: ["not a regular file"] } };
	try {
		const bytes = safeSourceRead(root, full, MAX_SOURCE_BYTES);
		return { file: { path, status: "present", digest: sha256(bytes), bytes: bytes.length, problems: [] }, bytes };
	} catch (error) {
		const reason = (error as Error).message;
		return { file: { path, status: "refused", problems: [reason === "state_too_large" ? "larger than 1 MiB" : reason === "source_denied" ? "path refused" : "changed while reading"] } };
	}
}

function parseJson(file: SourceFile, bytes: Buffer | undefined): Record<string, unknown> | undefined {
	if (!bytes) return undefined;
	try {
		const value = JSON.parse(bytes.toString("utf8"));
		if (!isRecord(value)) { file.status = "invalid"; file.problems.push("not a JSON object"); return undefined; }
		return value;
	} catch { file.status = "invalid"; file.problems.push("invalid JSON"); return undefined; }
}

function parseYamlDoc(file: SourceFile, bytes: Buffer | undefined): unknown {
	if (!bytes) return undefined;
	try { return parseYaml(bytes.toString("utf8"), { uniqueKeys: true, maxAliasCount: 0 }) ?? null; }
	catch { file.status = "invalid"; file.problems.push("invalid YAML"); return undefined; }
}

function checkRecordedFile(root: string, path: string, recorded: unknown): FileCheck {
	const full = join(root, path);
	let stat;
	try { stat = lstatSync(full); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
	if (stat.isSymbolicLink()) return "link";
	if (!stat.isFile() || typeof recorded !== "string") return "unreadable";
	try { return sha256(readFileSync(full)) === recorded ? "unchanged" : "modified"; } catch { return "unreadable"; }
}

function envPresent(env: NodeJS.ProcessEnv, name: string): boolean {
	const value = env[name];
	return typeof value === "string" && value.trim().length > 0;
}

/** Collect every `*Env` key (names only) from a non-secret config tree. */
function envNames(value: unknown, out: string[] = []): string[] {
	if (!isRecord(value)) return out;
	for (const [key, item] of Object.entries(value)) {
		if (/Env$/.test(key) && typeof item === "string" && item) out.push(item);
		else if (isRecord(item)) envNames(item, out);
	}
	return out;
}

export function parseOverrideSections(raw: string): OverrideSection[] {
	const sections: OverrideSection[] = [];
	let current: OverrideSection | null = null;
	raw.split("\n").forEach((rawLine, index) => {
		const line = rawLine.replace(/\r$/, "");
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			const name = heading[1].trim();
			const lower = name.toLowerCase();
			current = { name, canonical: lower === "agent-team" ? "agent-hub" : lower, alias: lower === "agent-team", keys: [] };
			sections.push(current);
			return;
		}
		if (!current) return;
		const pair = line.match(/^\s*([a-zA-Z][\w.-]*)\s*:\s*(.+?)\s*$/);
		if (pair) current.keys.push({ key: pair[1], value: pair[2], line: index + 1 });
	});
	return sections;
}

function collectState(root: string, sources: Record<SourceId, SourceFile>) {
	const installation = readInstallationState(root);
	const overview = {
		installationStatus: installation.status, installationReason: installation.reason,
		recordedVersion: null as string | null, method: null as string | null, sourceRoot: null as string | null,
		sourceRootPresent: null as boolean | null, installedAt: null as string | null, updatedAt: null as string | null,
	};
	if (installation.status === "invalid" && sources.state.status === "present") { sources.state.status = "invalid"; sources.state.problems.push(installation.reason ?? "invalid installation evidence"); }
	if (installation.status === "invalid" && installation.reason === "invalid_desired" && sources.desired.status === "present") { sources.desired.status = "invalid"; sources.desired.problems.push("not a JSON object"); }
	const state = installation.state;
	if (!state) return { overview, state: null };
	overview.recordedVersion = typeof state.packageVersion === "string" ? state.packageVersion : null;
	overview.method = typeof state.method === "string" ? state.method : null;
	overview.sourceRoot = typeof state.sourceRoot === "string" ? state.sourceRoot : null;
	overview.sourceRootPresent = overview.sourceRoot ? existsSync(resolve(overview.sourceRoot)) : null;
	overview.installedAt = typeof state.installedAt === "string" ? state.installedAt : null;
	overview.updatedAt = typeof state.updatedAt === "string" ? state.updatedAt : null;
	const items: StateItemView[] = [];
	const files = { total: 0, unchanged: 0, modified: 0, missing: 0, other: 0 };
	const byKind = new Map<string, number>();
	for (const [id, raw] of Object.entries(isRecord(state.items) ? state.items : {})) {
		if (!isRecord(raw)) continue;
		const kind = typeof raw.kind === "string" ? raw.kind : "unknown";
		byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
		const views = (Array.isArray(raw.files) ? raw.files : []).filter(isRecord).map(file => {
			const check = checkRecordedFile(root, text(file.path), file.sha256);
			files.total++;
			if (check === "unchanged") files.unchanged++; else if (check === "modified") files.modified++; else if (check === "missing") files.missing++; else files.other++;
			return { path: text(file.path), check };
		});
		items.push({ id, kind, version: typeof raw.version === "string" ? raw.version : undefined, method: typeof raw.method === "string" ? raw.method : undefined, files: views });
	}
	items.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
	return { overview, state: { items, byKind: [...byKind].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind)), files } };
}

function collectAiState(root: string, file: SourceFile, bytes: Buffer | undefined) {
	const parsed = parseJson(file, bytes);
	if (!parsed) return null;
	if (!isRecord(parsed.entries)) { file.status = "invalid"; file.problems.push("entries is not an object"); return null; }
	const entries: AiStateEntryView[] = Object.entries(parsed.entries).map(([path, raw]) => {
		const entry = isRecord(raw) ? raw : {};
		const target = join(root, path);
		let local: AiStateEntryView["local"] = "unknown";
		if (typeof entry.appliedHash === "string") {
			try {
				const stat = lstatSync(target);
				local = stat.isFile() ? (sha256(readFileSync(target)) === entry.appliedHash ? "unchanged" : "local-edit") : "unknown";
			} catch (error) { local = (error as NodeJS.ErrnoException).code === "ENOENT" ? "deleted" : "unknown"; }
		}
		return {
			path, origin: text(entry.origin) || "unknown",
			templateId: typeof entry.templateId === "string" ? entry.templateId : undefined,
			sourceVersion: typeof entry.sourceVersion === "string" ? entry.sourceVersion : undefined,
			acceptedDecision: text(entry.acceptedDecision), evidenceCount: Array.isArray(entry.evidence) ? entry.evidence.length : 0, local,
		};
	}).sort((a, b) => a.path.localeCompare(b.path));
	return { entries };
}

function collectSystem1(root: string, env: NodeJS.ProcessEnv, file: SourceFile) {
	const selected = readSystem1Selected(root) === true;
	const snapshot: any = loadSystem1Snapshot(root);
	if (snapshot.status === "invalid" && file.status === "present") { file.status = "invalid"; file.problems.push(...(snapshot.errors ?? []).slice(0, 5).map((e: any) => text(e.path ?? e))); }
	const document = isRecord(snapshot.document) ? snapshot.document : isRecord(snapshot.legacyProvider) ? snapshot.legacyProvider : null;
	const apiKeyEnv = document && typeof document.apiKeyEnv === "string" ? document.apiKeyEnv : null;
	const readiness = resolveSystem1Readiness({ selected, config: snapshot.status === "missing" ? undefined : snapshot.document ?? null, env }) as { status: string; reason?: string };
	const consumers = Object.entries(isRecord(snapshot.consumers) ? snapshot.consumers : {}).map(([name, raw]) => {
		const consumer = isRecord(raw) ? raw : {};
		const config = isRecord(consumer.config) ? consumer.config : null;
		const declared = document && isRecord(document.consumers) && isRecord((document.consumers as any)[name]) ? (document.consumers as any)[name] : null;
		return { name, status: text(consumer.status) || "off", mode: config && typeof config.mode === "string" ? config.mode : declared && typeof declared.mode === "string" ? declared.mode : null };
	});
	return {
		selected, status: text(snapshot.status), mode: document && typeof document.mode === "string" ? document.mode : null,
		provider: document && typeof document.provider === "string" ? document.provider : null,
		model: document && typeof document.model === "string" ? document.model : null,
		apiKeyEnv, apiKeyPresent: apiKeyEnv ? envPresent(env, apiKeyEnv) : null, readiness, consumers,
		errors: Array.isArray(snapshot.errors) ? snapshot.errors.length : 0,
	};
}

function collectStt(env: NodeJS.ProcessEnv, file: SourceFile, bytes: Buffer | undefined) {
	const parsed = parseJson(file, bytes);
	if (!parsed) return null;
	const provider = parsed.provider;
	const providerType = typeof provider === "string" ? provider : isRecord(provider) && typeof provider.type === "string" ? provider.type : null;
	return {
		providerType, language: typeof parsed.language === "string" ? parsed.language : null,
		envNames: [...new Set(envNames(parsed))].map(name => ({ name, present: envPresent(env, name) })),
	};
}

function collectFleet(root: string, sources: Record<SourceId, SourceFile>, bytes: Partial<Record<SourceId, Buffer>>, live: Set<string>) {
	const teamsDoc = parseYamlDoc(sources.teams, bytes.teams);
	const teams = isRecord(teamsDoc) ? Object.entries(teamsDoc).map(([name, members]) => ({ name, members: Array.isArray(members) ? members.map(text) : [] })) : [];
	if (teamsDoc !== undefined && teamsDoc !== null && !isRecord(teamsDoc)) { sources.teams.status = "invalid"; sources.teams.problems.push("not a mapping"); }
	const peersDoc = parseYamlDoc(sources.peers, bytes.peers);
	const peers: FleetConfigSnapshot["fleet"]["peers"] = [];
	if (isRecord(peersDoc)) {
		for (const [team, list] of Object.entries(peersDoc)) {
			for (const raw of Array.isArray(list) ? list : []) {
				if (!isRecord(raw)) continue;
				const envFile = typeof raw.env_file === "string" ? raw.env_file : null;
				const name = text(raw.name) || text(raw.persona);
				peers.push({
					team, name, persona: typeof raw.persona === "string" ? raw.persona : null, runner: typeof raw.runner === "string" ? raw.runner : "pi",
					model: typeof raw.model === "string" ? raw.model : null, extensions: typeof raw.extensions === "string" ? raw.extensions : null,
					envFile, envFilePresent: envFile ? existsSync(join(root, envFile)) : null, live: live.has(name),
				});
			}
		}
	} else if (peersDoc !== undefined && peersDoc !== null) { sources.peers.status = "invalid"; sources.peers.problems.push("not a mapping"); }
	const dispatchDoc = parseYamlDoc(sources.dispatch, bytes.dispatch);
	let dispatch: FleetConfigSnapshot["fleet"]["dispatch"] = null;
	if (isRecord(dispatchDoc)) {
		dispatch = {
			default: typeof dispatchDoc.default === "string" ? dispatchDoc.default : null,
			graceS: typeof dispatchDoc.grace_s === "number" ? dispatchDoc.grace_s : null,
			substitutions: Object.entries(isRecord(dispatchDoc.substitutions) ? dispatchDoc.substitutions : {}).map(([member, raw]) => {
				const sub = isRecord(raw) ? raw : {};
				return { member, prefer: typeof sub.prefer === "string" ? sub.prefer : "coms", fallback: typeof sub.fallback === "string" ? sub.fallback : "native", timeoutS: typeof sub.timeout_s === "number" ? sub.timeout_s : null, live: live.has(member) };
			}),
		};
	} else if (dispatchDoc !== undefined && dispatchDoc !== null) { sources.dispatch.status = "invalid"; sources.dispatch.problems.push("not a mapping"); }
	const voicesDoc = parseYamlDoc(sources.voices, bytes.voices);
	const voices = isRecord(voicesDoc) ? Object.entries(voicesDoc).map(([panel, list]) => ({
		panel, voices: (Array.isArray(list) ? list : []).filter(isRecord).map(voice => ({ name: text(voice.name), model: text(voice.model), thinking: typeof voice.thinking === "string" ? voice.thinking : null, integrator: voice.integrator === true })),
	})) : [];
	if (voicesDoc !== undefined && voicesDoc !== null && !isRecord(voicesDoc)) { sources.voices.status = "invalid"; sources.voices.problems.push("not a mapping"); }
	return { teams, peers, dispatch, voices };
}

function collectSafety(root: string, now: number, sources: Record<SourceId, SourceFile>, bytes: Partial<Record<SourceId, Buffer>>) {
	const rulesDoc = parseYamlDoc(sources.damageRules, bytes.damageRules);
	let rules: Array<{ category: string; count: number }> | null = null;
	if (isRecord(rulesDoc)) rules = Object.entries(rulesDoc).map(([category, list]) => ({ category, count: Array.isArray(list) ? list.length : isRecord(list) ? Object.keys(list).length : 0 }));
	else if (rulesDoc !== undefined && rulesDoc !== null) { sources.damageRules.status = "invalid"; sources.damageRules.problems.push("not a mapping"); }
	const policy = loadDamageAutoPolicy(root);
	if (policy.status === "invalid" && sources.autoPolicy.status === "present") { sources.autoPolicy.status = "invalid"; sources.autoPolicy.problems.push("refused by the auto-policy loader"); }
	return { rules, autoPolicy: { status: policy.status, digest: policy.digest, rules: policy.rules.length, expired: policy.rules.filter(rule => Date.parse(rule.expiresAt) < now).length } };
}

/** Collect the snapshot. Never throws for a broken workspace; every problem lands in `sources[*].problems`. */
export function collectFleetConfigSnapshot(input: SnapshotInput): FleetConfigSnapshot {
	const env = input.env ?? process.env;
	const now = input.now ?? Date.now();
	const root = workspaceRoot(input.cwd, env);
	const sources = {} as Record<SourceId, SourceFile>;
	const bytes: Partial<Record<SourceId, Buffer>> = {};
	for (const id of SOURCE_IDS) { const read = readSource(root, id); sources[id] = read.file; if (read.bytes) bytes[id] = read.bytes; }

	const { overview, state } = collectState(root, sources);
	const desiredDoc = sources.desired.status === "present" ? parseJson(sources.desired, bytes.desired) : undefined;
	const setup = desiredDoc ? {
		preset: typeof desiredDoc.preset === "string" ? desiredDoc.preset : null,
		schemaVersion: typeof desiredDoc.schemaVersion === "number" ? desiredDoc.schemaVersion : null,
		features: Object.entries(isRecord(desiredDoc.features) ? desiredDoc.features : {}).map(([name, enabled]) => ({ name, enabled: enabled === true })).sort((a, b) => a.name.localeCompare(b.name)),
	} : null;
	if (desiredDoc && !isRecord(desiredDoc.features)) { sources.desired.status = "invalid"; sources.desired.problems.push("features is not an object"); }

	let overrides: FleetConfigSnapshot["overrides"] = null;
	if (bytes.overrides) {
		let hub: HubOverridesLike | null = null;
		try { hub = input.readHubOverrides?.(root) ?? null; } catch (error) { sources.overrides.problems.push(`hub parser: ${(error as Error).message}`); }
		overrides = { sections: parseOverrideSections(bytes.overrides.toString("utf8")), hub };
	} else if (input.readHubOverrides) {
		try { overrides = { sections: [], hub: input.readHubOverrides(root) }; } catch { overrides = null; }
	}

	const live = new Set<string>();
	try { for (const name of input.livePeerNames?.() ?? []) live.add(name); } catch { /* registry unavailable: no LIVE marks */ }

	const snapshot: FleetConfigSnapshot = {
		workspaceRoot: root, collectedAt: now, sources, changedSinceStart: [],
		overview: { ...overview, latestKnownVersion: input.latestKnownVersion ?? null, transactionPending: sources.transaction.status === "present" },
		setup, state, overrides,
		aiState: collectAiState(root, sources.aiState, bytes.aiState),
		system1: collectSystem1(root, env, sources.system1),
		stt: collectStt(env, sources.stt, bytes.stt),
		fleet: collectFleet(root, sources, bytes, live),
		safety: collectSafety(root, now, sources, bytes),
		runtime: null,
	};
	try { snapshot.runtime = input.runtimeRows ? [...input.runtimeRows()] : null; } catch { snapshot.runtime = null; }
	for (const id of SOURCE_IDS) {
		const start = input.startDigests?.[id];
		if (start !== undefined && (sources[id].digest ?? "") !== start) snapshot.changedSinceStart.push(id);
	}
	return snapshot;
}

/** Digest table for recording the session-start baseline. */
export function sourceDigests(snapshot: FleetConfigSnapshot): Partial<Record<SourceId, string>> {
	const out: Partial<Record<SourceId, string>> = {};
	for (const id of SOURCE_IDS) out[id] = snapshot.sources[id].digest ?? "";
	return out;
}

/** Count problems per source for the Overview tab. */
export function problemCount(snapshot: FleetConfigSnapshot): number {
	return SOURCE_IDS.reduce((sum, id) => sum + snapshot.sources[id].problems.length + (snapshot.sources[id].status === "invalid" || snapshot.sources[id].status === "refused" ? 1 : 0), 0);
}
