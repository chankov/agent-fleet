import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { asEnvelope, capture, resolveBase } from "./changes.ts";
import { Run } from "./run.ts";

function repo(): string {
	const cwd = mkdtempSync(join(tmpdir(), "flow-changes-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, "file.txt"), "one\n"); execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "one"], { cwd }); return cwd;
}
function commit(cwd: string, content: string) { writeFileSync(join(cwd, "file.txt"), content); execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", content.trim()], { cwd }); }

test("resolveBase covers branch-ahead, dirty-on-base, and clean fallback scenarios", () => {
	const ahead = repo(), dirty = repo(), clean = repo();
	try {
		execFileSync("git", ["switch", "-qc", "feature"], { cwd: ahead }); commit(ahead, "two\n");
		assert.deepEqual(resolveBase("main", ahead).scenario, "ahead"); assert.match(resolveBase("main", ahead).reason, /HEAD is ahead/);
		writeFileSync(join(dirty, "file.txt"), "dirty\n"); assert.equal(resolveBase("main", dirty).scenario, "dirty");
		commit(clean, "two\n"); const fallback = resolveBase("main", clean); assert.equal(fallback.scenario, "fallback"); assert.match(fallback.reason, /HEAD~1/);
	} finally { for (const cwd of [ahead, dirty, clean]) rmSync(cwd, { recursive: true, force: true }); }
});

test("capture names untracked files, traces the reason, truncates, and adapts envelope", () => {
	const cwd = repo();
	try {
		writeFileSync(join(cwd, "file.txt"), "a\nb\nc\nd\n"); writeFileSync(join(cwd, "new.txt"), "new\n");
		const run = new Run({ cwd, runId: "changes" }); const changes = capture(run, { ref: "main", cwd, maxDiffLines: 2 });
		assert.deepEqual(changes.changedFiles, ["file.txt", "new.txt"]); assert.deepEqual(changes.untrackedFiles, ["new.txt"]);
		assert.ok(changes.hiddenLines > 0); assert.match(changes.diff, /diff lines hidden/);
		assert.ok(run.trace.events().some(event => event.message === "diffing the uncommitted working tree"));
		const envelope = asEnvelope(changes, "document these"); assert.deepEqual(envelope.changed_files, changes.changedFiles); assert.match(envelope.notes_for_next_agent, /document these/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
