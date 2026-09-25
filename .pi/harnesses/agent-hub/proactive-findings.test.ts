import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createProactiveFindings } from "./proactive-findings.ts";
import type { TurnSnapshot, ReviewFinding } from "./proactive-types.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = "secret-code-prompt-task-rule";
function snapshot(text = secret, line = 1): TurnSnapshot {
 const excerpt = { text, hash: hash(text), offset: 0, endOffset: Buffer.byteLength(text), startLine: line, endLine: line, truncated: false };
 return { snapshotId: hash(text + line), turnId: `session:owner:attempt:${line}`, head: "h", context: { task: { path: "task", revision: "r", hash: hash(secret) }, rules: [{ path: "rules.md", revision: "r", hash: hash("rule") }], exceptions: [] }, planStatus: "task_only", status: "complete", gaps: [], units: [{ id: `unit-${line}`, path: "docs/x.md", kind: "modified", after: excerpt, attribution: "uncertain" }], observedPaths: 1, coverage: { retainedUnits: 1, omittedPaths: 0, retainedBytes: Buffer.byteLength(text) } };
}
function finding(s: TurnSnapshot, source: "deterministic" | "system1"): ReviewFinding {
 return { source, snapshotId: s.snapshotId, unitId: s.units[0].id, reference: "rule-id", verdict: "potential_violation", evidenceStatus: "complete", delivery: "not_applicable", ...(source === "deterministic" ? { ruleHash: hash("rule"), category: "relative-markdown-links", locator: { path: "docs/x.md", excerptHash: s.units[0].after!.hash, line: s.units[0].after!.startLine } } : {}) };
}
const assessment = (findings: ReviewFinding[] = [], gaps: string[] = [], rules: { unitId: string; ruleId: string; verdict: "no_observed_violation" }[] = []) => ({ status: "reviewed" as const, drift: { task: "aligned" as const, plan: "not_checked" as const }, rules, findings, gaps, evaluations: [] });
test("A10 source claims, movement-stable dedupe and strict recheck resolution", () => {
 const ledger = createProactiveFindings(); const a = snapshot(), b = snapshot(`noise\n${secret}`, 2);
 const first = ledger.observe("owner", "attempt", a, "reviewed", assessment([finding(a, "deterministic"), finding(a, "system1")]));
 assert.deepEqual(first.findings.map(f => f.claim).sort(), ["suspicion", "violation"]);
 const moved = ledger.observe("owner", "attempt", b, "reviewed", assessment([finding(b, "deterministic")]));
 assert.equal(moved.findings.find(f => f.claim === "violation")?.occurrences, 2);
 assert.equal(moved.findings.find(f => f.claim === "suspicion")?.state, "stale");
 const gap = ledger.observe("owner", "attempt", b, "not_checked", assessment([], ["selection_gap"]));
 assert.equal(gap.coverage.status, "partial"); assert.equal(gap.findings.some(f => f.state === "resolved"), false);
 const cleared = ledger.observe("owner", "attempt", b, "reviewed", assessment([], [], [{ ruleId: "rule-id", unitId: b.units[0].id, verdict: "no_observed_violation" }]), [{ ruleId: "rule-id", subject: "docs/x.md" }]);
 assert.equal(cleared.findings.every(f => f.state === "resolved"), true);
 assert.equal(ledger.readback(first.findings[0].snapshotHandle, first.findings[0].snapshotHash, a.snapshotId, a.units[0].id, a.units[0].after!.hash), secret);
 assert.equal(ledger.history.length, 4);
});
test("captured coordinates bind to the retained side/hash, not a guessed violation line", () => {
 const ledger = createProactiveFindings();
 const deleted = snapshot("old\nsource", 7);
 const before = { ...deleted.units[0].after!, offset: 12, endOffset: 22, startLine: 7, endLine: 8 };
 const removed: TurnSnapshot = { ...deleted, units: [{ ...deleted.units[0], kind: "deleted", after: undefined, before }] };
 const entry = ledger.observe("owner", "attempt", removed, "reviewed", assessment([finding(removed, "system1")])).findings[0];
 assert.deepEqual(entry.capturedRange, { side: "before", offset: 12, endOffset: 22, startLine: 7, endLine: 8 });
 assert.equal(entry.violationLine, undefined);
 assert.equal(ledger.readback(entry.snapshotHandle, entry.snapshotHash, entry.snapshotId, entry.unitId, entry.excerptHash), "old\nsource");
 const bad: TurnSnapshot = { ...deleted, units: [{ ...deleted.units[0], after: { ...deleted.units[0].after!, startLine: NaN, endOffset: -1 } }] };
 const unknown = ledger.observe("owner2", "attempt", bad, "reviewed", assessment([finding(bad, "system1")])).findings[0];
 assert.equal(unknown.capturedRange, undefined);
 const mismatch = ledger.observe("owner3", "attempt", deleted, "reviewed", assessment([{ ...finding(deleted, "deterministic"), locator: { path: "docs/x.md", excerptHash: hash("wrong") } }])).findings;
 assert.equal(mismatch.length, 0);
 const redactedBase = snapshot("[REDACTED] link", 14);
 const redacted: TurnSnapshot = { ...redactedBase, units: [{ ...redactedBase.units[0], after: { ...redactedBase.units[0].after!, endOffset: 6 } }] }; // replacement expanded captured bytes
 const local = { ...finding(redacted, "deterministic"), locator: { path: "docs/x.md", excerptHash: redacted.units[0].after!.hash, line: 1 }, category: "relative-markdown-links" };
 const hidden = ledger.observe("owner4", "attempt", redacted, "reviewed", assessment([local])).findings[0];
 assert.equal(hidden.capturedRange?.startLine, 14);
 assert.equal(hidden.violationLine, undefined);
 const plain = snapshot("link", 21);
 const precise = ledger.observe("owner5", "attempt", plain, "reviewed", assessment([{ ...finding(plain, "deterministic"), category: "relative-markdown-links", locator: { path: "docs/x.md", excerptHash: plain.units[0].after!.hash, line: 1 } }])).findings[0];
 assert.equal(precise.violationLine, 21);
});

test("missing/corrupt private snapshots unavailable without live file substitution", t => {
 const dir = mkdtempSync(join(tmpdir(), "p8-private-")); t.after(() => rmSync(dir, { force: true, recursive: true }));
 const ledger = createProactiveFindings({ directory: dir }); const s = snapshot();
 const entry = ledger.observe("owner", "attempt", s, "reviewed", assessment([finding(s, "system1")])).findings[0];
 const file = join(dir, `${entry.snapshotHandle}.json`);
 assert.equal(ledger.readback(entry.snapshotHandle, entry.snapshotHash, entry.snapshotId, entry.unitId, entry.excerptHash), secret);
 writeFileSync(file, "corrupt");
 assert.equal(ledger.readback(entry.snapshotHandle, entry.snapshotHash, entry.snapshotId, entry.unitId, entry.excerptHash), null);
 rmSync(file);
 assert.equal(ledger.readback(entry.snapshotHandle, entry.snapshotHash, entry.snapshotId, entry.unitId, entry.excerptHash), null);
 assert.equal(JSON.stringify(entry).includes(secret), false);
});

test("failed private retain leaves coverage partial and preserves prior findings", t => {
 const root = mkdtempSync(join(tmpdir(), "p8-retain-")); t.after(() => rmSync(root, { force: true, recursive: true }));
 const dir = join(root, "private"); mkdirSync(dir);
 const ledger = createProactiveFindings({ directory: dir }); const first = snapshot(), next = snapshot("changed", 2);
 const prior = ledger.observe("owner", "attempt", first, "reviewed", assessment([finding(first, "deterministic")])).findings[0];
 assert.equal(ledger.history[0].coverage.status, "checked");
 renameSync(dir, join(root, "old-private"));
 writeFileSync(dir, "not a directory"); // ENOTDIR on every platform, including privileged users.
 const failed = ledger.observe("owner", "attempt", next, "reviewed", assessment(), [{ ruleId: "rule-id", subject: "docs/x.md" }]);
 assert.equal(failed.coverage.status, "partial");
 assert.deepEqual(failed.coverage.checked, []);
 assert.ok(failed.coverage.gaps.length > 0);
 assert.deepEqual(failed.findings, [prior]);
 assert.deepEqual(ledger.current, [prior]);
});

test("runtime composes P6/P7 assessment without turning selection gaps into a pass", async () => {
 const { createProactiveRuntime } = await import("./proactive-runtime.ts");
 const s = snapshot();
 const runtime = createProactiveRuntime({ config: { version: 1, mode: "shadow", remoteContext: "disabled", include: ["docs/**"], maxEvaluationsPerSession: 2 }, evaluate: async job => {
  assert.equal(job.claimEvaluation?.(), true);
  return assessment([finding(s, "system1")], ["selection_gap"]);
 } });
 assert.equal(runtime.submit("owner", "attempt", s, 1), true);
 await new Promise(resolve => setTimeout(resolve, 10));
 assert.equal(runtime.records[0]?.status, "not_checked");
 assert.equal(runtime.findings.history[0]?.coverage.status, "partial");
 assert.equal(runtime.findings.current[0]?.claim, "suspicion");
 assert.deepEqual(runtime.activity.live().map(e => e.type), ["job_started", "evaluation_started", "evaluation_finished", "job_finished"]);
});

test("rule removal and unavailable assessment cannot resolve a prior finding", () => {
 const ledger = createProactiveFindings(); const first = snapshot(), next = snapshot("changed", 2);
 ledger.observe("owner", "attempt", first, "reviewed", assessment([finding(first, "deterministic")]));
 const withoutRule = { ...next, context: { ...next.context, rules: [] } };
 const removed = ledger.observe("owner", "attempt", withoutRule, "reviewed", assessment(), [{ ruleId: "rule-id", subject: "docs/x.md" }]);
 assert.equal(removed.findings[0].state, "stale");
 const unavailable = ledger.observe("owner", "attempt", next, "unavailable", assessment([], ["timeout"]));
 assert.equal(unavailable.findings[0].state, "stale"); assert.equal(unavailable.coverage.status, "partial");
});
