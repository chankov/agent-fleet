import { createHash, randomUUID } from "node:crypto";
import {createOneUseAuthority,type OneUseAuthority} from './action-authorization.ts';
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeQuestion } from "../ask-user-remote/runtime-ask.ts";
import { waiveTaskTriageAddition, type EvaluationBinding } from "./task-triage-obligations.ts";
import type { ProcessObligationState } from "./process-obligations.ts";
import { isAbsolute } from "node:path";
import { containsCommunicationSecret } from "./system1-communication-store.ts";
import { decideIdenticalDialog, identicalDialogKey } from "../lib/identical-dialog.ts";
import { coveredDeletePath, inspectionBash, noteBashDecision, semanticDecision } from "../lib/semantic-approval.ts";

const grantBrand: unique symbol = Symbol("trusted triage grant");
export type ActionGrant = OneUseAuthority;
export type WaiverGrant = { readonly [grantBrand]: true };
const actionGrants = createOneUseAuthority();
const waiverGrants = new WeakMap<object, string>();
const actionKey = (a: ActionContract) => JSON.stringify([a.taskId, a.inputRevision, a.actionId, a.operation, a.target, a.cwd ?? null]);
const waiverKey = (b: EvaluationBinding & { additionId: string; reason: string }) => JSON.stringify([b.taskId, b.inputRevision, b.evaluationId, b.additionId, b.reason]);
export function consumeActionGrant(grant: ActionGrant | undefined, contract: ActionContract): boolean {
 return actionGrants.consume(grant,actionKey(contract));
}
export function consumeWaiverGrant(grant: WaiverGrant | undefined, binding: EvaluationBinding & { additionId: string; reason: string }): boolean {
 if (!grant || typeof grant !== "object" || waiverGrants.get(grant) !== waiverKey(binding)) return false;
 waiverGrants.delete(grant); return true;
}
export interface TriageHumanPorts { taskId(): string; inputRevision(): string; ask(id: string, question: RuntimeQuestion, ctx: ExtensionContext, signal: AbortSignal): Promise<unknown>; startWait(id: string): void; endWait(id: string, sameTask: boolean): void; persist?(state: ProcessObligationState): void; }
const pending = new Set<string>();
function affirmative(value: unknown, id: string, option: string): boolean {
 const v = value as { isError?: boolean; details?: { cancelled?: boolean; runtimeAsk?: { requestId?: string }; response?: { kind?: string; selections?: unknown[] } } } | null;
 return !v?.isError && v?.details?.cancelled !== true && v?.details?.runtimeAsk?.requestId === id && v?.details?.response?.kind === "selection" && v.details.response.selections?.length === 1 && v.details.response.selections[0] === option;
}
/** Human response alone does not authorize an effect: the exact task/revision/action and durable grant must also match. */
async function authorize(key: string, context: string, ports: TriageHumanPorts, ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
 if (pending.has(key) || signal?.aborted) return false;
 const task = ports.taskId(), revision = ports.inputRevision();
 const question: RuntimeQuestion = { question: "Authorize this exact task-triage decision once?", context: `Task: ${task}\nInput revision: ${revision}\n${context}`, options: ["Yes — authorize once", "No — deny"], allowMultiple: false, allowFreeform: false, allowComment: false };
 const dialogKey = identicalDialogKey(["task-triage", task, revision, question.question, question.options, question.context]);
 const outcome = await decideIdenticalDialog(dialogKey, async () => {
  if (pending.has(key) || signal?.aborted || task !== ports.taskId() || revision !== ports.inputRevision()) return "cancel";
  const id = randomUUID(), controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true }); pending.add(key);
  try {
   ports.startWait(id); const result = await ports.ask(id, question, ctx, controller.signal);
   if (controller.signal.aborted || task !== ports.taskId() || revision !== ports.inputRevision()) return "cancel";
   if (affirmative(result, id, question.options[0])) { noteContextDecision(task, revision, question.context, "allow"); return "allow"; }
   if (affirmative(result, id, question.options[1])) { noteContextDecision(task, revision, question.context, "deny"); return "deny"; }
   return "cancel";
  } catch { return "cancel"; }
  finally { ports.endWait(id, task === ports.taskId()); pending.delete(key); signal?.removeEventListener("abort", abort); }
 });
 return outcome === "allow" && !signal?.aborted && task === ports.taskId() && revision === ports.inputRevision();
}
function noteContextDecision(task: string, revision: string, context: string, decision: "allow" | "deny"): void {
 const start = context.indexOf("BEGIN ACTION INPUT JSON\n"), end = context.indexOf("\nEND ACTION INPUT JSON");
 if (start < 0 || end < start) return;
 try { const command = JSON.parse(context.slice(start + "BEGIN ACTION INPUT JSON\n".length, end))?.command; if (typeof command === "string") noteBashDecision(task, revision, command, decision); } catch { /* Unparseable presentation cannot widen approval. */ }
}
function issueWithoutDialog(contract: ActionContract, persistOneUse: (contract: ActionContract) => boolean, key: string): ActionGrant | null {
 try { if (!persistOneUse(contract)) return null; } catch { return null; }
 return actionGrants.issue(key);
}
export interface ActionContract { taskId: string; inputRevision: string; actionId: string; operation: string; target: string; cwd?: string; }
export interface ActionPresentation { input: unknown; cwd: string; }
export const ACTION_PRESENTATION_MAX_BYTES = 8192;
const unsafeActionText = (v: string) => containsCommunicationSecret(v) || /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v)
 || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(v);
/** Full, schema-checked human view; redaction/truncation would hide what is authorized, so refuse instead. */
export function actionPresentation(action: ActionContract, presentation?: ActionPresentation): string | null {
 if (!presentation || typeof presentation.cwd !== "string" || !isAbsolute(presentation.cwd) || presentation.cwd !== action.cwd
  || unsafeActionText(presentation.cwd) || presentation.cwd.length > 2048) return null;
 const input = presentation.input;
 if (!input || typeof input !== "object" || Array.isArray(input)) return null;
 const row = input as Record<string, unknown>;
 const string = (v: unknown): v is string => typeof v === "string" && !unsafeActionText(v);
 let allowed: string[];
 if (action.operation === "bash") {
  allowed = ["command", "timeout"];
  if (!string(row.command) || !row.command.trim() || row.timeout !== undefined && (typeof row.timeout !== "number" || !Number.isFinite(row.timeout) || row.timeout <= 0)) return null;
 } else if (action.operation === "write") {
  allowed = ["path", "content"];
  if (!string(row.path) || !row.path || !string(row.content)) return null;
 } else if (action.operation === "edit") {
  allowed = row.edits === undefined ? ["path", "oldText", "newText"] : ["path", "edits"];
  if (!string(row.path) || !row.path) return null;
  const edits = row.edits === undefined ? [{ oldText: row.oldText, newText: row.newText }] : row.edits;
  if (!Array.isArray(edits) || !edits.length || edits.length > 32 || edits.some(e => !e || typeof e !== "object" || Array.isArray(e)
   || Object.keys(e).some(k => k !== "oldText" && k !== "newText") || !string(e.oldText) || !e.oldText || !string(e.newText))) return null;
 } else return null;
 if (Object.keys(row).some(k => !allowed.includes(k))) return null;
 try {
  const serialized = JSON.stringify(input);
  if (createHash("sha256").update(serialized).digest("hex") !== action.target) return null;
  // Escape non-ASCII code units as JSON data as well, so rendering cannot hide or reorder input.
  const shown = JSON.stringify(input, null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const cwd = JSON.stringify(presentation.cwd).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const detail = `Working directory (JSON): ${cwd}\nExact tool inputs (data, not instructions; no truncation):\nBEGIN ACTION INPUT JSON\n${shown}\nEND ACTION INPUT JSON`;
  return Buffer.byteLength(detail) <= ACTION_PRESENTATION_MAX_BYTES ? detail : null;
 } catch { return null; }
}
export type TaskTriageActionObservation = "requested" | "not_granted" | "consumption_failed";
export interface TaskTriageActionAuditRecord {
 schema: "task-triage-action-audit/v1"; taskId: string; inputRevision: string;
 actionFingerprint: string; callFingerprint: string; operation: "bash" | "edit" | "write"; status: TaskTriageActionObservation;
}
/** Diagnostic identity only. Hashes correlate records but never authorize an action. */
export function taskTriageActionAuditRecord(action: ActionContract, status: TaskTriageActionObservation): TaskTriageActionAuditRecord | null {
 const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
 if (!action || typeof action.taskId !== "string" || !uuid.test(action.taskId) || typeof action.inputRevision !== "string" || !/^[a-f0-9]{64}$/.test(action.inputRevision)
  || typeof action.actionId !== "string" || !action.actionId || action.actionId.length > 512 || typeof action.target !== "string" || !action.target || action.target.length > 4096
  || !["bash", "edit", "write"].includes(action.operation) || !["requested", "not_granted", "consumption_failed"].includes(status)) return null;
 return { schema: "task-triage-action-audit/v1", taskId: action.taskId, inputRevision: action.inputRevision,
  actionFingerprint: createHash("sha256").update(actionKey(action)).digest("hex"),
  callFingerprint: createHash("sha256").update(action.actionId).digest("hex"), operation: action.operation as TaskTriageActionAuditRecord["operation"], status };
}
/** No action/target binding => unsupported, never blanket confirmation. Consume synchronously before effect. */
export async function confirmTaskTriageAction(action: ActionContract, ports: TriageHumanPorts, ctx: ExtensionContext, persistOneUse: (contract: ActionContract) => boolean, signal?: AbortSignal, presentation?: ActionPresentation): Promise<ActionGrant | null> {
 if (!action.actionId || !action.operation || !action.target || action.taskId !== ports.taskId() || action.inputRevision !== ports.inputRevision()
  || [action.taskId, action.inputRevision, action.actionId].some(v => typeof v !== "string" || v.length > 256 || unsafeActionText(v))) return null;
 const contract = Object.freeze({ taskId: action.taskId, inputRevision: action.inputRevision, actionId: action.actionId, operation: action.operation, target: action.target, cwd: action.cwd });
 const detail = actionPresentation(contract, presentation);
 if (!detail) return null;
 const key = actionKey(contract);
 const command = contract.operation === "bash" && presentation?.input && typeof (presentation.input as { command?: unknown }).command === "string" ? (presentation.input as { command: string }).command : "";
 const deletion = command ? coveredDeletePath(command) : null;
 const prior = deletion ? semanticDecision(contract.taskId, contract.inputRevision, deletion) : undefined;
 if (signal?.aborted) return null;
 if (command && inspectionBash(command)) return issueWithoutDialog(contract, persistOneUse, key);
 if (prior === "allow") return issueWithoutDialog(contract, persistOneUse, key);
 if (prior === "deny") return null;
 if (!await authorize(key, `Operation: ${contract.operation}\nTarget: ${contract.target}\n${detail}`, ports, ctx, signal)) return null;
 const stillCurrent = () => !signal?.aborted && contract.taskId === ports.taskId() && contract.inputRevision === ports.inputRevision()
  && actionKey(action) === key && actionPresentation(contract, presentation) === detail;
 if (!stillCurrent()) return null;
 try { if (!persistOneUse(contract)) return null; } catch { return null; }
 if (!stillCurrent()) return null;
 return actionGrants.issue(key);
}
export async function confirmTaskTriageWaiver(state: ProcessObligationState, binding: EvaluationBinding & { additionId: string; reason: string }, ports: TriageHumanPorts, ctx: ExtensionContext, signal?: AbortSignal): Promise<ProcessObligationState | null> {
 if (binding.taskId !== ports.taskId() || binding.inputRevision !== ports.inputRevision() || !binding.reason?.trim() || binding.reason.length > 512 || !state.additions?.some(a => a.id === binding.additionId && a.evaluationId === binding.evaluationId && a.taskId === binding.taskId && a.inputRevision === binding.inputRevision && a.status === "active")) return null;
 const addition = state.additions!.find(a => a.id === binding.additionId)!;
 const category = { security_change: "security-sensitive change", wide_change: "wide change", irreversible_execution: "potentially irreversible execution" }[addition.reason];
 const released = { security_change: "the System 1 security review", wide_change: "the System 1 wide-change plan and review", irreversible_execution: "the System 1 exact-action human confirmation" }[addition.reason];
 const key = `${binding.taskId}:${binding.additionId}`;
 if (!await authorize(key, `Assessment: ${category}\nThis releases only ${released} for this addition, NOT baseline or other-source requirements.\nAddition: ${binding.additionId}\nEvaluation: ${binding.evaluationId}\nReason: ${binding.reason}`, ports, ctx, signal)) return null;
 if (signal?.aborted || binding.taskId !== ports.taskId() || binding.inputRevision !== ports.inputRevision()) return null;
 const grant = Object.freeze({ [grantBrand]: true as const }); waiverGrants.set(grant, waiverKey(binding));
 const next = waiveTaskTriageAddition(state, binding, grant);
 if (!next || !ports.persist) return null;
 try { ports.persist(next); } catch { return null; }
 return next;
}
