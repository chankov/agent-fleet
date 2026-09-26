import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerRunFlow } from "./run-flow.ts";

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "af-run-flow-repo-")); mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "README.md"), "baseline\n");
	writeFileSync(join(root, "agents", "researcher.md"), "---\nname: researcher\ndescription: read only\ntools: read,grep,find,ls\nmodel: test/model\n---\nScout.\n");
	execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root }); return root;
}
function harness(deps: any) { let definition: any; const shutdown: any[] = []; registerRunFlow({ registerTool(value: any) { definition = value; }, on(name: string, handler: any) { if (name === "session_shutdown") shutdown.push(handler); } } as any, deps); return { definition, shutdown }; }
const report = { status: "success", summary: "Scout complete", artifacts: [], notes_for_next_agent: "", findings: ["README.md"] } as any;

test("T13 run_flow uses exported dispatcher on isolated no-branch snapshot and preserves concurrent source edits", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-")); let charges = 0, childCwd = "", release!: () => void;
	const originalBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		const { definition } = harness({ sessionDir: () => session, taskId: () => "task-1", processObligations: () => ({ acceptance: "unsupported", open: ["risk"] }), reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; }, effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read", "grep", "find", "ls"], fallback: null, allowlisted: true }), scoutAgent: async (options: any) => { childCwd = options.cwd; assert.equal(options.dataReadRoot, options.cwd); writeFileSync(join(root, "README.md"), "concurrent user edit\n"); await gate; return report; } });
		const signal = new AbortController().signal, ctx = { cwd: root } as any;
		const first = definition.execute("one", { procedure: "scout", request: "Locate README", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		while (!childCwd) await new Promise(resolve => setTimeout(resolve, 5));
		const duplicate = definition.execute("two", { procedure: "scout", request: "Locate README", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		const stale = await definition.execute("stale", { procedure: "scout", request: "Different input", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		assert.equal(stale.details.status, "stale-duplicate"); assert.equal(stale.details.budgetCharged, false);
		release(); const [a, b] = await Promise.all([first, duplicate]);
		assert.equal(a.details.snapshotCleanup.status, "removed"); assert.equal(existsSync(childCwd), false);
		assert.equal(charges, 1); assert.deepEqual(a, b); assert.notEqual(childCwd, root); assert.match(childCwd, /agent-fleet-scout-snapshot-/);
		assert.equal(readFileSync(join(root, "README.md"), "utf8"), "concurrent user edit\n");
		assert.equal(a.details.flowAcceptance.accepted, true); assert.equal(a.details.parentAcceptance.accepted, false); assert.deepEqual(a.details.parentAcceptance.assertionsProven, []);
		assert.equal(a.details.runtimeResult.acceptance.status, "not_accepted"); assert.equal(a.details.runtimeResult.task.id, "task-1"); assert.equal(a.details.runtimeResult.task.current, false); assert.equal(a.details.snapshot.originalRevisionUnchanged, false);
		assert.ok(existsSync(a.details.tracePath)); assert.ok(existsSync(a.details.snapshot.manifestPath));
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), originalBranch);
		assert.doesNotMatch(execFileSync("git", ["branch", "--list"], { cwd: root, encoding: "utf8" }), /flow\//);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});

test("T13 setup/result exceptions settle as structured failures, release ownership, and never reject derivatively", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-"));
	const base = { sessionDir: () => session, taskId: () => "task-failure", processObligations: () => ({}), reserveBudget: async () => ({ charged: true, operation: "research", owner: "hub" }), effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), scoutAgent: async () => report };
	const cases = [
		{ name: "session", override: { sessionDir: () => { throw new Error("session boom"); } }, charged: false, started: false },
		{ name: "revision", override: { worktreeRevision: () => { throw new Error("revision boom"); } }, charged: false, started: false },
		{ name: "budget", override: { reserveBudget: async () => { throw new Error("budget boom"); } }, charged: false, started: false },
		{ name: "runtime", override: { buildRuntimeResult: () => { throw new Error("runtime boom"); } }, charged: true, started: true },
		{ name: "obligations", override: { processObligations: () => { throw new Error("obligations boom"); } }, charged: true, started: true },
	];
	const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", listener);
	try {
		for (const item of cases) {
			const { definition } = harness({ ...base, ...item.override });
			const first = await definition.execute("one", { procedure: "scout", request: item.name, invocation_id: `failure-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.equal(first.details.budgetCharged, item.charged); assert.equal(first.details.executionStarted, item.started); assert.equal(first.details.parentAcceptance.accepted, false);
			const duplicate = await definition.execute("two", { procedure: "scout", request: item.name, invocation_id: `failure-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.deepEqual(duplicate, first);
			const next = await definition.execute("three", { procedure: "scout", request: `${item.name}-next`, invocation_id: `next-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.notEqual(next.details.status, "busy");
		}
		await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
	} finally { process.removeListener("unhandledRejection", listener); rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});

test("T13 cancellation is owned by the first Hub invocation and a busy distinct run is not charged", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-")); let charges = 0, entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	try {
		const { definition } = harness({ sessionDir: () => session, taskId: () => "task-2", processObligations: () => ({}), reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; }, effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), scoutAgent: async (options: any) => { entered(); await new Promise((_resolve, reject) => options.run.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); return report; } });
		const controller = new AbortController(); const running = definition.execute("one", { procedure: "scout", request: "Wait", invocation_id: "cancel-run-1" }, controller.signal, () => {}, { cwd: root }); await started;
		const busy = await definition.execute("two", { procedure: "scout", request: "Other", invocation_id: "other-run-2" }, new AbortController().signal, () => {}, { cwd: root }); assert.equal(busy.details.status, "busy"); assert.equal(busy.details.budgetCharged, false);
		controller.abort(); const result = await running; assert.equal(result.details.snapshotCleanup.status, "removed"); assert.equal(charges, 1); assert.equal(result.details.flowAcceptance.accepted, false); assert.equal(result.details.parentAcceptance.accepted, false);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});


test("snapshot cleanup covers failed setup and budget refusal, and reports removal failure", async () => {
 const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-"));
 const base = { sessionDir: () => session, taskId: () => "cleanup", processObligations: () => ({}), effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), reserveBudget: async () => ({ charged: false, operation: "research", owner: "hub" }) };
 try {
  for (const failSetup of [true, false]) {
   let workspace = "";
   const { definition } = harness({ ...base, createSnapshot: (_root: string, target: string) => { workspace = target; mkdirSync(target); if (failSetup) throw new Error("setup failed"); return {}; } });
   const result = await definition.execute("one", { procedure: "scout", request: "read", invocation_id: `cleanup-${failSetup}` }, new AbortController().signal, () => {}, { cwd: root });
   assert.equal(result.details.status, failSetup ? "snapshot-refused" : "budget-refused");
   assert.equal(result.details.snapshotCleanup.status, "removed"); assert.equal(existsSync(workspace), false);
  }
  let retained = "";
  try {
   const { definition } = harness({ ...base, createSnapshot: () => ({}), removeSnapshot: (path: string) => { retained = path; throw new Error("simulated cleanup denial"); } });
   const result = await definition.execute("one", { procedure: "scout", request: "read", invocation_id: "cleanup-denied" }, new AbortController().signal, () => {}, { cwd: root });
   assert.equal(result.details.status, "budget-refused");
   assert.equal(result.details.snapshotCleanup.status, "failed"); assert.equal(result.details.snapshotCleanup.path, retained);
   assert.ok(existsSync(retained)); assert.match(result.content.map((c: any) => c.text).join("\n"), /cleanup failed.*retained at/);
  } finally { if (retained) rmSync(retained, { recursive: true, force: true }); }
 } finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});
