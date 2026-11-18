// Authoritative, task-bound persistence for the acceptance assertion ledger.
//
// The live ledger is an in-memory array owned by index.ts. A new extension
// instance (reload, resume) used to start empty while the task identity was
// restored, so dispatches lost their sourced requirements. Each committed
// mutation now appends a versioned snapshot to the Pi session journal; restore
// reads only the latest snapshot on the current branch and accepts it only for
// the same task. `assertions.json` stays a write mirror, never a restore source.
//
// A restored status/evidence binding is a historical record, not a new runtime
// receipt: freshness, revision and capture checks still apply downstream.
import { validateAssertionBatch } from "../assertion-ledger.js";
import type { Assertion, AssertionStatus } from "./assertions-artifacts.ts";

export const ASSERTION_LEDGER_ENTRY = "agent-hub-assertion-ledger";
export const ASSERTION_LEDGER_SCHEMA = "agent-fleet.assertion-ledger/v1";

export interface AssertionLedgerSnapshot { schema: typeof ASSERTION_LEDGER_SCHEMA; taskId: string; assertions: Assertion[] }
export type AssertionRestoreStatus = "restored" | "none" | "foreign_task" | "corrupt_snapshot";
export type AssertionBootstrapStatus = "bootstrapped" | "none" | "legacy_ambiguous";
export interface AssertionLedgerRestore<S extends string> { status: S; assertions: Assertion[]; diagnostic?: string }

const STATUSES: readonly AssertionStatus[] = ["open", "proven", "unproven", "failed"];
const NEXT_STEP = "Re-declare the same sourced assertions with set_assertions for this same task; do not open a new task or reset.";
const OPTIONAL_STRINGS = ["reference", "testCommand", "compilerCommand", "evidence", "evidenceTaskId", "evidenceRevision"] as const;

function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

function cloneAssertion(a: Assertion): Assertion {
	const out: Assertion = { id: a.id, tag: a.tag, text: a.text, source: a.source, status: a.status };
	for (const key of OPTIONAL_STRINGS) if (a[key] !== undefined) out[key] = a[key];
	if (a.criticalConditions) out.criticalConditions = [...a.criticalConditions];
	return out;
}

/** The journal record for one committed ledger state. A defensive copy. */
export function assertionLedgerSnapshot(taskId: string, assertions: readonly Assertion[]): AssertionLedgerSnapshot {
	if (!nonEmpty(taskId)) throw new Error("assertion ledger snapshot requires a task identity");
	return { schema: ASSERTION_LEDGER_SCHEMA, taskId, assertions: assertions.map(cloneAssertion) };
}

function validAssertion(value: any): value is Assertion {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	if (!["id", "tag", "text", "source"].every(key => typeof value[key] === "string") || !value.id) return false;
	if (!STATUSES.includes(value.status)) return false;
	if (OPTIONAL_STRINGS.some(key => value[key] !== undefined && typeof value[key] !== "string")) return false;
	if (value.criticalConditions !== undefined && (!Array.isArray(value.criticalConditions) || value.criticalConditions.some((c: unknown) => typeof c !== "string"))) return false;
	return true;
}

function parseSnapshot(data: any): AssertionLedgerSnapshot | null {
	if (!data || data.schema !== ASSERTION_LEDGER_SCHEMA || !nonEmpty(data.taskId) || !Array.isArray(data.assertions)) return null;
	if (!data.assertions.every(validAssertion)) return null;
	const ids = data.assertions.map((a: Assertion) => a.id.toLowerCase());
	if (new Set(ids).size !== ids.length) return null;
	return { schema: ASSERTION_LEDGER_SCHEMA, taskId: data.taskId, assertions: data.assertions.map(cloneAssertion) };
}

const isLedgerEntry = (row: any) => row?.type === "custom" && row.customType === ASSERTION_LEDGER_ENTRY;

/** Restore from the latest ledger snapshot on `branch`. Never falls back to an older one. */
export function restoreAssertionLedger(branch: readonly unknown[], taskId: string): AssertionLedgerRestore<AssertionRestoreStatus> {
	let latest: any; let found = false;
	for (let i = branch.length - 1; i >= 0; i--) if (isLedgerEntry(branch[i])) { latest = (branch[i] as any).data; found = true; break; }
	if (!found) return { status: "none", assertions: [] };
	const snapshot = parseSnapshot(latest);
	if (!snapshot) return { status: "corrupt_snapshot", assertions: [], diagnostic: `The latest saved assertion ledger is unreadable or has an unknown schema; it was not restored and no older ledger is used. ${NEXT_STEP}` };
	if (snapshot.taskId !== taskId) return { status: "foreign_task", assertions: [], diagnostic: `The latest saved assertion ledger belongs to a different task than the restored task identity; it was not restored. ${NEXT_STEP}` };
	return { status: "restored", assertions: snapshot.assertions };
}

// `seq` orders calls even inside one assistant message; `index` is the journal entry.
interface Transaction { id: string; name: string; args: any; result?: { details: any; isError: unknown }; index: number; seq: number }

/**
 * One-time migration for sessions written before ledger snapshots existed.
 * Reads only typed assistant toolCall / toolResult pairs on the current branch:
 * the last successful set_assertions after the last committed new_task becomes
 * open declarations without proof. Ambiguity fails closed with a diagnostic.
 */
export function bootstrapLegacyAssertionLedger(branch: readonly unknown[]): AssertionLedgerRestore<AssertionBootstrapStatus> {
	const calls = new Map<string, Transaction>(); const order: Transaction[] = []; const orphanResults: Array<{ name: string; index: number }> = [];
	branch.forEach((row: any, index) => {
		const message = row?.type === "message" ? row.message : null;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part?.type === "toolCall" && nonEmpty(part.id) && nonEmpty(part.name)) {
				const tx: Transaction = { id: part.id, name: part.name, args: part.arguments, index, seq: order.length };
				calls.set(part.id, tx); order.push(tx);
			}
		} else if (message?.role === "toolResult" && nonEmpty(message.toolCallId)) {
			const tx = calls.get(message.toolCallId);
			if (tx && !tx.result && tx.name === message.toolName) tx.result = { details: message.details, isError: message.isError };
			else orphanResults.push({ name: String(message.toolName ?? ""), index });
		}
	});
	const relevant = new Set(["set_assertions", "update_assertion", "set_task_tier"]);
	const committedNewTask = (tx: Transaction) => tx.name === "set_task_tier" && tx.result?.details?.status === "ok" && tx.result.details.newTask === true;
	let boundary = -1, boundarySeq = -1;
	for (const tx of order) if (committedNewTask(tx)) { boundary = tx.index; boundarySeq = tx.seq; }
	const ambiguous = (what: string): AssertionLedgerRestore<AssertionBootstrapStatus> => ({ status: "legacy_ambiguous", assertions: [],
		diagnostic: `The assertion ledger could not be migrated from this older session: ${what}. No declaration or proof was restored. ${NEXT_STEP}` });
	if (orphanResults.some(r => r.index > boundary && relevant.has(r.name))) return ambiguous("a ledger tool result has no matching tool call");
	const after = order.filter(tx => tx.seq > boundarySeq && relevant.has(tx.name));
	const unpaired = after.find(tx => !tx.result && (tx.name !== "set_task_tier" || tx.args?.new_task === true));
	if (unpaired) return ambiguous(`an unpaired ${unpaired.name} call leaves its outcome unknown`);
	let base: Assertion[] | null = null; let baseSeq = -1;
	for (const tx of after) {
		if (tx.name !== "set_assertions" || tx.result!.isError === true) continue;
		const details = tx.result!.details;
		if (!details || typeof details !== "object" || details.status !== undefined || typeof details.count !== "number") continue;
		const verdict = validateAssertionBatch(tx.args?.assertions);
		if (!verdict.ok || verdict.assertions.length !== details.count) return ambiguous("a successful set_assertions result does not match its validated arguments");
		base = verdict.assertions.map((a: any) => ({ ...a, status: "open" as AssertionStatus })); baseSeq = tx.seq;
	}
	if (!base) return { status: "none", assertions: [] };
	const reopened = new Set<string>(); const kept = new Set<string>();
	for (const tx of after) {
		if (tx.name !== "update_assertion" || tx.seq < baseSeq) continue;
		const details = tx.result!.details;
		if (tx.result!.isError === true || !details || !nonEmpty(details.id) || !STATUSES.includes(details.status) || details.status === "open") continue;
		const target = base.find(a => a.id.toLowerCase() === String(details.id).toLowerCase());
		if (!target) return ambiguous(`a committed update names "${details.id}", which the migrated declarations do not contain`);
		// Legacy results carry no task/revision proof: never migrate proof, never hide a failure.
		if (details.status === "proven") { target.status = "open"; reopened.add(target.id); kept.delete(target.id); }
		else { target.status = details.status; kept.add(target.id); reopened.delete(target.id); }
	}
	const notes = [
		reopened.size ? `${[...reopened].join(", ")} had legacy proven updates without task/revision binding and are open again (must be re-proven)` : "",
		kept.size ? `${[...kept].join(", ")} keep their legacy failed/unproven status without an evidence binding` : "",
	].filter(Boolean);
	return { status: "bootstrapped", assertions: base,
		diagnostic: `Assertion declarations were migrated from this older session's typed set_assertions result as open requirements; no proof was migrated.${notes.length ? ` ${notes.join("; ")}.` : ""}` };
}
