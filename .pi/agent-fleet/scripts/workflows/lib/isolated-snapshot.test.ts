import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIsolatedWorkingTreeSnapshot } from "./isolated-snapshot.ts";

function git(root: string, args: string[]): void { execFileSync("git", args, { cwd: root }); }
function repo(): string { const root = mkdtempSync(join(tmpdir(), "af-snapshot-src-")); writeFileSync(join(root, "tracked.txt"), "one\n"); git(root, ["init", "-q"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "Test"]); git(root, ["add", "."]); git(root, ["commit", "-qm", "fixture"]); return root; }

test("T13 isolated snapshot captures working state, excludes credentials and records immutable identity", () => {
	const source = repo(), holder = mkdtempSync(join(tmpdir(), "af-snapshot-out-")), workspace = join(holder, "workspace"), manifest = join(holder, "evidence", "manifest.json");
	try { writeFileSync(join(source, "tracked.txt"), "dirty\n"); writeFileSync(join(source, "note.txt"), "untracked\n"); writeFileSync(join(source, ".env"), "SECRET=never-copy\n"); const result = createIsolatedWorkingTreeSnapshot(source, workspace, manifest); assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "dirty\n"); assert.equal(readFileSync(join(workspace, "note.txt"), "utf8"), "untracked\n"); assert.equal(existsSync(join(workspace, ".env")), false); assert.ok(result.excluded.includes(".env")); assert.match(result.sourceStateHash, /^[a-f0-9]{64}$/); assert.equal(statSync(manifest).mode & 0o777, 0o400); } finally { rmSync(source, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); }
});

test("T13 isolated snapshot rejects symlink sources instead of following an escape", () => {
	const source = repo(), holder = mkdtempSync(join(tmpdir(), "af-snapshot-out-"));
	try { symlinkSync("/etc/passwd", join(source, "escape")); assert.throws(() => createIsolatedWorkingTreeSnapshot(source, join(holder, "workspace"), join(holder, "manifest.json")), /plain file|symlink/); } finally { rmSync(source, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); }
});

test("T13 isolated snapshot never writes through a HEAD-tracked symlink leaf", () => {
	const source = repo(), holder = mkdtempSync(join(tmpdir(), "af-snapshot-out-")), outside = mkdtempSync(join(tmpdir(), "af-snapshot-victim-"));
	const victim = join(outside, "victim"), link = join(source, "tracked-link");
	try {
		writeFileSync(victim, "outside-before\n"); symlinkSync(victim, link); git(source, ["add", "tracked-link"]); git(source, ["commit", "-qm", "tracked symlink"]);
		unlinkSync(link); writeFileSync(link, "snapshot-overlay\n");
		createIsolatedWorkingTreeSnapshot(source, join(holder, "workspace"), join(holder, "manifest.json"));
		assert.equal(readFileSync(victim, "utf8"), "outside-before\n");
		assert.equal(readFileSync(join(holder, "workspace", "tracked-link"), "utf8"), "snapshot-overlay\n");
	} finally { rmSync(source, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("T13 isolated snapshot unlinks an excluded HEAD symlink leaf without deleting its outside target", () => {
	const source = repo(), holder = mkdtempSync(join(tmpdir(), "af-snapshot-out-")), outside = mkdtempSync(join(tmpdir(), "af-snapshot-victim-"));
	const victim = join(outside, "victim"), excludedLink = join(source, ".env");
	try {
		writeFileSync(victim, "outside-before\n"); symlinkSync(victim, excludedLink); git(source, ["add", ".env"]); git(source, ["commit", "-qm", "excluded symlink"]);
		createIsolatedWorkingTreeSnapshot(source, join(holder, "workspace"), join(holder, "manifest.json"));
		assert.equal(readFileSync(victim, "utf8"), "outside-before\n"); assert.equal(existsSync(join(holder, "workspace", ".env")), false);
	} finally { rmSync(source, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("T13 isolated snapshot refuses HEAD symlink parents before write or excluded delete-through", () => {
	for (const excluded of [false, true]) {
		const source = repo(), holder = mkdtempSync(join(tmpdir(), "af-snapshot-out-")), outside = mkdtempSync(join(tmpdir(), "af-snapshot-victim-"));
		const parent = excluded ? ".pi" : "linked-parent", victimName = excluded ? "agent-sessions" : "child.txt";
		const victimPath = excluded ? join(outside, "agent-sessions", "victim.txt") : join(outside, "child.txt");
		try {
			mkdirSync(join(outside, "agent-sessions"), { recursive: true }); writeFileSync(victimPath, "outside-before\n");
			symlinkSync(outside, join(source, parent)); git(source, ["add", parent]); git(source, ["commit", "-qm", "tracked parent symlink"]);
			unlinkSync(join(source, parent)); mkdirSync(join(source, parent), { recursive: true });
			const worktreeFile = excluded ? join(source, parent, victimName, "victim.txt") : join(source, parent, victimName);
			mkdirSync(join(worktreeFile, ".."), { recursive: true }); writeFileSync(worktreeFile, excluded ? "excluded\n" : "overlay\n"); git(source, ["add", worktreeFile]);
			assert.throws(() => createIsolatedWorkingTreeSnapshot(source, join(holder, "workspace"), join(holder, "manifest.json")), /traverses symlink/);
			assert.equal(readFileSync(victimPath, "utf8"), "outside-before\n");
		} finally { rmSync(source, { recursive: true, force: true }); rmSync(holder, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
	}
});
