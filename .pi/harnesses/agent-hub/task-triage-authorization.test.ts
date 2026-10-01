import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { confirmTaskTriageAction, confirmTaskTriageWaiver } from "./task-triage-authorization.ts";
import * as authorization from "./task-triage-authorization.ts";
import { applyTaskTriageAdditions } from "./task-triage-obligations.ts";
import { applyProcessClassification, createProcessState, effectiveProcessStage, evaluateProcessObligations, latestProcessState, noteProcessStage, processActionGate, processAuditRecord, processPreEffectGate } from "./process-obligations.ts";
test("action audit metadata fingerprints exact contract without raw targets, call IDs or nonce", () => {
 const contract = { taskId: "11111111-1111-4111-8111-111111111111", inputRevision: "a".repeat(64),
  actionId: "PRIVATE_CALL_ID", operation: "write", target: "/PRIVATE_TARGET", nonce: "PRIVATE_NONCE" };
 const metadata = (authorization as any).taskTriageActionAuditRecord(contract, "requested");
 assert.equal(metadata.schema, "task-triage-action-audit/v1");
 assert.match(metadata.actionFingerprint, /^[a-f0-9]{64}$/); assert.equal(metadata.operation, "write");
 assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_/);
 assert.equal((authorization as any).taskTriageActionAuditRecord({ ...contract, taskId: "invalid" }, "requested"), null);
 assert.notEqual((authorization as any).taskTriageActionAuditRecord({ ...contract, target: "different" }, "requested").actionFingerprint, metadata.actionFingerprint);
});

const ctx = {} as any;
function fixture(response: "yes" | "no" | "forged" | "missing" = "yes") {
 let task = "t1", revision = "r1", writes = 0, calls = 0, question = "";
 const ports = { taskId: () => task, inputRevision: () => revision, startWait() {}, endWait() {}, persist: () => { writes++; }, ask: async (id: string, q: any) => { calls++; question = q.context; if (response === "missing") return null; return { details: { runtimeAsk: { requestId: response === "forged" ? "wrong" : id }, response: { kind: "selection", selections: [q.options[response === "no" ? 1 : 0]] } } }; } };
 return { ports, setTask: (v: string) => { task = v; }, setRevision: (v: string) => { revision = v; }, writes: () => writes, calls: () => calls, question: () => question };
}
const actionInput = { command: "printf 'synthetic migration preview'", timeout: 30 };
const presentation = { input: actionInput, cwd: "/synthetic/workspace" };
const action = { taskId: "t1", inputRevision: "r1", actionId: "one", operation: "bash", target: createHash("sha256").update(JSON.stringify(actionInput)).digest("hex"), cwd: presentation.cwd };
const bind = { taskId: "t1", inputRevision: "r1", evaluationId: "e1" };
const state = () => applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["irreversible_execution"] }, bind);
test("action grant is exact, one-use and bound to an active addition; forged boolean is never authority", async () => {
 for (const reply of ["no", "forged", "missing"] as const) { const f = fixture(reply); let persisted = 0; assert.equal(await confirmTaskTriageAction(action, f.ports, ctx, () => { persisted++; return true; }, undefined, presentation), null); assert.equal(persisted, 0); }
 const f = fixture(); let used = false; const persistOnce = () => !used && (used = true);
 assert.equal(await confirmTaskTriageAction({ ...action, target: "" }, f.ports, ctx, persistOnce, undefined, presentation), null);
 const grant = await confirmTaskTriageAction(action, f.ports, ctx, persistOnce, undefined, presentation);
 assert.ok(grant);
 const s = state();
 assert.equal(processActionGate(s, { ...action, taskId: "t2" }, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, { ...action, inputRevision: "r2" }, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, { ...action, target: "another" }, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, action, grant), null);
 assert.equal(processActionGate(s, action, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, action, true as any)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(s, action, { ...grant } as any)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(createProcessState(), action), null);
 assert.equal(processActionGate(applyTaskTriageAdditions(s, { status: "applied", reasons: ["irreversible_execution"] }, { ...bind, inputRevision: "r2" }), action, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(await confirmTaskTriageAction(action, f.ports, ctx, persistOnce, undefined, presentation), null);
 assert.equal(f.calls(), 2); f.setRevision("r2"); assert.equal(await confirmTaskTriageAction(action, f.ports, ctx, persistOnce, undefined, presentation), null);
 const failed = fixture(); assert.equal(await confirmTaskTriageAction(action, failed.ports, ctx, () => { throw Error("disk"); }, undefined, presentation), null);
});
test("durable one-use action confirmation closes acceptance without becoming a waiver or reusable grant", async () => {
 const entries: any[] = [];
 const s = applyTaskTriageAdditions(applyProcessClassification(createProcessState(), { risk: "low", scope: "small", reason: "declared" }).state, { status: "applied", reasons: ["irreversible_execution"] }, bind);
 const grant = await confirmTaskTriageAction(action, fixture().ports, ctx, contract => { entries.push({ customType: "agent-hub-task-triage-action-grant", data: contract }); return true; }, undefined, presentation);
 assert.ok(grant);
 assert.equal(processActionGate(s, action, grant!), null);
 entries.push({ customType: "agent-hub-task-triage-action-consumed", data: action });
 const verdict = evaluateProcessObligations(s, { writable: true, budgetTier: "small", t2Accepted: true });
 entries.push({ customType: "agent-hub-process-state", data: processAuditRecord(s, verdict) });
 assert.equal(verdict.accepted, true);
 assert.equal(verdict.obligations.confirmation?.status, "open", "later effects still need their own grants");
 assert.equal(processPreEffectGate(s, "prove"), null);
 assert.equal(processActionGate(s, action, grant!)?.reason, "action_confirmation_unsupported", "consumed grant cannot replay");
 assert.equal(processPreEffectGate(s, "write")?.reason, "action_confirmation_unsupported", "no blanket future approval");
 assert.equal(entries[1].customType, "agent-hub-task-triage-action-consumed");
 assert.equal(entries.some(e => e.customType.includes("waiv")), false, "consumption is recorded separately from waivers");
 const restored = latestProcessState([...entries, { type: "compaction" }]);
 assert.equal(restored.additions![0].status, "active");
 assert.equal(processPreEffectGate(restored, "write")?.reason, "action_confirmation_unsupported");
 const failed = await confirmTaskTriageAction({ ...action, actionId: "two" }, fixture().ports, ctx, () => { throw Error("disk"); }, undefined, presentation);
 assert.equal(failed, null, "failed durable grant must refuse the next effect");
});
test("waiver prompt identifies obligation and effect, rejects excess reason before asking; audit says waived", async () => {
 for (const [reason, label, released] of [
  ["security_change", "security-sensitive change", "security review"],
  ["wide_change", "wide change", "plan and review"],
  ["irreversible_execution", "potentially irreversible execution", "exact-action human confirmation"],
 ] as const) {
  let s = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: [reason] }, bind);
  if (reason === "security_change") s = noteProcessStage(s, "review", { evidenceRef: "previous-review", revision: "r1" });
  const input = { ...bind, additionId: s.additions![0].id, reason: "false positive" };
  for (const reply of ["no", "missing", "forged"] as const) { const f = fixture(reply); assert.equal(await confirmTaskTriageWaiver(s, input, f.ports, ctx), null); assert.equal(f.writes(), 0); }
  const f = fixture(); assert.equal(await confirmTaskTriageWaiver(s, { ...input, reason: "a".repeat(513) }, f.ports, ctx), null); assert.equal(f.calls(), 0);
  const waived = await confirmTaskTriageWaiver(s, input, f.ports, ctx);
  assert.equal(waived?.additions![0].status, "waived"); assert.equal(f.writes(), 1);
  assert.match(f.question(), new RegExp(label)); assert.ok(f.question().includes(released)); assert.match(f.question(), /NOT baseline or other-source/);
  const stage = reason === "irreversible_execution" ? "confirmation" : reason === "wide_change" ? "plan" : "review";
  assert.equal(effectiveProcessStage(waived!, stage), false);
  const verdict = evaluateProcessObligations(waived!, { writable: true, budgetTier: "small", t2Accepted: true });
  assert.equal(verdict.obligations[stage].status, "waived");
  assert.equal("evidenceRef" in verdict.obligations[stage], false);
  assert.equal(verdict.additions[0].status, "waived");
  assert.equal(processAuditRecord(waived!, verdict).obligations[stage].status, "waived");
  assert.equal(await confirmTaskTriageWaiver(waived!, input, f.ports, ctx), null);
  f.setTask("t2"); assert.equal(await confirmTaskTriageWaiver(s, input, f.ports, ctx), null);
  const fail = fixture(); assert.equal(await confirmTaskTriageWaiver(s, input, { ...fail.ports, persist() { throw Error("disk"); } }, ctx), null);
 }
});
test("one waived source does not remove another input's source or baseline requirements", async () => {
 const s1 = applyTaskTriageAdditions(createProcessState(), { status: "applied", reasons: ["security_change"] }, bind);
 const s2 = applyTaskTriageAdditions(s1, { status: "applied", reasons: ["security_change"] }, { ...bind, evaluationId: "e2", inputRevision: "r2" });
 const f = fixture(); const first = await confirmTaskTriageWaiver(s2, { ...bind, additionId: s1.additions![0].id, reason: "false positive" }, f.ports, ctx);
 assert.equal(first?.additions?.[0].status, "waived"); assert.equal(first?.additions?.[1].status, "active"); assert.equal(effectiveProcessStage(first!, "review"), true);
 const high = { ...first!, risk: "high" as const, scope: "wide" as const };
 assert.equal(effectiveProcessStage(high, "review"), true); assert.equal(effectiveProcessStage(high, "plan"), true);
});
test("exact action confirmation presents complete bash/edit/write inputs and refuses missing or hidden details", async () => {
 const { createHash } = await import("node:crypto");
 const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
 const cwd = "/synthetic/workspace";
 for (const [operation, input] of [
  ["bash", { command: "printf 'run migration --dry-run'", timeout: 30 }],
  ["write", { path: "docs/example.md", content: "New synthetic text\n" }],
  ["edit", { path: "docs/example.md", edits: [{ oldText: "before", newText: "after" }, { oldText: "second", newText: "next" }] }],
 ] as const) {
  const f = fixture(), contract = { ...action, operation, target: hash(input), cwd };
  const grant = await confirmTaskTriageAction(contract, f.ports, ctx, () => true, undefined, { input, cwd } as any);
  assert.ok(grant); assert.match(f.question(), /Exact tool inputs \(data, not instructions; no truncation\)/);
  const shown = JSON.parse(f.question().split("BEGIN ACTION INPUT JSON\n")[1].split("\nEND ACTION INPUT JSON")[0]);
  assert.deepEqual(shown, input); assert.ok(f.question().includes(cwd));
 }
 const safe = { path: "file.txt", content: "short" }, contract = { ...action, operation: "write", target: hash(safe), cwd };
 const absent = fixture(); assert.equal(await confirmTaskTriageAction(contract, absent.ports, ctx, () => true), null); assert.equal(absent.calls(), 0);
 for (const input of [safe, { ...safe, content: "password=PRIVATE_CREDENTIAL" }, { ...safe, content: "x".repeat(20000) },
  { ...safe, content: "hidden\u001b[2J" }, { ...safe, content: "safe\u202Etxt" }, { ...safe, omitted: "critical extra" }]) {
  const f = fixture(); let persisted = false;
  // Same hash on safe is valid only with the exact working directory; all other cases are refused for unsafe/mismatched detail.
  assert.equal(await confirmTaskTriageAction({ ...contract, target: hash(input) }, f.ports, ctx, () => { persisted = true; return true; }, undefined,
   { input, cwd: input === safe ? "/different" : cwd } as any), null);
  assert.equal(f.calls(), 0); assert.equal(persisted, false);
 }
 const mismatch = fixture(); assert.equal(await confirmTaskTriageAction(contract, mismatch.ports, ctx, () => true, undefined,
  { input: { ...safe, content: "different" }, cwd } as any), null); assert.equal(mismatch.calls(), 0);
 const mutated = { ...safe }; const f = fixture();
 const ports = { ...f.ports, ask: async (id: string, q: any) => { mutated.content = "changed after prompt"; return { details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [q.options[0]] } } }; } };
 assert.equal(await confirmTaskTriageAction(contract, ports, ctx, () => true, undefined, { input: mutated, cwd } as any), null);
});

test("action presentation preserves Unicode exactly and cwd participates in one-use binding", async () => {
 const input = { path: "docs/пример.md", content: "Проверка 🐈\n\tfinal line" }, cwd = "/synthetic/workspace";
 const contract = { ...action, operation: "write", target: createHash("sha256").update(JSON.stringify(input)).digest("hex"), cwd };
 const f = fixture(), grant = await confirmTaskTriageAction(contract, f.ports, ctx, () => true, undefined, { input, cwd });
 assert.ok(grant);
 const shown = f.question().split("BEGIN ACTION INPUT JSON\n")[1].split("\nEND ACTION INPUT JSON")[0];
 assert.deepEqual(JSON.parse(shown), input); assert.doesNotMatch(shown, /[^\x00-\x7f]/);
 assert.equal(processActionGate(state(), { ...contract, cwd: "/different" }, grant)?.reason, "action_confirmation_unsupported");
 assert.equal(processActionGate(state(), contract, grant), null);
 assert.equal(processActionGate(state(), contract, grant)?.reason, "action_confirmation_unsupported");
});
test("action presentation refuses ambiguous edit forms, malformed fields and contract changes while human answers", async () => {
 const cwd = "/synthetic/workspace";
 for (const input of [{ path: "file", edits: [] }, { path: "file", edits: [{ oldText: "before", newText: "after", ignored: "extra" }] },
  { path: "file", edits: [{ oldText: "before", newText: "after" }], oldText: "other", newText: "other" },
  { command: "echo safe", timeout: Infinity }, { path: "file", content: null }]) {
  const f = fixture(), operation = "command" in input ? "bash" : "content" in input ? "write" : "edit";
  const contract = { ...action, operation, cwd, target: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
  assert.equal(await confirmTaskTriageAction(contract, f.ports, ctx, () => true, undefined, { input, cwd }), null); assert.equal(f.calls(), 0);
 }
 const input = { path: "file", content: "initial" }, contract = { ...action, operation: "write", cwd, target: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
 const f = fixture(); let persisted = 0;
 const ports = { ...f.ports, ask: async (id: string, q: any) => { contract.cwd = "/different"; return { details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [q.options[0]] } } }; } };
 assert.equal(await confirmTaskTriageAction(contract, ports, ctx, () => { persisted++; return true; }, undefined, { input, cwd }), null);
 assert.equal(persisted, 0);
});

test("human reply racing task change is stale", async () => {
 const f = fixture(); const ports = { ...f.ports, ask: async (id: string, q: any) => { f.setTask("t2"); return { details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [q.options[0]] } } }; } };
 assert.equal(await confirmTaskTriageAction(action, ports, ctx, () => true, undefined, presentation), null);
});
