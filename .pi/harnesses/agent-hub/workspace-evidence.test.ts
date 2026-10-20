import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeResult, minimalChangeRequirement } from "./acceptance.ts";
import { registerObservedBash, runtimeTestRevision } from "./runtime-test-check.ts";
import { worktreeRevision } from "./scope-gate.js";

function fixture(t: any, nested = true) {
 const cwd = mkdtempSync(join(tmpdir(), "fleet-workspace-evidence-"));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 const roots = nested ? ["code", "docs"] : ["."];
 for (const name of roots) {
  const root = join(cwd, name); mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init"); writeFileSync(join(root, "input.txt"), "initial"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  writeFileSync(join(root, "input.txt"), "task edit");
 }
 return { cwd, scopes: roots };
}

// Use the production tool registration (including before/after observation), not
// a handwritten revision injected into acceptance. The fake API only executes
// the command, like Pi's bash API, and delivers the runtime observer's message.
async function observe(cwd: string, scopes: string[] | undefined, command = "node -e 'process.exit(0)'", action?: () => void) {
 let tool: any;
 const pi = { registerTool: (value: any) => { tool = value; }, on: () => {} };
 const api = {
  createBashToolDefinition: (_root: string, options: any) => ({ execute: async (_id: string, params: any) => {
   const result = await options.operations.exec(params.command);
   return { content: [], details: { exitCode: result.exitCode } };
  } }),
  createLocalBashOperations: () => ({ exec: async (command: string) => {
   let exitCode = 0;
   try { execFileSync("sh", ["-c", command], { cwd, stdio: "pipe" }); }
   catch (error: any) { exitCode = error.status; }
   action?.(); return { exitCode };
  } }),
 };
 registerObservedBash(pi, api, cwd, {}, runtimeTestRevision(cwd, scopes === undefined ? undefined : JSON.stringify(scopes)));
 const result = await tool.execute("check-1", { command });
 return result.details.runtimeTest;
}
function accept(cwd: string, scopes: string[], record: any) {
 const requirement = { id: "A1", tag: "test", text: "workspace check", source: "request", testCommand: record.command };
 return buildRuntimeResult({
  task: { id: "task", current: true, beforeRevision: "before", afterRevision: worktreeRevision(cwd, [], scopes) },
  execution: { status: "completed", exitCode: 0, dispatchId: "dispatch" },
  changes: { status: "changed", paths: ["input.txt"], attribution: "certain" },
  requirements: [minimalChangeRequirement(), requirement], deliverables: [],
  checks: [{ producer: "runtime", kind: "test", taskId: "task", command: [record.command], exitCode: record.exitCode,
   inspectedRevision: record.beforeRevision === record.afterRevision ? record.afterRevision : "changed-during-check",
   evidenceRef: "/runtime/check", requirementIds: ["A1", "AF-MIN-CHANGE"],
   coverage: [{ id: requirement.id, source: requirement.source, text: requirement.text, criticalConditions: [] }] }],
 });
}

test("multi-repo registered observer produces matching accepted evidence", async t => {
 const { cwd, scopes } = fixture(t); assert.equal(worktreeRevision(cwd, []), "unavailable");
 const record = await observe(cwd, scopes);
 assert.match(record.afterRevision, /^[a-f0-9]{64}$/);
 assert.equal(record.beforeRevision, record.afterRevision);
 assert.equal(accept(cwd, scopes, record).acceptance.accepted, true);
});

test("single-repo legacy and declared scope observers preserve whole-repo revision and acceptance", async t => {
 const { cwd } = fixture(t, false);
 for (const scopes of [undefined, ["input.txt"]]) {
  const record = await observe(cwd, scopes);
  assert.equal(record.afterRevision, worktreeRevision(cwd, []));
  assert.equal(accept(cwd, ["input.txt"], record).acceptance.accepted, true);
 }
});

for (const repo of ["code", "docs"]) {
 test(`post-check edit in ${repo} makes evidence stale`, async t => {
  const { cwd, scopes } = fixture(t); const record = await observe(cwd, scopes);
  writeFileSync(join(cwd, repo, "input.txt"), "new edit after check");
  const result = accept(cwd, scopes, record);
  assert.equal(result.acceptance.accepted, false); assert.equal(result.verification.status, "stale");
 });
}

test("during-check edits and nonzero test exit remain blocking", async t => {
 const { cwd, scopes } = fixture(t);
 const failed = await observe(cwd, scopes, "node -e 'process.exit(7)'");
 assert.equal(failed.exitCode, 7); assert.equal(accept(cwd, scopes, failed).verification.status, "failed");
 const changed = await observe(cwd, scopes, undefined, () => writeFileSync(join(cwd, "docs/input.txt"), "during test"));
 assert.notEqual(changed.beforeRevision, changed.afterRevision);
 assert.equal(accept(cwd, scopes, changed).acceptance.accepted, false);
});

test("missing, malformed, incomplete and outside scope observations fail closed", async t => {
 const { cwd, scopes } = fixture(t);
 assert.equal(runtimeTestRevision(cwd, "not-json")(), "unavailable");
 assert.equal(runtimeTestRevision(cwd, '[42]')(), "unavailable");
 for (const invalid of [[], [...scopes, "missing"], ["../outside"]]) {
  const record = await observe(cwd, invalid);
  assert.equal(record.afterRevision, "unavailable");
  // Even when the consumer is equally unavailable, missing identity is not proof.
  assert.equal(accept(cwd, invalid, record).acceptance.accepted, false);
 }
});

test("symlink escape and shell cd cannot widen declared repositories", async t => {
 const { cwd, scopes } = fixture(t); const outside = fixture(t, false);
 symlinkSync(outside.cwd, join(cwd, "escape"));
 assert.equal(runtimeTestRevision(cwd, '["escape"]')(), "unavailable");
 const command = `cd '${outside.cwd}' && node -e 'process.exit(0)'`;
 const record = await observe(cwd, scopes, command);
 assert.equal(record.afterRevision, worktreeRevision(cwd, [], scopes));
 assert.notEqual(record.afterRevision, worktreeRevision(outside.cwd, []));
 // A shell command cannot repair missing declared scope.
 const missing = await observe(cwd, undefined, command);
 assert.equal(missing.afterRevision, "unavailable");
 assert.equal(accept(cwd, scopes, missing).acceptance.accepted, false);
});
