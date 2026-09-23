import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeFlow, type HubScoutExecution } from "../../../agent-fleet/scripts/flow.ts";
import { createIsolatedWorkingTreeSnapshot, type IsolatedSnapshotManifest } from "../../../agent-fleet/scripts/workflows/lib/isolated-snapshot.ts";
import type { ScoutWorkflowDeps } from "../../../agent-fleet/scripts/workflows/wf-scout.ts";
import { worktreeRevision } from "../scope-gate.js";
import { buildRuntimeResult } from "../acceptance.ts";

export interface RunFlowParams { procedure: "scout"; request: string; invocation_id: string }
export interface HubFlowBudgetReservation { charged: boolean; operation: "research"; owner: "hub"; refusal?: string }
export interface RunFlowDeps {
	sessionDir(): string | null;
	taskId(): string;
	reserveBudget(params: RunFlowParams, ctx: ExtensionContext, signal?: AbortSignal): Promise<HubFlowBudgetReservation>;
	processObligations(): unknown;
	effectiveScoutConfig(cwd: string): { model: string; profile: string | null; tools: string[]; fallback: string | null; allowlisted: boolean };
	execute?: typeof executeFlow;
	createSnapshot?: typeof createIsolatedWorkingTreeSnapshot;
	scoutAgent?: ScoutWorkflowDeps["agent"];
	worktreeRevision?: typeof worktreeRevision;
	buildRuntimeResult?: typeof buildRuntimeResult;
}

interface StoredRun { promise: Promise<any>; controller: AbortController; request: string }

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
	pi.on("session_shutdown", () => { for (const run of runs.values()) run.controller.abort("session shutdown"); });
	pi.registerTool({
		name: "run_flow", label: "Run Flow", description: "Run the read-only scout workflow in an isolated no-branch snapshot. Initial T13 surface; writable flows are unavailable.",
		parameters: Type.Object({
			procedure: Type.Literal("scout"),
			request: Type.String({ minLength: 1, description: "Exact read-only reconnaissance question." }),
			invocation_id: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]+$", description: "Stable idempotency key; duplicates return the existing run." }),
		}, { additionalProperties: false }),
		execute(_toolCallId, raw, signal, onUpdate, ctx) {
			const params = raw as RunFlowParams;
			const existing = runs.get(params.invocation_id);
			if (existing) {
				if (existing.request !== params.request) return Promise.resolve({ content: [{ type: "text", text: "Stale duplicate refused: invocation_id is already bound to different scout inputs; no budget charged." }], details: { status: "stale-duplicate", budgetCharged: false, executionStarted: false } });
				return existing.promise;
			}
			if (activeId) return Promise.resolve({ content: [{ type: "text", text: `Flow busy: ${activeId} is active; no budget charged.` }], details: { status: "busy", activeInvocationId: activeId, budgetCharged: false, executionStarted: false } });
			const controller = new AbortController();
			const forwardAbort = () => controller.abort(signal?.reason ?? "caller cancelled");
			if (signal?.aborted) forwardAbort(); else signal?.addEventListener("abort", forwardAbort, { once: true });
			activeId = params.invocation_id;
			const promise = (async () => {
				let snapshotRoot: string | null = null;
				let budgetCharged = false;
				let executionStarted = false;
				let runId: string | null = null;
				try {
					const sessionDir = deps.sessionDir();
					if (!sessionDir) return failure("invalid-environment", "run_flow requires an active managed Hub session", false, false);
					const sourceCwd = ctx.cwd || process.cwd();
					let config;
					try {
						config = deps.effectiveScoutConfig(sourceCwd);
						const allowedTools = new Set(["read", "grep", "find", "ls"]);
						if (!config.allowlisted || config.tools.length === 0 || config.tools.some(tool => !allowedTools.has(tool))) throw new Error("effective scout configuration is not allowlisted filesystem-read-only");
					} catch (error) { return failure("preflight-refused", error, false, false); }
					const revision = deps.worktreeRevision ?? worktreeRevision;
					const beforeRevision = revision(sourceCwd, []);
					runId = `hub-scout-${randomUUID()}`;
					const artifactDir = join(sessionDir, "artifacts", "flow-runs", runId); mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
					snapshotRoot = mkdtempSync(join(tmpdir(), "agent-fleet-scout-snapshot-"));
					const workspace = join(snapshotRoot, "workspace"), manifestPath = join(artifactDir, "snapshot-manifest.json");
					let manifest: IsolatedSnapshotManifest;
					try { manifest = (deps.createSnapshot ?? createIsolatedWorkingTreeSnapshot)(sourceCwd, workspace, manifestPath); }
					catch (error) { return failure("snapshot-refused", error, false, false); }
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
						result = await (deps.execute ?? executeFlow)({ name: "scout", args: [params.request], allowDirty: true, dryRun: false, runId }, { cwd: workspace, command: ["run_flow", "scout"], hubScout });
					} catch (error) {
						result = { accepted: false, status: "rejected" as const, exitCode: Number((error as any)?.exitCode ?? 1), reason: message(error), banner: "FLOW REJECTED" };
					}
					const afterRevision = revision(sourceCwd, []);
					const unchanged = beforeRevision === afterRevision;
					const runtimeResult = (deps.buildRuntimeResult ?? buildRuntimeResult)({
						task: { id: deps.taskId(), current: unchanged, beforeRevision, afterRevision },
						execution: { status: result.exitCode === 0 ? "completed" : "failed", exitCode: result.exitCode, dispatchId: runId },
						changes: { status: "unchanged", paths: [], attribution: "certain" }, requirements: [], deliverables: [], checks: [],
						evidenceRefs: [manifestPath, join(artifactDir, "trace.jsonl")],
					});
					const obligations = deps.processObligations();
					const details = { status: result.status, runId, invocationId: params.invocation_id, procedure: "scout", budgetCharged: true, budgetOwner: "hub", budgetOperation: "research", executionStarted: true, flowAcceptance: { accepted: result.accepted, status: result.status, reason: result.reason ?? null }, parentAcceptance: { accepted: false, status: "not_accepted", assertionsProven: [], obligations }, runtimeResult, effectiveConfiguration: config, snapshot: { schema: manifest.schema, sourceRevision: manifest.sourceRevision, sourceStateHash: manifest.sourceStateHash, manifestPath, originalRevisionUnchanged: unchanged }, tracePath: join(artifactDir, "trace.jsonl") };
					return { content: [{ type: "text", text: `${result.banner}\nFlow acceptance is separate; parent task remains not accepted and no assertion was promoted.\nTrace: ${details.tracePath}` }], details };
				} catch (error) {
					return failure(executionStarted ? "result-failed" : "setup-failed", error, budgetCharged, executionStarted, runId ? { runId } : {});
				} finally {
					if (snapshotRoot) { try { rmSync(snapshotRoot, { recursive: true, force: true }); } catch {} }
				}
			})();
			runs.set(params.invocation_id, { promise, controller, request: params.request });
			const cleanup = () => { if (activeId === params.invocation_id) activeId = null; signal?.removeEventListener("abort", forwardAbort); };
			void promise.then(cleanup, cleanup);
			return promise;
		},
	});
}
