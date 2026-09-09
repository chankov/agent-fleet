import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfiguration } from "./config/agents.ts";
import { createAssertionsArtifactsContext } from "./context/assertions-artifacts.ts";

test("two configuration loads isolate live sessions and leave legacy evidence untouched", t => {
 const cwd = mkdtempSync(join(tmpdir(), "fleet-evidence-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const legacy = join(cwd, ".pi/agent-sessions");
 for (const dir of ["findings", "delegations", "transcripts", "artifacts/returns"]) {
  mkdirSync(join(legacy, dir), { recursive: true }); writeFileSync(join(legacy, dir, "old.txt"), "legacy");
 }
 let session = "";
 const artifacts = createAssertionsArtifactsContext({ getSessionDir: () => session, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} });
 const ports = { setSessionDir: (v: string) => { session = v; }, getSessionDir: () => session,
  archivePreviousRun: artifacts.archivePreviousRun, ensureArtifactsLayout: artifacts.ensureArtifactsLayout,
  resetAssertions() {}, setAgentDefs() {}, setTeams() {}, setModelProfiles() {}, setDispatchPolicy() {}, setDispatchPolicyWarnings() {} };
 loadAgentConfiguration(cwd, ports); const first = session;
 const returned = artifacts.writeRunArtifact("builder", 1, "first result");
 loadAgentConfiguration(cwd, ports);
 assert.notEqual(session, first, "independent live sessions cannot share a writable evidence root");
 assert.equal(readFileSync(returned, "utf8"), "first result");
 for (const dir of ["findings", "delegations", "transcripts", "artifacts/returns"]) assert.equal(readFileSync(join(legacy, dir, "old.txt"), "utf8"), "legacy");
});

test("run counter reuse never overwrites a returned artifact", t => {
 const session = mkdtempSync(join(tmpdir(), "fleet-counter-")); t.after(() => rmSync(session, { recursive: true, force: true }));
 const artifacts = createAssertionsArtifactsContext({ getSessionDir: () => session, getAssertions: () => [], getRunHistoryKeep: () => 2, setStatus() {} });
 const first = artifacts.writeRunArtifact("builder", 1, "first");
 const second = artifacts.writeRunArtifact("builder", 1, "second");
 assert.notEqual(first, second); assert.equal(readFileSync(first, "utf8"), "first");
});

test("retention prunes only closed complete sessions with dead owners, never active or unfinished bundles", async t => {
 const { createEvidenceSession, closeEvidenceSession, pruneEvidenceSessions, beginExecutionEvidence, finishExecutionEvidence } = await import("./execution-evidence.ts");
 const { existsSync } = await import("node:fs");
 const cwd = mkdtempSync(join(tmpdir(), "fleet-retention-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const active = createEvidenceSession(cwd), unfinished = createEvidenceSession(cwd), finished = createEvidenceSession(cwd), newer = createEvidenceSession(cwd);
 beginExecutionEvidence(unfinished, "unfinished", { task: "still running" }); closeEvidenceSession(unfinished);
 const bundle = beginExecutionEvidence(finished, "finished", { task: "completed" }); finishExecutionEvidence(bundle, { output: "complete" }); closeEvidenceSession(finished);
 // Order completion deterministically, not by wall-clock sleeps.
 writeFileSync(join(finished, "closed.json"), JSON.stringify({ closedAt: "2000-01-01" }));
 closeEvidenceSession(newer);
 pruneEvidenceSessions(newer, 1, () => true); assert.equal(existsSync(finished), true, "live owners protected");
 pruneEvidenceSessions(newer, 1, () => false);
 assert.equal(existsSync(finished), false); assert.equal(existsSync(newer), true);
 assert.equal(existsSync(active), true); assert.equal(existsSync(unfinished), true);
});
