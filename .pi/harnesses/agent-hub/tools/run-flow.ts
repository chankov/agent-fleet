import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import {sessionRootsFromEnv,resolveSessionRoots,withSessionRoots,validateSessionRoots} from '../../lib/workspace-context.ts';
import { mkdirSync, mkdtempSync, rmSync,realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { executeFlow, type HubScoutExecution } from "../../../agent-fleet/scripts/flow.ts";
import { insideRepository } from "../../../agent-fleet/scripts/workflows/lib/git.ts";
import { createIsolatedWorkingTreeSnapshot, type IsolatedSnapshotManifest } from "../../../agent-fleet/scripts/workflows/lib/isolated-snapshot.ts";
import type { ScoutWorkflowDeps } from "../../../agent-fleet/scripts/workflows/wf-scout.ts";
import { worktreeRevision } from "../scope-gate.js";
import { buildRuntimeResult } from "../acceptance.ts";

export interface RunFlowParams { procedure: "scout"; request: string; invocation_id: string; repo?: string }
export interface HubFlowBudgetReservation { charged: boolean; operation: "research"; owner: "hub"; refusal?: string }
export interface RunFlowDeps {
	sessionDir(): string | null;
	taskId(): string;
	reserveBudget(params: RunFlowParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<HubFlowBudgetReservation>;
	processObligations(): unknown;
	effectiveScoutConfig(cwd: string): { model: string; profile: string | null; tools: string[]; fallback: string | null; allowlisted: boolean };
	execute?: typeof executeFlow;
	createSnapshot?: typeof createIsolatedWorkingTreeSnapshot;
	removeSnapshot?: (root: string) => void;
	scoutAgent?: ScoutWorkflowDeps["agent"];
	worktreeRevision?: typeof worktreeRevision;
	buildRuntimeResult?: typeof buildRuntimeResult;
	/** Nested repositories the task already uses; named in the refusal when `repo` is missing. */
	nestedRepositories?(): readonly string[];
}

type SessionRoots = ReturnType<typeof resolveSessionRoots>;
/** D9: at a workspace root that is not a repository, scout works in exactly one nested repository the caller names. */
function nestedTarget(roots: SessionRoots | undefined, cwd: string, repo: string | undefined, known: (() => readonly string[]) | undefined): { binding?: SessionRoots } | { refusal: string } {
	if (repo === undefined) {
		if (roots?.mode === "targeted" || insideRepository(cwd)) return {};
		const list = known?.() ?? [];
		return { refusal: `The workspace root is not a Git repository; pass repo: with the nested repository to scout${list.length ? ` (this task uses ${list.join(", ")})` : ""}.` };
	}
	if (roots?.mode === "targeted") return { refusal: "repo is unavailable in a session already bound to a target checkout." };
	if (insideRepository(cwd)) return { refusal: "repo applies only when the workspace root is not a Git repository." };
	const path = repo.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	if (!path || isAbsolute(path) || path.split("/").includes("..")) return { refusal: `repo must be a path inside the workspace: ${JSON.stringify(repo)}` };
	let binding: SessionRoots;
	try { binding = resolveSessionRoots(cwd, { worktree: path }); }
	catch (error) { return { refusal: `repo ${JSON.stringify(repo)} is not a nested repository checkout: ${message(error)}` }; }
	const fromRoot = relative(cwd, binding.executionRoot);
	if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return { refusal: `repo must lie inside the workspace: ${JSON.stringify(repo)}` };
	return { binding };
}

interface StoredRun { promise: Promise<any>; controller: AbortController; request: string;scope:string }

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function failure(status: string, error: unknown, budgetCharged: boolean, executionStarted: boolean, extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: `Scout flow failed safely: ${message(error)}` }],
		details: { status, budgetCharged, budgetOwner: "hub", executionStarted, parentAcceptance: { accepted: false, status: "not_accepted", assertionsProven: [] }, error: message(error), ...extra },
	};
}

export function registerRunFlow(pi: ExtensionAPI, deps: RunFlowDeps): void {
	const runs = new Map<string, StoredRun>();
	let activeId: string | null = null;
 let sessionEpoch=0;
	pi.on("session_shutdown", () => {sessionEpoch++;for (const run of runs.values()) run.controller.abort("session shutdown");runs.clear();activeId=null;});
	pi.registerTool({
		name: "run_flow", label: "Run Flow", description: "Run the read-only scout workflow in an isolated no-branch snapshot. Initial T13 surface; writable flows are unavailable. When the workspace root is not a Git repository, name the nested repository with repo.",
		parameters: Type.Object({
			procedure: Type.Literal("scout"),
			request: Type.String({ minLength: 1, description: "Exact read-only reconnaissance question." }),
			invocation_id: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]+$", description: "Stable idempotency key; duplicates return the existing run." }),
			repo: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Only when the workspace root is not a Git repository: the one nested repository to scout, as its path from the workspace root (for example `ringithub`)." })),
		}, { additionalProperties: false }),
		execute(_toolCallId, raw, signal, onUpdate, ctx) {
			const params = raw as RunFlowParams;
   const epoch=sessionEpoch;
   let scope:string;let selected:SessionRoots|undefined;
   try{const roots=sessionRootsFromEnv(),cwd=realpathSync(ctx.cwd||process.cwd());if(roots?.mode==='targeted'&&cwd!==roots.executionRoot)return Promise.resolve(failure('target-refused','flow_source_target_mismatch',false,false));const target=nestedTarget(roots,cwd,params.repo,deps.nestedRepositories);if('refusal' in target)return Promise.resolve(failure('target-refused',target.refusal,false,false));selected=target.binding;scope=selected?.targetId??roots?.targetId??cwd;}catch{return Promise.resolve(failure('target-refused','flow_source_target_unavailable',false,false));}
			const existing = runs.get(params.invocation_id);
			if (existing) {
				if (existing.request !== params.request || existing.scope!==scope) return Promise.resolve({ content: [{ type: "text", text: "Stale duplicate refused: invocation_id is already bound to different scout inputs; no budget charged." }], details: { status: "stale-duplicate", budgetCharged: false, executionStarted: false } });
				return existing.promise;
			}
			if (activeId) return Promise.resolve({ content: [{ type: "text", text: `Flow busy: ${activeId} is active; no budget charged.` }], details: { status: "busy", activeInvocationId: activeId, budgetCharged: false, executionStarted: false } });
			const controller = new AbortController();
			const forwardAbort = () => controller.abort(signal?.reason ?? "caller cancelled");
			if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
			activeId = params.invocation_id;
			const snapshotCleanup: { status: "not-created" | "removed" | "failed"; path?: string; error?: string } = { status: "not-created" };
			const promise = (async () => {
				let snapshotRoot: string | null = null;
				let budgetCharged = false;
				let executionStarted = false;
				let runId: string | null = null;
				try {
					const sessionDir = deps.sessionDir();
					if (!sessionDir) return failure("invalid-environment", "run_flow requires an active managed Hub session", false, false);
					// A named nested repository is the snapshot source; configuration still comes from the workspace root.
					const workspaceCwd = ctx.cwd || process.cwd(), sourceCwd = selected?.executionRoot ?? workspaceCwd;
     const sourceBinding=selected??sessionRootsFromEnv();if(sourceBinding?.mode==='targeted'&&realpathSync(sourceCwd)!==sourceBinding.executionRoot)throw Error('flow_source_target_mismatch');
					let config;
					try {
						config = deps.effectiveScoutConfig(selected ? workspaceCwd : sourceCwd);
						const allowedTools = new Set(["read", "grep", "find", "ls"]);
						if (!config.allowlisted || config.tools.length === 0 || config.tools.some(tool => !allowedTools.has(tool))) throw new Error("effective scout configuration is not allowlisted filesystem-read-only");
					} catch (error) { return failure("preflight-refused", error, false, false); }
					const revision = deps.worktreeRevision ?? worktreeRevision;
					const beforeRevision = revision(sourceCwd, []);
					runId = `hub-scout-${randomUUID()}`;
					const artifactDir = join(sessionDir, "artifacts", "flow-runs", runId); mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
					snapshotRoot = realpathSync(mkdtempSync(join(tmpdir(), "agent-fleet-scout-snapshot-")));
					const workspace = join(snapshotRoot, "workspace"), manifestPath = join(artifactDir, "snapshot-manifest.json");
					let manifest: IsolatedSnapshotManifest;
					const createSnapshot = () => (deps.createSnapshot ?? createIsolatedWorkingTreeSnapshot)(sourceCwd, workspace, manifestPath);
					try { manifest = selected ? withSessionRoots(selected, createSnapshot) : createSnapshot(); }
					catch (error) { return failure("snapshot-refused", error, false, false); }
					const snapshotBinding=sourceBinding?.mode==='targeted'?resolveSessionRoots(sourceBinding.workspaceRoot,{worktree:workspace}):undefined;
     let budget: HubFlowBudgetReservation;
					try { budget = await deps.reserveBudget(params, ctx, controller.signal); }
					catch (error) { return failure("budget-failed", error, false, false); }
					if (!budget.charged) return { content: [{ type: "text", text: budget.refusal ?? "Hub budget refused flow." }], details: { status: "budget-refused", budgetCharged: false, budgetOwner: "hub", executionStarted: false, parentAcceptance: { accepted: false, status: "not_accepted", assertionsProven: [] } } };
					budgetCharged = true;
					executionStarted = true;
					onUpdate?.({ content: [{ type: "text", text: "Running isolated read-only scout flow..." }], details: { status: "running", runId } });
					let result;
					try {
						const hubScout: HubScoutExecution = { noBranch: true, traceDirectory: artifactDir, signal: controller.signal, ...(deps.scoutAgent ? { scoutAgent: deps.scoutAgent } : {}) };
						const invoke=()=> (deps.execute ?? executeFlow)({ name: "scout", args: [params.request], allowDirty: true, dryRun: false, runId:runId! }, { cwd: workspace!, command: ["run_flow", "scout"], hubScout });
      result = await (snapshotBinding?withSessionRoots(snapshotBinding,invoke):invoke());
					} catch (error) {
						result = { accepted: false, status: "rejected" as const, exitCode: Number((error as any)?.exitCode ?? 1), reason: message(error), banner: "FLOW REJECTED" };
					}
					if(epoch!==sessionEpoch)return failure('stale-session','parent session changed',budgetCharged,executionStarted);
     if(sourceBinding)validateSessionRoots(sourceBinding);
     const afterRevision = revision(sourceCwd, []);
					const unchanged = beforeRevision === afterRevision;
					const runtimeResult = (deps.buildRuntimeResult ?? buildRuntimeResult)({
						task: { id: deps.taskId(), current: unchanged, beforeRevision, afterRevision },
						execution: { status: result.exitCode === 0 ? "completed" : "failed", exitCode: result.exitCode, dispatchId: runId },
						changes: { status: "unchanged", paths: [], attribution: "certain" }, requirements: [], deliverables: [], checks: [],
						evidenceRefs: [manifestPath, join(artifactDir, "trace.jsonl")],
					});
					const obligations = deps.processObligations();
					const details = { status: result.status, runId, invocationId: params.invocation_id, procedure: "scout", budgetCharged: true, budgetOwner: "hub", budgetOperation: "research", executionStarted: true, flowAcceptance: { accepted: result.accepted, status: result.status, reason: result.reason ?? null }, parentAcceptance: { accepted: false, status: "not_accepted", assertionsProven: [], obligations }, runtimeResult, effectiveConfiguration: config, snapshot: { ...(sourceBinding?{sourceTargetId:sourceBinding.targetId,workspaceRoot:sourceBinding.workspaceRoot,snapshotTargetId:snapshotBinding?.targetId,executionRoot:workspace}:{}), schema: manifest.schema, sourceRevision: manifest.sourceRevision, sourceStateHash: manifest.sourceStateHash, manifestPath, originalRevisionUnchanged: unchanged }, tracePath: join(artifactDir, "trace.jsonl") };
					const repository = selected ? relative(realpathSync(workspaceCwd), selected.executionRoot).split(sep).join("/") : undefined;
					if (repository) Object.assign(details.snapshot, { repository });
					return { content: [{ type: "text", text: `${result.banner}\n${repository ? `Scouted nested repository ${repository}; paths in this result are relative to it.\n` : ""}Flow acceptance is separate; parent task remains not accepted and no assertion was promoted.\nTrace: ${details.tracePath}` }], details };
				} catch (error) {
					return failure(executionStarted ? "result-failed" : "setup-failed", error, budgetCharged, executionStarted, runId ? { runId } : {});
				} finally {
					if (snapshotRoot) {
						try {
							if (deps.removeSnapshot) deps.removeSnapshot(snapshotRoot);
							else rmSync(snapshotRoot, { recursive: true, force: true });
							snapshotCleanup.status = "removed";
						} catch (error) {
							snapshotCleanup.status = "failed"; snapshotCleanup.path = snapshotRoot; snapshotCleanup.error = message(error);
						}
					}
				}
			})().then(result => ({
				...result,
				content: snapshotCleanup.status === "failed" ? [...result.content, { type: "text", text: `Temporary scout snapshot cleanup failed; retained at ${snapshotCleanup.path}: ${snapshotCleanup.error}` }] : result.content,
				details: { ...result.details, snapshotCleanup },
			}));
			runs.set(params.invocation_id, { promise, controller, request: params.request,scope });
			const cleanup = () => { if (epoch===sessionEpoch&&activeId === params.invocation_id) activeId = null; signal?.removeEventListener("abort", forwardAbort); };
			void promise.then(cleanup, cleanup);
			return promise;
		},
	});
}
