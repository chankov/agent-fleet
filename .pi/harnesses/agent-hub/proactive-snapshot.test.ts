import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { externalChangedPaths, identifyExternalGit } from "./proactive-external-git.ts";
import { loadProactiveConfig, parseProactiveConfig } from "./proactive-config.ts";
import { loadSystem1Snapshot, readSystem1Selected } from "../lib/system1/config-loader.js";
import { resolvePolicyRoots } from "../lib/policy-roots.ts";
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
test("independent Git status enumerates only explicitly consented scopes", t => {
 const root = fixture(t);
 writeFileSync(join(root, "src/dirty.ts"), "approved edit\n");
 writeFileSync(join(root, "docs/private.md"), "unapproved edit\n");
 const source = identifyExternalGit(root, join(root, ".."), () => {})!;
 const paths = externalChangedPaths(source, () => {}, [join(root, "src/dirty.ts")]);
 assert.deepEqual(paths, [join(root, "src/dirty.ts")]);
});

test("independent Git status never refreshes the source repository index", t => {
 const root = fixture(t), source = identifyExternalGit(root, join(root, ".."), () => {})!;
 const before = readFileSync(join(root, ".git/index"));
 writeFileSync(join(root, "src/clean.ts"), "clean\n");
 utimesSync(join(root, "src/clean.ts"), new Date(0), new Date(0));
 externalChangedPaths(source, () => {}, [join(root, "src")]);
 assert.deepEqual(readFileSync(join(root, ".git/index")), before);
});

test("non-Git parent captures only consented scopes in two nested repositories against their own HEAD", async t => {
 const root = temporaryDirectory(t, "parent-workspace-");
 const app = join(root, "ringithub"), docs = join(root, "rin-docs");
 for (const repo of [app, docs]) {
  mkdirSync(repo);
  git(repo, "init", "-q"); git(repo, "config", "user.email", "snapshot@example.test"); git(repo, "config", "user.name", "Test");
  mkdirSync(join(repo, "allowed"));
  writeFileSync(join(repo, "allowed/edit.md"), "committed PRIVATE\n");
  writeFileSync(join(repo, "allowed/deleted.md"), "deleted HEAD\n");
  writeFileSync(join(repo, "private.md"), "UNGRANTED_SENTINEL\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
  writeFileSync(join(repo, "allowed/edit.md"), "pre-session\n");
  unlinkSync(join(repo, "allowed/deleted.md"));
  writeFileSync(join(repo, "allowed/prior.md"), "pre-session addition\n");
  writeFileSync(join(repo, "allowed/.env"), "SECRET_SENTINEL\n");
  mkdirSync(join(repo, "allowed/node_modules"));
  writeFileSync(join(repo, "allowed/node_modules/generated.md"), "GENERATED_SENTINEL\n");
 }
 mkdirSync(join(root, ".ai"));
 writeFileSync(join(root, ".ai/system1.json"), JSON.stringify({ version: 2, mode: "off", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY", consumers: { proactiveReview: { mode: "shadow", include: ["ringithub/allowed/**", "rin-docs/allowed", "rin-docs/allowed/edit.md"] } } }));
 writeFileSync(join(root, ".ai/agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default", features: { system1: true } }));
 const roots = resolvePolicyRoots(root, { docsPaths: ["rin-docs/allowed", "rin-docs/allowed/edit.md"] });
 assert.equal(readSystem1Selected(root), true);
 const cfg = loadProactiveConfig(root, loadSystem1Snapshot(root), roots);
 const baseline = await beginTurn({ root, config: cfg, context, turnId: "parent", policyRoots: roots });
 for (const repo of [app, docs]) {
  writeFileSync(join(repo, "allowed/edit.md"), "session PRIVATE\n");
  writeFileSync(join(repo, "allowed/new.md"), "session addition\n");
 }
 const result = await finishTurn(baseline, { secrets: ["PRIVATE"] });
 assert.equal(result?.status, "complete", JSON.stringify(result?.gaps));
 assert.equal(result?.units.length, 8);
 assert.ok(result?.observedPaths! >= result?.units.length!);
 assert.equal(new Set(result?.units.map(u => u.path)).size, 8);
 for (const prefix of ["ringithub", "rin-docs"]) {
  assert.equal(result?.units.find(u => u.path === `${prefix}/allowed/edit.md`)?.before?.text, "committed [REDACTED]\n");
  assert.equal(result?.units.find(u => u.path === `${prefix}/allowed/edit.md`)?.after?.text, "session [REDACTED]\n");
  assert.equal(result?.units.find(u => u.path === `${prefix}/allowed/deleted.md`)?.kind, "deleted");
  assert.equal(result?.units.find(u => u.path === `${prefix}/allowed/prior.md`)?.kind, "added");
  assert.ok(result?.units.filter(u => u.path.startsWith(prefix + "/")).every(u => !!u.sourceRootId));
 }
 assert.ok(!JSON.stringify(result).includes("SENTINEL"));
 const docsOnly = parseProactiveConfig({ version: 1, mode: "shadow", include: ["rin-docs/allowed"] }, roots);
 const limited = finishTurnCore(beginTurnCore({ root, config: docsOnly, context, turnId: "docs-only", policyRoots: roots }));
 assert.ok(limited?.units.every(u => u.path.startsWith("rin-docs/")));
 git(app, "commit", "--allow-empty", "-qm", "new HEAD");
 assert.ok(finishTurnCore(baseline)?.gaps.includes("external_head_changed"));
});

test("parent Git capture budgets changed evidence, not the entire clean nested checkout", t => {
 const root = temporaryDirectory(t, "parent-large-clean-"), repo = join(root, "ringithub");
 mkdirSync(repo); git(repo, "init", "-q"); git(repo, "config", "user.email", "snapshot@example.test"); git(repo, "config", "user.name", "Test");
 mkdirSync(join(repo, "src"));
 for (let i = 0; i < 40; i++) writeFileSync(join(repo, `src/file-${i}.ts`), "clean\n");
 git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
 writeFileSync(join(repo, "src/file-1.ts"), "pre-session\n");
 const roots = resolvePolicyRoots(root, {});
 const cfg = parseProactiveConfig({ version: 1, mode: "shadow", include: ["ringithub/src/**"] }, roots);
 const baseline = beginTurnCore({ root, config: cfg, context, turnId: "large-clean", policyRoots: roots });
 writeFileSync(join(repo, "src/file-2.ts"), "session edit\n");
 const result = finishTurnCore(baseline);
 assert.equal(result?.status, "complete", JSON.stringify(result?.gaps));
 assert.equal(result?.units.length, 2);
 assert.ok(result?.units.every(u => u.before?.text === "clean\n"));
 // Reverted dirty files must not be misreported as deletions.
 writeFileSync(join(repo, "src/file-1.ts"), "clean\n");
 const reverted = finishTurnCore(baseline);
 assert.equal(reverted?.units.length, 1);
 assert.equal(reverted?.units[0]?.path, "ringithub/src/file-2.ts");
 unlinkSync(join(repo, "src/file-3.ts"));
 const exact = parseProactiveConfig({ version: 1, mode: "shadow", include: ["ringithub/src/file-3.ts"] }, roots);
 const deleted = finishTurnCore(beginTurnCore({ root, config: exact, context, turnId: "exact-deleted", policyRoots: roots }));
 assert.equal(deleted?.status, "complete", JSON.stringify(deleted?.gaps));
 assert.equal(deleted?.units[0]?.kind, "deleted");
 assert.equal(deleted?.units[0]?.before?.text, "clean\n");
});

test("parent capture keeps missing history, unbounded scopes, budgets and escaping sources incomplete", t => {
 const root = temporaryDirectory(t, "parent-gaps-"), repo = join(root, "ringithub");
 mkdirSync(repo); git(repo, "init", "-q"); git(repo, "config", "user.email", "snapshot@example.test"); git(repo, "config", "user.name", "Test");
 mkdirSync(join(repo, "src"));
 writeFileSync(join(repo, "src/edit.ts"), "HEAD\n");
 git(repo, "add", "."); git(repo, "commit", "-qm", "initial");
 const roots = resolvePolicyRoots(root, {});
 const capture = (include: string[]) => {
  const cfg = parseProactiveConfig({ version: 1, mode: "shadow", include }, roots);
  return finishTurnCore(beginTurnCore({ root, config: cfg, context, turnId: "gaps", policyRoots: roots }));
 };
 writeFileSync(join(repo, "src/edit.ts"), "changed\n");
 const glob = capture(["ringithub/src/*.ts"]);
 assert.equal(glob?.status, "complete", JSON.stringify(glob?.gaps));
 assert.equal(glob?.units[0]?.path, "ringithub/src/edit.ts");
 mkdirSync(join(root, "unversioned")); writeFileSync(join(root, "unversioned/doc.md"), "no history\n");
 const missing = capture(["ringithub/src/**", "unversioned/**"]);
 assert.equal(missing?.status, "partial");
 assert.ok(missing?.gaps.includes("external_history_unavailable"));
 assert.equal(capture(["**/*.ts"])?.status, "partial");
 symlinkSync(join(repo, "src"), join(root, "alias"));
 const alias = capture(["alias/**"]);
 assert.equal(alias?.status, "partial");
 assert.equal(alias?.units.length, 0);
 symlinkSync(join(root, "unversioned/doc.md"), join(repo, "src/escape.ts"));
 const escaped = capture(["ringithub/src/**"]);
 assert.equal(escaped?.status, "partial");
 assert.ok(escaped?.gaps.includes("external_evidence_unavailable"));
 assert.ok(!escaped?.units.some(u => u.path.endsWith("escape.ts")));
 unlinkSync(join(repo, "src/escape.ts"));
 for (let i = 0; i < 21; i++) writeFileSync(join(repo, `src/new-${i}.ts`), "added\n");
 const bounded = capture(["ringithub/src/**"]);
 assert.equal(bounded?.status, "partial");
 assert.ok(bounded?.gaps.includes("external_capture_limit"));
 assert.ok(bounded?.units.length! <= 20);
});

test("external non-Git content captures session edits only, with consent, redaction and immutable evidence", async t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-docs-");
 writeFileSync(join(docs,"README.md"),"before PRIVATE\n");
 writeFileSync(join(docs,".env"),"DO_NOT_CAPTURE");
 symlinkSync(root,join(docs,"escape"));
 const external=relative(root,docs).split(sep).join("/");
 const roots=resolvePolicyRoots(root,{docsPaths:[external]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:["docs/**",external]},roots);
 const baseline=await beginTurn({root,config:cfg,context,turnId:"external",policyRoots:roots});
 writeFileSync(join(docs,"README.md"),"after PRIVATE\n"); writeFileSync(join(docs,"new.md"),"new\n");
 const result=await finishTurn(baseline,{secrets:["PRIVATE"]});
 const unit=result?.units.find(u=>u.path===`${external}/README.md`)!;
 assert.equal(unit.before?.text,"before [REDACTED]\n");
 assert.equal(unit.after?.text,"after [REDACTED]\n");
 assert.equal(unit.sourceRootId,roots.roots[1]!.id);
 assert.equal(result?.units.find(u=>u.path===`${external}/new.md`)?.kind,"added");
 assert.ok(result?.gaps.includes("external_history_unavailable"));
 assert.ok(!JSON.stringify(result).includes("DO_NOT_CAPTURE"));
 assert.ok(!result?.units.some(u=>u.path.includes("escape")));
 assert.ok(!result?.gaps.includes("external_evidence_unavailable"));
 writeFileSync(join(docs,"README.md"),"later\n");
 assert.equal(readSnapshotUnit(result!,result!.snapshotId,unit.id,unit.after!.hash),"after [REDACTED]\n");
});

test("external independent Git worktree reviews dirty baseline, session edits and deletions without checkout extraction", async t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-docs-git-");
 git(docs,"init","-q"); git(docs,"config","user.email","snapshot@example.test"); git(docs,"config","user.name","Test");
 writeFileSync(join(docs,"README.md"),"committed\n");writeFileSync(join(docs,"gone.md"),"remove\n");
 git(docs,"add",".");git(docs,"commit","-qm","docs");
 writeFileSync(join(docs,"README.md"),"dirty before\n");
 const external=relative(root,docs).split(sep).join("/"), roots=resolvePolicyRoots(root,{docsPaths:[external]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:[external]},roots);
 const baseline=beginTurnCore({root,config:cfg,context,turnId:"external-git",policyRoots:roots});
 writeFileSync(join(docs,"README.md"),"after\n");unlinkSync(join(docs,"gone.md"));
 const result=finishTurnCore(baseline);
 assert.equal(result?.status,"complete",JSON.stringify(result?.gaps));
 assert.ok(!result?.gaps.includes("external_prior_edits_not_reviewed"));
 assert.equal(result?.units.find(u=>u.path===`${external}/README.md`)?.before?.text,"committed\n");
 assert.equal(result?.units.find(u=>u.path===`${external}/gone.md`)?.kind,"deleted");
 assert.ok(result?.units.every(u=>u.sourceRootId===roots.roots[1]!.id));
});

test("external Git history includes pre-session edits and deletions but never ungranted siblings", async t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-history-");
 git(docs,"init","-q");git(docs,"config","user.email","snapshot@example.test");git(docs,"config","user.name","Test");
 mkdirSync(join(docs,"allowed"));
 writeFileSync(join(docs,"allowed/edit.md"),"HEAD before\n");
 writeFileSync(join(docs,"allowed/deleted.md"),"HEAD deleted\n");
 writeFileSync(join(docs,"private.md"),"PRIVATE_HEAD_SENTINEL\n");
 git(docs,"add",".");git(docs,"commit","-qm","initial external");
 writeFileSync(join(docs,"allowed/edit.md"),"prior edit\n");unlinkSync(join(docs,"allowed/deleted.md"));
 writeFileSync(join(docs,"allowed/untracked.md"),"prior untracked\n");
 writeFileSync(join(docs,"private.md"),"PRIVATE_AFTER_SENTINEL\n");
 const external=relative(root,docs).split(sep).join("/"), include=`${external}/allowed`;
 const roots=resolvePolicyRoots(root,{docsPaths:[include]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:[include]},roots);
 const baseline=await beginTurn({root,config:cfg,context,turnId:"prior-history",policyRoots:roots});
 const result=await finishTurn(baseline);
 assert.equal(result?.status,"complete",JSON.stringify(result?.gaps));
 assert.equal(result?.units.find(u=>u.path===`${include}/edit.md`)?.before?.text,"HEAD before\n");
 assert.equal(result?.units.find(u=>u.path===`${include}/edit.md`)?.after?.text,"prior edit\n");
 assert.equal(result?.units.find(u=>u.path===`${include}/deleted.md`)?.kind,"deleted");
 assert.equal(result?.units.find(u=>u.path===`${include}/untracked.md`)?.kind,"added");
 assert.equal(result?.units.find(u=>u.path===`${include}/untracked.md`)?.after?.text,"prior untracked\n");
 assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
 git(docs,"add",".");git(docs,"commit","-qm","changed external HEAD");
 const changed=finishTurnCore(baseline);
 assert.ok(changed?.gaps.includes("external_head_changed"));
 assert.equal(changed?.status,"partial");
});

test("external HEAD budgets and tracked symlinks fail closed without importing outside bytes", t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-head-safety-");
 git(docs,"init","-q");git(docs,"config","user.email","snapshot@example.test");git(docs,"config","user.name","Test");
 writeFileSync(join(docs,"large.md"),"x".repeat(64*1024+1));
 git(docs,"add",".");git(docs,"commit","-qm","oversized HEAD");
 const external=relative(root,docs).split(sep).join("/"), roots=resolvePolicyRoots(root,{docsPaths:[external]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:[external]},roots);
 const baseline=beginTurnCore({root,config:cfg,context,turnId:"head-limit",policyRoots:roots});
 assert.ok(baseline?.gaps.includes("external_capture_limit"));
 assert.equal(finishTurnCore(baseline)?.status,"partial");
 unlinkSync(join(docs,"large.md"));symlinkSync(join(root,"src/dirty.ts"),join(docs,"linked.md"));
 git(docs,"add",".");git(docs,"commit","-qm","symlink HEAD");
 const unsafe=beginTurnCore({root,config:cfg,context,turnId:"head-link",policyRoots:roots});
 assert.ok(unsafe?.gaps.includes("external_evidence_unavailable"));
 assert.equal(unsafe?.external?.headFiles.size,0);
});

test("external snapshot exact-file consent never captures neighbors and missing roots report gaps", async t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-exact-");
 writeFileSync(join(docs,"README.md"),"before\n");writeFileSync(join(docs,"neighbor.md"),"NEIGHBOR_SENTINEL");
 const external=relative(root,docs).split(sep).join("/"), path=`${external}/README.md`;
 const roots=resolvePolicyRoots(root,{docsPaths:[path]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:[path]},roots);
 const baseline=beginTurnCore({root,config:cfg,context,turnId:"external-file",policyRoots:roots});
 writeFileSync(join(docs,"README.md"),"changed\n");
 const result=finishTurnCore(baseline);
 assert.equal(result?.units.length,1);
 assert.ok(!JSON.stringify(baseline).includes("NEIGHBOR_SENTINEL"));
 rmSync(docs,{recursive:true,force:true});
 const missing=finishTurnCore(baseline);
 assert.equal(missing?.status,"partial");
 assert.ok(missing?.gaps.includes("external_evidence_unavailable"));
});

test("external capture limits cannot turn omitted files or root replacement into complete evidence", t => {
 const root=fixture(t), docs=temporaryDirectory(t,"external-limits-");
 const external=relative(root,docs).split(sep).join("/"), roots=resolvePolicyRoots(root,{docsPaths:[external]});
 const cfg=parseProactiveConfig({version:1,mode:"shadow",include:[external]},roots);
 for(let i=0;i<22;i++) writeFileSync(join(docs,`${String(i).padStart(2,"0")}.md`),"before\n");
 const baseline=beginTurnCore({root,config:cfg,context,turnId:"external-limit",policyRoots:roots});
 assert.ok(baseline?.external?.files.size!<=20);
 assert.ok(baseline?.gaps.includes("external_capture_limit"));
 writeFileSync(join(docs,"21.md"),"after\n");
 const result=finishTurnCore(baseline);
 assert.equal(result?.status,"partial");
 assert.ok(result?.units.length!<=20);
 rmSync(docs,{recursive:true,force:true});symlinkSync(root,docs);
 const swapped=finishTurnCore(baseline);
 assert.ok(swapped?.gaps.includes("external_evidence_unavailable"));
 assert.equal(swapped?.units.length,0);
});

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
  // ps works on Linux and macOS; a killed but not reaped child may be a zombie.
  // Avoid a separate existence check followed by a racing /proc read.
  const alive = () => {
   const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
   return result.status === 0 && !result.stdout.trim().startsWith("Z");
  };
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
