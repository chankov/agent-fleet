import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProactiveConfig } from "./proactive-config.ts";
import { beginTurn, beginTurnCore, finishTurn, finishTurnCore, readSnapshotUnit } from "./proactive-snapshot.ts";

const config = parseProactiveConfig({ version: 1, mode: "shadow", include: ["src/**", "docs/**"] });
const remoteConfig = parseProactiveConfig({ version: 1, mode: "shadow", remoteContext: "selected-excerpts", include: ["src/**", "docs/**"] });
const context = { task: { path: "task", revision: "1", hash: "taskhash" }, rules: [], exceptions: ["explicit user exception"] };
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }); }
function temporaryDirectory(t: Pick<TestContext, "after">, prefix: string) {
 const root = mkdtempSync(join(tmpdir(), prefix));
 // Register before Git/setup work: assertion failures and setup errors also clean up.
 t.after(() => rmSync(root, { recursive: true, force: true }));
 return root;
}
function fixture(t: Pick<TestContext, "after">) {
 const root = temporaryDirectory(t, "proactive-snapshot-");
 git(root, "init", "-q"); git(root, "config", "user.email", "snapshot@example.test"); git(root, "config", "user.name", "Test");
 mkdirSync(join(root, "src")); mkdirSync(join(root, "docs"));
 writeFileSync(join(root, "src", "clean.ts"), "clean\n"); writeFileSync(join(root, "src", "dirty.ts"), "tracked\n");
 writeFileSync(join(root, ".gitignore"), "docs/ignored.md\n");
 git(root, "add", "."); git(root, "commit", "-qm", "initial"); return root;
}
test("missing/off does not inspect source, git or text", async () => {
 const off = parseProactiveConfig({ version: 1, mode: "off" });
 assert.equal(await beginTurn({ root: "/nonexistent", config: off, context, turnId: "1" }), null);
 assert.equal(await finishTurn(null, { assistantText: "sentinel" }), null);
});
test("actual dirty staged and untracked baseline, revert, deletion, shell edit and immutable readback", async t => {
 const root = fixture(t);
 writeFileSync(join(root, "src/dirty.ts"), "staged\n"); git(root, "add", "src/dirty.ts");
 writeFileSync(join(root, "src/dirty.ts"), "before dirty\n");
 writeFileSync(join(root, "src/untracked.ts"), "before untracked\n");
 const index = git(root, "diff", "--cached");
 const b = await beginTurn({ root, config, context, turnId: "session:owner:attempt:1" })!;
 writeFileSync(join(root, "src/dirty.ts"), "tracked\n");
 writeFileSync(join(root, "src/untracked.ts"), "after untracked\n");
 unlinkSync(join(root, "src/clean.ts"));
 const s = await finishTurn(b, { assistantText: "authored text" })!;
 assert.equal(s.status, "complete"); assert.equal(s.planStatus, "task_only");
 assert.equal(s.units.find(u => u.path === "src/dirty.ts")?.before?.text, "before dirty\n");
 assert.equal(s.units.find(u => u.path === "src/dirty.ts")?.after?.text, "tracked\n");
 assert.equal(s.units.find(u => u.path === "src/untracked.ts")?.before?.text, "before untracked\n");
 assert.equal(s.units.find(u => u.path === "src/clean.ts")?.kind, "deleted");
 assert.ok(!s.units.some(u => u.kind === "text"));
 assert.equal(git(root, "diff", "--cached"), index);
 const unit = s.units.find(u => u.path === "src/dirty.ts")!;
 writeFileSync(join(root, "src/dirty.ts"), "later revision\n");
 assert.equal(readSnapshotUnit(s, s.snapshotId, unit.id, unit.before!.hash), "before dirty\n");
 assert.equal(readSnapshotUnit(s, s.snapshotId, unit.id, "bad hash"), null);
 assert.equal(unit.attribution, "uncertain");
});
test("snapshot reads stay inside the physical root when the root path is a symlink", async t => {
 const realRoot = fixture(t);
 const alias = join(tmpdir(), `proactive-snapshot-alias-${process.pid}-${Date.now()}`);
 symlinkSync(realRoot, alias);
 t.after(() => unlinkSync(alias));
 const baseline = await beginTurn({ root: alias, config, context, turnId: "symlink-root" });
 writeFileSync(join(alias, "src/dirty.ts"), "changed through alias\n");
 const snapshot = await finishTurn(baseline);
 assert.equal(snapshot?.status, "complete");
 assert.equal(snapshot?.units.find(unit => unit.path === "src/dirty.ts")?.after?.text, "changed through alias\n");
});

test("default disabled remote context drops assistant text without failing local checks", async t => {
 const root = fixture(t);
 assert.equal(config.remoteContext, "disabled");
 const b = await beginTurn({ root, config, context, turnId: "privacy" });
 const sentinel = "PRIVATE_ASSISTANT_SENTINEL";
 for (const snapshot of [await finishTurn(b, { assistantText: sentinel }), finishTurnCore(b, { assistantText: sentinel })]) {
  assert.equal(snapshot?.status, "complete");
  assert.ok(!snapshot?.units.some(u => u.kind === "text"));
  assert.ok(!JSON.stringify(snapshot).includes(sentinel));
 }
});
test("explicit selected-excerpts permits assistant text", async t => {
 const root = fixture(t);
 const b = await beginTurn({ root, config: remoteConfig, context, turnId: "authorized-text" });
 const s = await finishTurn(b, { assistantText: "authorized authored text" });
 assert.equal(s?.status, "complete");
 assert.equal(s?.units.find(u => u.kind === "text")?.after?.text, "authorized authored text");
});
test("known ignored deliverable, rename pair, bound plan and overlap are explicit", async t => {
 const root = fixture(t); writeFileSync(join(root, "docs/ignored.md"), "before\n");
 const b = await beginTurn({ root, config, context: { ...context, plan: { path: "plan", revision: "p1", hash: "old" } }, turnId: "t2", knownTargets: ["docs/ignored.md"] })!;
 git(root, "mv", "src/clean.ts", "src/moved.ts");
 writeFileSync(join(root, "docs/ignored.md"), "after\n");
 const s = await finishTurn(b, { knownTargets: ["docs/ignored.md"], overlap: true })!;
 assert.equal(s.planStatus, "bound"); assert.equal(s.status, "partial");
 assert.ok(s.gaps.includes("concurrent_writer_attribution_uncertain"));
 assert.equal(s.units.find(u => u.path === "docs/ignored.md")?.before?.text, "before\n");
 assert.equal(s.units.find(u => u.path === "src/clean.ts")?.kind, "deleted");
 assert.equal(s.units.find(u => u.path === "src/moved.ts")?.kind, "added");
});
test("forbidden names, symlinks, huge files and HEAD replacement remain uncovered", async t => {
 const root = fixture(t);
 writeFileSync(join(root, "src/.env"), "secret");
 writeFileSync(join(root, "src/huge.ts"), "x".repeat(70_000));
 symlinkSync(join(root, ".git/config"), join(root, "src/escape.ts"));
 const b = await beginTurn({ root, config, context, turnId: "t3" })!;
 writeFileSync(join(root, "src/clean.ts"), "changed\n");
 git(root, "commit", "--allow-empty", "-qm", "head changed");
 const s = await finishTurn(b)!;
 assert.equal(s.status, "partial"); assert.ok(s.gaps.includes("head_changed"));
 assert.ok(s.gaps.includes("oversized_or_nonfile"));
 assert.ok(s.gaps.includes("symlink"));
 assert.ok(!s.units.some(x => x.path.includes(".env") || x.path.includes("escape.ts")));
 assert.ok(!JSON.stringify(s).includes("secret"));
});
test("new untracked and pre-existing unchanged dirty content are distinguished", async t => {
 const root = fixture(t); writeFileSync(join(root, "src/dirty.ts"), "already dirty\n");
 const b = await beginTurn({ root, config, context, turnId: "new-file" })!;
 writeFileSync(join(root, "src/new.ts"), "new file\n");
 const s = await finishTurn(b)!;
 assert.deepEqual(s.units.map(u => u.path), ["src/new.ts"]);
 assert.equal(s.units[0]?.kind, "added");
});
test("missing dirty baseline is never replaced with HEAD bytes", async t => {
 const root = fixture(t); writeFileSync(join(root, "src/dirty.ts"), "before dirty\n");
 let calls = 0;
 const b = beginTurnCore({ root, config, context, turnId: "dirty-timeout", now: () => ++calls >= 6 ? 2000 : 0 })!;
 assert.ok(b.initialPaths.has("src/dirty.ts"));
 assert.ok(!b.dirty.has("src/dirty.ts"));
 writeFileSync(join(root, "src/dirty.ts"), "after\n");
 const s = await finishTurn(b)!;
 assert.equal(s.status, "partial");
 assert.ok(s.gaps.some(g => g.includes("missing_baseline")));
 assert.ok(!s.units.some(u => u.path === "src/dirty.ts"));
});
test("failed HEAD blob read cannot turn a tracked edit into complete added evidence", async t => {
 const root = fixture(t); const b = await beginTurn({ root, config, context, turnId: "lost-blob" })!;
 const blob = git(root, "rev-parse", "HEAD:src/clean.ts").trim();
 unlinkSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
 writeFileSync(join(root, "src/clean.ts"), "changed\n");
 const s = await finishTurn(b)!;
 assert.equal(s.status, "partial");
 assert.ok(s.gaps.includes("read_unavailable"));
 assert.ok(!s.units.some(u => u.path === "src/clean.ts"));
});
test("beginTurn git failure produces incomplete evidence rather than throwing", async () => {
 const b = beginTurnCore({ root: "/nonexistent", config, context, turnId: "git-failure" })!;
 const s = finishTurnCore(b, { assistantText: "still observed" })!;
 assert.equal(s.status, "partial");
 assert.ok(s.gaps.includes("git_unavailable"));
 assert.ok(!s.units.some(u => u.kind === "added" || u.kind === "modified" || u.kind === "text"));
 assert.ok(!JSON.stringify(s).includes("still observed"));
});
test("capture budget applies to git and file operations, including finish", async t => {
 const root = fixture(t); const b = await beginTurn({ root, config, context, turnId: "deadline" })!;
 writeFileSync(join(root, "src/clean.ts"), "changed\n");
 let calls = 0;
 const s = finishTurnCore(b, { now: () => ++calls >= 4 ? 2000 : 0 })!;
 assert.equal(s.status, "partial");
 assert.ok(s.gaps.includes("capture_timeout"));
 assert.ok(!s.units.some(u => u.path === "src/clean.ts"));
});
test("nested task, plan, rules and exceptions are immutable and detached", async t => {
 const root = fixture(t);
 const supplied = { task: { ...context.task }, plan: { path: "plan", revision: "one", hash: "planhash" }, rules: [{ path: "rule", revision: "one", hash: "rulehash" }], exceptions: ["permitted"] };
 const b = await beginTurn({ root, config, context: supplied, turnId: "bound" })!;
 supplied.task.revision = "changed"; supplied.rules[0]!.revision = "changed"; supplied.exceptions.push("forged");
 const s = await finishTurn(b)!;
 assert.equal(s.context.task.revision, "1");
 assert.equal(s.context.rules[0]?.revision, "one");
 assert.deepEqual(s.context.exceptions, ["permitted"]);
 assert.ok(Object.isFrozen(s.context.task) && Object.isFrozen(s.context.plan));
 assert.ok(Object.isFrozen(s.context.rules) && Object.isFrozen(s.context.rules[0]));
 assert.ok(Object.isFrozen(s.context.exceptions));
 assert.throws(() => { (s.context.task as { revision: string }).revision = "forged"; }, TypeError);
 assert.throws(() => { (s.context.exceptions as string[]).push("forged"); }, TypeError);
});
test("assistant text bounds and redaction do not become green", async t => {
 const root = fixture(t); const b = await beginTurn({ root, config: remoteConfig, context, turnId: "t4" })!;
 const s = await finishTurn(b, { assistantText: "token SENTINEL", secrets: ["SENTINEL"] })!;
 assert.equal(s.units[0]?.after?.text, "token [REDACTED]");
 const digest = (s: string) => createHash("sha256").update(s).digest("hex");
 assert.equal(s.units[0]?.after?.hash, digest("token [REDACTED]"));
 assert.notEqual(s.units[0]?.after?.hash, digest("token SENTINEL"));
 assert.ok(!JSON.stringify(s).includes(digest("token SENTINEL")));
 assert.equal((await finishTurn(b, { assistantText: "a".repeat(70_000) }))?.status, "partial");
 assert.equal(readFileSync(join(root, "src/clean.ts"), "utf8"), "clean\n");
});

test("zero-byte tracked deletion and addition remain distinct", async t => {
 const root = fixture(t); writeFileSync(join(root, "src/empty.ts"), ""); git(root, "add", "."); git(root, "commit", "-qm", "empty");
 const b = await beginTurn({ root, config, context, turnId: "zero" });
 unlinkSync(join(root, "src/empty.ts")); writeFileSync(join(root, "src/new-empty.ts"), "");
 const s = await finishTurn(b);
 assert.equal(s?.units.find(u => u.path === "src/empty.ts")?.kind, "deleted");
 assert.equal(s?.units.find(u => u.path === "src/new-empty.ts")?.kind, "added");
});

test("denied tracked credential is never passed to path-specific Git commands", async t => {
 const root = fixture(t); writeFileSync(join(root, "src/.env"), "SECRET"); git(root, "add", "-f", "src/.env"); git(root, "commit", "-qm", "credential");
 const b = await beginTurn({ root, config, context, turnId: "denied" });
 writeFileSync(join(root, "src/.env"), "OTHERSECRET");
 const s = await finishTurn(b);
 assert.ok(s?.gaps.includes("forbidden_path"));
 assert.ok(!JSON.stringify(s).includes("SECRET"));
 // Even if the object database is corrupt, the denied path must never trigger a blob lookup.
 const blob = git(root, "rev-parse", "HEAD:src/.env").trim();
 unlinkSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
 const again = await finishTurn(b);
 assert.ok(again?.gaps.includes("forbidden_path"));
 assert.ok(!again?.gaps.includes("read_unavailable"));
 // Log every Git argv in the child; neither ls-tree nor show may name the denied path.
 const fake = temporaryDirectory(t, "proactive-git-spy-");
 const log = join(fake, "argv");
 const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
 writeFileSync(join(fake, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PROACTIVE_GIT_LOG"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
 const oldPath = process.env.PATH;
 process.env.PATH = `${fake}:${oldPath}`;
 process.env.PROACTIVE_GIT_LOG = log;
 try { await finishTurn(b); }
 finally { process.env.PATH = oldPath; delete process.env.PROACTIVE_GIT_LOG; }
 assert.ok(!readFileSync(log, "utf8").includes("src/.env"));
});

test("gap codes never contain Git stderr, commands or absolute fixture paths", async t => {
 const root = fixture(t); const b = await beginTurn({ root, config, context, turnId: "gap" });
 const blob = git(root, "rev-parse", "HEAD:src/clean.ts").trim();
 unlinkSync(join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
 writeFileSync(join(root, "src/clean.ts"), "edited");
 const s = await finishTurn(b);
 assert.ok(s?.gaps.includes("read_unavailable"));
 assert.ok(s?.gaps.every(g => /^[a-z_]+(?::\d+)?$/.test(g)));
 assert.ok(!JSON.stringify(s?.gaps).includes(root));
});

test("mid-read mutation deterministically reports instability", t => {
 const root = fixture(t); const b = beginTurnCore({ root, config, context, turnId: "mutation" });
 writeFileSync(join(root, "src/clean.ts"), "initial\n");
 const s = finishTurnCore(b, { afterFirstRead: () => writeFileSync(join(root, "src/clean.ts"), "changed\n") });
 assert.equal(s?.status, "unstable_snapshot");
 assert.ok(s?.gaps.includes("unstable_snapshot"));
 assert.ok(!s?.units.some(u => u.path === "src/clean.ts"));
});

test("21st unit is omitted and baseline accumulation stops at 20", async t => {
 const root = fixture(t);
 for (let i = 0; i < 21; i++) writeFileSync(join(root, `src/item-${String(i).padStart(2, "0")}.ts`), "before");
 const b = await beginTurn({ root, config, context, turnId: "unit-cap" });
 assert.equal(b?.dirty.size, 20);
 assert.ok(b?.gaps.includes("baseline_limit"));
 for (let i = 0; i < 21; i++) writeFileSync(join(root, `src/item-${String(i).padStart(2, "0")}.ts`), "after");
 const s = await finishTurn(b);
 assert.equal(s?.status, "partial");
 assert.equal(s?.coverage.retainedUnits, 20);
 assert.equal(s?.coverage.omittedPaths, 1);
 assert.ok(s?.gaps.includes("omitted_paths:1"));
});

test("baseline byte cap and actual redacted retained bytes enforce 256 KiB plus one", async t => {
 const root = fixture(t);
 for (let i = 0; i < 5; i++) writeFileSync(join(root, `src/large-${i}.ts`), "a".repeat(65536));
 const b = await beginTurn({ root, config, context, turnId: "byte-cap" });
 assert.equal(b?.dirty.size, 4);
 assert.ok(b?.gaps.includes("baseline_limit"));
 for (let i = 0; i < 5; i++) writeFileSync(join(root, `src/large-${i}.ts`), "b".repeat(65536));
 const s = await finishTurn(b);
 assert.ok((s?.coverage.retainedBytes ?? 0) <= 256 * 1024);
 assert.equal(s?.status, "partial");
 const text = "é\nSENTINEL\n";
 const redacted = finishTurnCore(beginTurnCore({ root: fixture(t), config: remoteConfig, context, turnId: "coords" }), { assistantText: text, secrets: ["SENTINEL"] });
 const excerpt = redacted?.units.find(u => u.kind === "text")?.after;
 assert.equal(excerpt?.endOffset, Buffer.byteLength(text));
 assert.equal(excerpt?.endLine, 2);
 assert.equal(redacted?.coverage.retainedBytes, Buffer.byteLength("é\n[REDACTED]\n"));
});

test("exact 256 KiB retained then one additional byte is uncovered", t => {
 const root = fixture(t); const b = beginTurnCore({ root, config, context, turnId: "exact-byte" });
 for (let i = 0; i < 4; i++) writeFileSync(join(root, `src/exact-${i}.ts`), "x".repeat(65536));
 writeFileSync(join(root, "src/exact-4.ts"), "x");
 const s = finishTurnCore(b);
 assert.equal(s?.coverage.retainedBytes, 256 * 1024);
 assert.equal(s?.coverage.omittedPaths, 1);
 assert.equal(s?.status, "partial");
 assert.equal(s?.units.length, 4);
});

test("real slow Git is killed with its descendant at the wall deadline; late result is fenced", async t => {
 const root = fixture(t);
 const fake = temporaryDirectory(t, "proactive-git-wrapper-");
 const pidFile = join(fake, "git-child.pid");
 const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
 const script = join(fake, "git");
 writeFileSync(script, `#!/bin/sh\nif [ "$3" = status ]; then\n sleep 30 &\n echo $! > "$PROACTIVE_GIT_CHILD_PID"\n wait\nelse\n exec "${realGit}" "$@"\nfi\n`, { mode: 0o755 });
 const oldPath = process.env.PATH;
 process.env.PATH = `${fake}:${oldPath}`;
 process.env.PROACTIVE_GIT_CHILD_PID = pidFile;
 try {
  const started = Date.now();
  await assert.rejects(beginTurn({ root, config, context, turnId: "slow-git" }), /capture_timeout/);
  assert.ok(Date.now() - started < 2500, "wall deadline must not wait for Git");
  const pid = Number(readFileSync(pidFile, "utf8"));
  // A killed but not yet reaped process may briefly be visible as a zombie.
  const { existsSync } = await import("node:fs");
  const alive = () => existsSync(`/proc/${pid}/stat`) && !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  for (let i = 0; i < 30 && alive(); i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(alive(), false, "no live child Git descendant");
  await new Promise(r => setTimeout(r, 40)); // late IPC cannot settle a rejected capture
 } finally {
  process.env.PATH = oldPath;
  delete process.env.PROACTIVE_GIT_CHILD_PID;
 }
});


test("fixture teardown removes temporary repositories on success and setup failure", t => {
 const sandbox = temporaryDirectory(t, "proactive-cleanup-check-");
 const scratch = join(sandbox, "scratch"), fakeBin = join(sandbox, "bin");
 mkdirSync(scratch); mkdirSync(fakeBin);
 const file = new URL(import.meta.url);
 const args = ["--test", "--test-name-pattern=^actual dirty staged and untracked baseline", fileURLToPath(file)];
 const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
 delete env.NODE_TEST_CONTEXT;
 const success = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 30_000 });
 assert.equal(success.error, undefined);
 assert.equal(success.status, 0, success.stdout + success.stderr);
 assert.deepEqual(readdirSync(scratch), [], "successful test leaves no Git repository");
 // Force setup to fail after allocation, before git init can complete.
 writeFileSync(join(fakeBin, "git"), "#!/bin/sh\necho intentional-fixture-setup-failure >&2\nexit 73\n", { mode: 0o755 });
 const failure = spawnSync(process.execPath, args, { env: { ...env, PATH: `${fakeBin}:${env.PATH}` }, encoding: "utf8", timeout: 30_000 });
 assert.equal(failure.error, undefined);
 assert.equal(failure.status, 1, "child test must actually fail, not silently skip");
 assert.match(failure.stdout + failure.stderr, /intentional-fixture-setup-failure/);
 assert.deepEqual(readdirSync(scratch), [], "failed setup also leaves no Git repository");
});
