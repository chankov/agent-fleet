import assert from "node:assert/strict";
import test from "node:test";
import { createNoProgressGuard } from "./no-progress.ts";

test("unchanged failure blocks rewording and new turns; one human approval buys only one retry", () => {
 const guard = createNoProgressGuard();
 const ticket = guard.begin("dispatch", "same-input"); assert.equal(ticket.allowed, true);
 guard.finish(ticket, "same-input", { dispatchId: "failed-1", evidencePath: "/failure.json", reason: "assistant_error" });
 const blocked = guard.begin("dispatch", "same-input"); assert.equal(blocked.allowed, false);
 assert.equal(blocked.failure?.dispatchId, "failed-1");
 assert.equal(guard.authorize("stale-id"), false); assert.equal(guard.authorize("failed-1"), true);
 const retried = guard.begin("dispatch", "same-input"); assert.equal(retried.allowed, true);
 assert.equal(guard.begin("dispatch", "same-input").allowed, false, "parallel same-input retry blocked");
 guard.finish(retried, "same-input", { dispatchId: "failed-2", reason: "assistant_error" });
 assert.equal(guard.begin("dispatch", "same-input").allowed, false);
 assert.equal(guard.authorize("failed-1"), false, "previous authorization cannot acknowledge a later failure");
});

test("changed inputs permit work; stale completion after genuine task reset cannot poison new task", () => {
 const guard = createNoProgressGuard(); const old = guard.begin("research", "old-revision");
 guard.finish(old, "old-revision", { dispatchId: "r1", reason: "exit_code" });
 assert.equal(guard.begin("research", "new-revision").allowed, true);
 const late = guard.begin("dispatch", "old-revision"); guard.reset();
 guard.finish(late, "old-revision", { dispatchId: "stale", reason: "exit_code" });
 assert.equal(guard.authorize("stale"), false);
 assert.equal(guard.begin("dispatch", "old-revision").allowed, true);
});

test("real changed content unlocks a retry but prose and generated runtime files do not", async t => {
 const { withNoProgress } = await import("./no-progress.ts");
 const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
 const { join } = await import("node:path"); const { tmpdir } = await import("node:os"); const { execFileSync } = await import("node:child_process");
 const cwd = mkdtempSync(join(tmpdir(), "progress-revision-")); t.after(() => rmSync(cwd, { recursive: true, force: true }));
 execFileSync("git", ["init", cwd], { stdio: "ignore" });
 writeFileSync(join(cwd, "source.ts"), "before");
 let calls = 0;
 const d: any = { noProgress: createNoProgressGuard(), artifacts: { loadInputArtifacts: () => [] } };
 const run = withNoProgress(d, "dispatch", async () => { calls++; return { content: [], details: { status: "error", exitCode: 1, dispatchId: `failure-${calls}` } }; });
 const request = { agent: "builder", task: "do work" }; const ctx: any = { cwd };
 await run("1", request, undefined, undefined, ctx);
 mkdirSync(join(cwd, ".pi/agent-sessions"), { recursive: true }); writeFileSync(join(cwd, ".pi/agent-sessions/new-result"), "mere runtime activity");
 const unchanged = await run("2", { ...request, task: "rephrased" }, undefined, undefined, ctx);
 assert.equal((unchanged.details as any).status, "no_progress_refused"); assert.equal(calls, 1);
 writeFileSync(join(cwd, "source.ts"), "corrected content");
 await run("3", request, undefined, undefined, ctx); assert.equal(calls, 2);
});
