import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { AcceptanceRequirement, VerificationCheckInput } from "./acceptance.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export interface ReceiptCapture {
 taskId: string; generation: string; sessionDir: string; scope: string[]; declarationHash: string;
 epoch: number; captureId: string;
}
export interface RuntimeReceipt extends ReceiptCapture {
 originDispatchId: string; backend: "native"; capturedAt: number;
 check: VerificationCheckInput; evidenceHash: string;
}
export interface RuntimeReceiptState { generation: string; epoch: number; pending: string[]; records: RuntimeReceipt[]; }

/** Journal metadata only; there is deliberately no artifact/log import API. */
export function normalizeRuntimeReceipts(value: unknown): RuntimeReceiptState | undefined {
 if (value === undefined) return undefined;
 const row = value as RuntimeReceiptState;
 if (!row || typeof row.generation !== "string" || !row.generation || !Number.isSafeInteger(row.epoch) || row.epoch < 0 || !Array.isArray(row.pending) || row.pending.length > 64 || !row.pending.every(id => typeof id === "string" && !!id) || !Array.isArray(row.records) || row.records.length > 64 || Buffer.byteLength(JSON.stringify(row)) > 256 * 1024) throw Error("Invalid runtime receipt journal; dependent effects are blocked.");
 for (const r of row.records) {
  if (!r || r.generation !== row.generation || typeof r.taskId !== "string" || !r.taskId || typeof r.captureId !== "string" || !r.captureId || typeof r.sessionDir !== "string" || !isAbsolute(r.sessionDir) || !Array.isArray(r.scope) || !r.scope.every(s => typeof s === "string") || !hex(r.declarationHash) || r.epoch !== row.epoch || r.backend !== "native" || typeof r.originDispatchId !== "string" || !r.originDispatchId || !Number.isSafeInteger(r.capturedAt) || r.capturedAt <= 0 || !hex(r.evidenceHash) || !["test", "code-grep", "compilation"].includes(r.check?.kind ?? "") || r.check?.producer !== "runtime" || r.check.taskId !== r.taskId || r.check.exitCode !== 0 || !hex(r.check.inspectedRevision) || !Array.isArray(r.check.command) || r.check.command.length !== 1 || typeof r.check.command[0] !== "string" || !r.check.command[0] || typeof r.check.evidenceRef !== "string" || !Array.isArray(r.check.requirementIds) || !Array.isArray(r.check.coverage)) throw Error("Invalid runtime receipt anchor; dependent effects are blocked.");
 }
 return structuredClone(row);
}
export function receiptDeclarationHash(requirements: AcceptanceRequirement[], scope: string[], acceptedInput?: string, artifacts: { path: string }[] = []): string {
 return hash(JSON.stringify({ acceptedInput, scope, artifacts: artifacts.map(a => ({ path: a.path, hash: hash(readFileSync(a.path)) })), requirements: requirements.map(r => ({ id:r.id, tag:r.tag, text:r.text, source:r.source, reference:r.reference, criticalConditions:r.criticalConditions ?? [], testCommand:r.testCommand, compilerCommand:r.compilerCommand })) }));
}
export function beginReceiptCapture(previous: RuntimeReceiptState | undefined, input: Omit<ReceiptCapture, "generation" | "epoch" | "captureId">, exclusive: boolean): { state: RuntimeReceiptState; capture: ReceiptCapture } {
 const state = normalizeRuntimeReceipts(previous) ?? { generation: randomUUID(), epoch: 0, pending: [], records: [] };
 // An unresolved capture (including a resumed crash) or overlap cannot lend success.
 if (!exclusive || state.pending.length) { state.epoch++; state.records = []; }
 // The caller's existing admission/settlement gates remain authoritative. Once
 // no live writer exists, stale capture markers fence history, not fresh checks.
 if (exclusive) state.pending = [];
 if (state.pending.length >= 64) throw Error("Runtime receipt capture limit reached");
 const capture = { ...input, generation: state.generation, epoch: state.epoch, captureId: randomUUID() };
 state.pending.push(capture.captureId);
 return { state, capture };
}
function evidenceBytes(sessionDir: string, path: string): Buffer {
 const base = realpathSync(sessionDir), root = resolve(base, "artifacts/evidence"), file = resolve(path);
 const rel = relative(root, file);
 if (!rel || rel.startsWith("..") || isAbsolute(rel) || realpathSync(root) !== root || realpathSync(file) !== file || !lstatSync(file).isFile() || lstatSync(file).size > 256 * 1024) throw Error("Runtime receipt evidence outside capture root");
 return readFileSync(file);
}
export function runtimeReceiptEvidenceCurrent(receipt: RuntimeReceipt): boolean {
 try { return hash(evidenceBytes(receipt.sessionDir, receipt.check.evidenceRef)) === receipt.evidenceHash; } catch { return false; }
}
export function anchorRuntimeReceipt(capture: ReceiptCapture, check: VerificationCheckInput, originDispatchId: string, serialized: string): RuntimeReceipt {
 const bytes = evidenceBytes(capture.sessionDir, check.evidenceRef);
 if (!bytes.equals(Buffer.from(serialized))) throw Error("Runtime receipt evidence readback mismatch");
 return { ...capture, scope: [...capture.scope], originDispatchId, backend: "native", capturedAt: Date.now(), check: structuredClone(check), evidenceHash: hash(bytes) };
}
export function reusableRuntimeChecks(state: RuntimeReceiptState, capture: ReceiptCapture, revision: string): VerificationCheckInput[] {
 if (state.generation !== capture.generation || state.epoch !== capture.epoch || state.pending.length !== 1 || state.pending[0] !== capture.captureId || !hex(revision)) return [];
 return state.records.filter(r => {
  if (r.taskId !== capture.taskId || r.sessionDir !== capture.sessionDir || r.declarationHash !== capture.declarationHash || r.epoch !== capture.epoch || JSON.stringify(r.scope) !== JSON.stringify(capture.scope) || r.check.inspectedRevision !== revision) return false;
  try { return hash(evidenceBytes(capture.sessionDir, r.check.evidenceRef)) === r.evidenceHash; } catch { return false; }
 }).map(r => structuredClone(r.check));
}
