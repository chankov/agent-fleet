import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authorizePolicyPath, resolvePolicyRoots, resolveRuleBinding, resolvePolicyReferences } from "./policy-roots.ts";

function fixture(t: test.TestContext) {
 const base = mkdtempSync(join(tmpdir(), "fleet-policy-roots-"));
 t.after(() => rmSync(base, { recursive: true, force: true }));
 const checkout = join(base, "code"), docs = join(base, "docs");
 mkdirSync(join(checkout, ".ai/rules"), { recursive: true });
 mkdirSync(join(docs, ".ai/rules/docs"), { recursive: true });
 writeFileSync(join(docs, "README.md"), "docs");
 writeFileSync(join(docs, "other.md"), "other");
 writeFileSync(join(docs, ".ai/rules/docs/maintenance.md"), "# Policy\nKeep docs current.\n");
 return { base, checkout, docs };
}

test("checkout anchors external roots regardless of nested caller or worktree layout", t => {
 const { checkout, docs } = fixture(t);
 mkdirSync(join(checkout, "nested"));
 const table = resolvePolicyRoots(checkout, { rulesDirs: ["../docs/.ai/rules"], docsPaths: ["../docs"] });
 assert.equal(table.workspace, realpathSync(checkout));
 assert.equal(authorizePolicyPath(table, "../docs/README.md").path, join(docs, "README.md"));
 assert.equal(resolveRuleBinding(table, ".ai/rules/docs/maintenance.md").path, join(docs, ".ai/rules/docs/maintenance.md"));
 assert.deepEqual(table.diagnostics.map(d => d.code), ["overlapping_roots"]);
 assert.throws(() => authorizePolicyPath(table, "../ungranted/file.md"), /ungranted/);
 assert.throws(() => authorizePolicyPath(table, ".."), /ungranted/);
});

test("worktree grants are relative to that worktree rather than the primary repository", t => {
 const { checkout, base } = fixture(t);
 const worktree = join(base, "worktrees/feature");
 mkdirSync(worktree, { recursive: true });
 mkdirSync(join(base, "worktrees/docs"));
 writeFileSync(join(base, "worktrees/docs/README.md"), "worktree docs");
 const table = resolvePolicyRoots(worktree, { docsPaths: ["../docs"] });
 assert.equal(authorizePolicyPath(table, "../docs/README.md").path, join(base, "worktrees/docs/README.md"));
 assert.throws(() => authorizePolicyPath(table, join(base, "docs/README.md")), /ungranted/);
 assert.notEqual(table.workspace, checkout);
});

test("child references canonicalize only explicit external grants and preserve local references", t => {
 const {checkout,docs}=fixture(t);
 const table=resolvePolicyRoots(checkout,{rulesDirs:["../docs/.ai/rules"],docsPaths:["../docs/README.md"]});
 assert.deepEqual(resolvePolicyReferences(table,[".ai/rules","../docs/.ai/rules"],"rules"),[".ai/rules",join(docs,".ai/rules")]);
 assert.deepEqual(resolvePolicyReferences(table,["../docs/README.md"],"docs"),[join(docs,"README.md")]);
 assert.throws(()=>resolvePolicyReferences(table,["../docs/other.md"],"docs"),/ungranted/);
});

test("exact-file grants do not authorize siblings or parent inventory", t => {
 const { checkout, docs } = fixture(t);
 const table = resolvePolicyRoots(checkout, { docsPaths: ["../docs/README.md"] });
 assert.equal(authorizePolicyPath(table, "../docs/README.md").path, join(docs, "README.md"));
 assert.throws(() => authorizePolicyPath(table, "../docs/other.md"), /ungranted/);
 assert.throws(() => authorizePolicyPath(table, "../docs"), /ungranted/);
 assert.throws(() => authorizePolicyPath(table, "../docs/README.md", "inventory"), /directory/);
});

test("missing, duplicate, overlapping and unsafe grants have deterministic diagnostics", t => {
 const { checkout, docs } = fixture(t);
 const table = resolvePolicyRoots(checkout, { rulesDirs: ["../docs/.ai/rules", "../docs/.ai/rules", "../docs/README.md"], docsPaths: ["../missing", "../docs", "../docs/README.md", "..", docs] });
 assert.deepEqual(table.diagnostics.map(d => d.code), ["duplicate_root", "invalid_root_type", "missing_root", "overlapping_roots", "overlapping_roots", "unsafe_root", "invalid_root"]);
 assert.equal(table.roots.filter(r => r.role === "rules").length, 1);
});

test("local paths and local legacy rule bindings remain available", t => {
 const { checkout } = fixture(t);
 writeFileSync(join(checkout, "README.md"), "local");
 writeFileSync(join(checkout, ".ai/rules/local.md"), "local rule");
 const table = resolvePolicyRoots(checkout, {});
 assert.equal(authorizePolicyPath(table, "README.md").root.role, "workspace");
 assert.equal(resolveRuleBinding(table, ".ai/rules/local.md").path, join(checkout, ".ai/rules/local.md"));
 assert.throws(() => resolveRuleBinding(table, ".ai/rules/missing.md"), /missing_binding/);
 assert.throws(() => resolveRuleBinding(table, ".ai/rules/../README.md"), /invalid_binding/);
});

test("multiple rule candidates and local/external collisions never select by ordering", t => {
 const { checkout, docs, base } = fixture(t);
 mkdirSync(join(base, "rules2/docs"), { recursive: true });
 writeFileSync(join(base, "rules2/docs/maintenance.md"), "different");
 const external = resolvePolicyRoots(checkout, { rulesDirs: ["../docs/.ai/rules", "../rules2"] });
 assert.throws(() => resolveRuleBinding(external, ".ai/rules/docs/maintenance.md"), /ambiguous_binding/);
 mkdirSync(join(checkout, ".ai/rules/docs"));
 writeFileSync(join(checkout, ".ai/rules/docs/maintenance.md"), "local");
 assert.throws(() => resolveRuleBinding(resolvePolicyRoots(checkout, { rulesDirs: ["../docs/.ai/rules"] }), ".ai/rules/docs/maintenance.md"), /ambiguous_binding/);
 assert.equal(realpathSync(docs), docs);
});

test("denied secret/generated segments stay denied even through symlink aliases", t => {
 const { checkout, docs } = fixture(t);
 for (const name of [".env", "credentials", "secrets", ".git", ".pi", "node_modules", "vendor", "dist", "build", "coverage"]) {
  mkdirSync(join(docs, name));
  writeFileSync(join(docs, name, "content.md"), "private");
 }
 symlinkSync(join(docs, "secrets"), join(docs, "alias"));
 const table = resolvePolicyRoots(checkout, { docsPaths: ["../docs"] });
 for (const name of [".env", "credentials", "secrets", ".git", ".pi", "node_modules", "vendor", "dist", "build", "coverage", "alias"]) {
  assert.throws(() => authorizePolicyPath(table, `../docs/${name}/content.md`), /denied_path/);
 }
 assert.equal(resolvePolicyRoots(checkout, { docsPaths: ["../docs/alias"] }).diagnostics[0]?.code, "denied_path");
});

test("explicit symlink roots are admitted but descendant escapes and root swaps are refused", t => {
 const { checkout, docs, base } = fixture(t);
 symlinkSync(docs, join(base, "linked-docs"));
 symlinkSync(join(checkout, ".ai"), join(docs, "escape"));
 const table = resolvePolicyRoots(checkout, { docsPaths: ["../linked-docs"] });
 assert.equal(authorizePolicyPath(table, "../linked-docs/README.md").path, join(docs, "README.md"));
 assert.throws(() => authorizePolicyPath(table, "../linked-docs/escape/rules"), /canonical_escape/);
 unlinkSync(join(base, "linked-docs"));
 symlinkSync(checkout, join(base, "linked-docs"));
 assert.throws(() => authorizePolicyPath(table, "../linked-docs/README.md"), /root_changed/);
});

test("exact-file grant refuses replacement by a symlink to a neighboring file", t => {
 const { checkout, docs } = fixture(t);
 const table = resolvePolicyRoots(checkout, { docsPaths: ["../docs/README.md"] });
 unlinkSync(join(docs, "README.md"));
 symlinkSync(join(docs, "other.md"), join(docs, "README.md"));
 assert.throws(() => authorizePolicyPath(table, "../docs/README.md"), /root_changed/);
});

test("replacing an admitted real directory with a link cannot widen the grant", t => {
 const { checkout, docs, base } = fixture(t);
 const table = resolvePolicyRoots(checkout, { docsPaths: ["../docs"] });
 renameSync(docs, join(base, "old-docs"));
 symlinkSync(checkout, docs);
 assert.throws(() => authorizePolicyPath(table, "../docs/README.md"), /root_changed/);
});
