import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { worktreeRevision } from "./scope-gate.js";
import type { DispatchExecutorDeps } from "./tools/dispatch-execution.ts";
import type { ToolExecutor, DispatchAgentParams, SpawnResearchParams } from "./tools/context.ts";

interface Failure { dispatchId: string; reason: string; evidencePath?: string; }
interface Ticket { allowed: boolean; key: string; generation: object; id: object; failure?: Failure; stopParent?: boolean; }

export function createNoProgressGuard() {
 let generation = {};
 const pending = new Map<string, object>();
 const refusals = new Map<string, number>();
 const failures = new Map<string, { revision: string; failure: Failure; authorized: boolean }>();
 return {
  taskToken: () => generation,
  begin(key: string, revision: string): Ticket {
   const old = failures.get(key), id = {};
   if (pending.has(key) || (old?.revision === revision && !old.authorized)) {
    const count = (refusals.get(key) ?? 0) + 1; refusals.set(key, count);
    return { allowed: false, key, generation, id, failure: old?.failure, stopParent: count >= 2 };
   }
   failures.delete(key); refusals.delete(key); pending.set(key, id);
   return { allowed: true, key, generation, id };
  },
  finish(ticket: Ticket, revision: string, failure?: Failure) {
   if (!ticket.allowed || ticket.generation !== generation || pending.get(ticket.key) !== ticket.id) return;
   pending.delete(ticket.key);
   if (failure) failures.set(ticket.key, { revision, failure, authorized: false });
  },
  authorize(dispatchId: string): boolean {
   for (const entry of failures.values()) if (entry.failure.dispatchId === dispatchId && !entry.authorized) { entry.authorized = true; return true; }
   return false;
  },
  reset() { generation = {}; pending.clear(); failures.clear(); refusals.clear(); },
 };
}
export type NoProgressGuard = ReturnType<typeof createNoProgressGuard>;

/** Wording is intentionally absent: prose cannot manufacture new execution inputs. */
export function withNoProgress<P extends DispatchAgentParams | SpawnResearchParams>(d: Pick<DispatchExecutorDeps, "noProgress" | "artifacts">, kind: "dispatch" | "research", execute: ToolExecutor<P>): ToolExecutor<P> {
 return async (id, params, signal, onUpdate, ctx) => {
  const cwd = ctx.cwd || process.cwd();
  const scope = ("scope" in params ? params.scope ?? [] : []).map(path => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).sort();
  const actor = ("agent" in params ? params.agent : params.persona ?? "research").toLowerCase();
  let inputs: { path: string }[];
  try { inputs = d.artifacts.loadInputArtifacts(params.artifacts, ctx); }
  catch { return execute(id, params, signal, onUpdate, ctx); } // Existing artifact preflight reports the exact path failure.
  const revision = () => JSON.stringify([worktreeRevision(cwd, scope), inputs.map(input => {
   try { return [input.path, createHash("sha256").update(readFileSync(input.path)).digest("hex")]; }
   catch { return [input.path, "unreadable"]; }
  }).sort(([a], [b]) => a.localeCompare(b))]);
  const contract = "agent" in params ? [params.scope_mode ?? "existing", [...(params.deliverables ?? [])].sort()] : null;
  const key = JSON.stringify([kind, resolve(cwd), actor, scope, inputs.map(input => input.path).sort(), contract]);
  const ticket = d.noProgress.begin(key, revision());
  if (!ticket.allowed) {
   if (ticket.stopParent) ctx.abort?.();
   const failure = ticket.failure;
   const message = failure
    ? `No-progress refusal: unchanged inputs after ${failure.reason}. Previous attempt: ${failure.dispatchId}${failure.evidencePath ? ` (${failure.evidencePath})` : ""}. Rewording, another turn or renewed budget is not new evidence. Supply corrected scope/inputs or actual file changes. The human may authorize ONE retry with /af-retry ${failure.dispatchId}; prose is not authorization.`
    : "No-progress stop: an operation with the same actor/scope is already in flight. Wait for its result; do not duplicate it.";
   return { content: [{ type: "text", text: message }], details: { status: "no_progress_refused", reason: "unchanged_inputs", stopParent: ticket.stopParent === true, exitCode: 1, previousDispatchId: failure?.dispatchId, evidencePath: failure?.evidencePath } };
  }
  let failure: Failure | undefined;
  try {
   const result = await execute(id, params, signal, onUpdate, ctx);
   const details = result.details as any;
   if (details && ((details.exitCode !== 0 && (details.status === "error" || details.failurePath || details.evidencePath)) || details.acceptanceStatus === "deliverable_failed")) {
    failure = { dispatchId: details.dispatchId ?? randomUUID(), evidencePath: details.evidencePath ?? details.failurePath ?? undefined, reason: details.diagnostics?.reason ?? details.status ?? "execution_failure" };
   }
   return result;
  } catch (error) { failure = { dispatchId: randomUUID(), reason: "execution_exception" }; throw error; }
  finally { d.noProgress.finish(ticket, revision(), failure); }
 };
}
