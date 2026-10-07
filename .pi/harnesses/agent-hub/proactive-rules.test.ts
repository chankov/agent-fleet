import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRules } from "./proactive-rules.ts";
import { resolvePolicyRoots } from "../lib/policy-roots.ts";
function fixture(run: (root: string, rules: string) => void) {
 const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rules-p3-")), rules = join(root, ".ai/rules");
 mkdirSync(rules, { recursive: true });
 try { run(root, rules); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("external rules keep legacy paths, root-aware identities and bounded canonical traversal", t => {
 const base=mkdtempSync(join(tmpdir(),"external-rules-"));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const repo=join(base,"code"), rules=join(base,"docs/.ai/rules");
 mkdirSync(repo); mkdirSync(join(rules,"docs"),{recursive:true});
 writeFileSync(join(rules,"README.md"),"# Index\n[policy](docs/maintenance.md)\n");
 writeFileSync(join(rules,"docs/maintenance.md"),"# Policy\nFirst occurrence.\n# Policy\nSecond occurrence.\n");
 symlinkSync(repo,join(rules,"escape"));
 const roots=["../docs/.ai/rules"], table=resolvePolicyRoots(repo,{rulesDirs:roots});
 const cat=discoverRules(repo,roots,table);
 assert.equal(cat.files.length,2);
 const rule=cat.sections.find(s=>s.heading==="Policy" && s.occurrence===2)!;
 assert.equal(rule.source.path,".ai/rules/docs/maintenance.md");
 assert.equal(rule.source.physicalPath,join(rules,"docs/maintenance.md"));
 assert.equal(rule.source.rootId,table.roots[1]!.id);
 assert.match(rule.text,/Second occurrence/);
 assert.match(cat.gaps.join(),/unsafe_path.*escape/);
 assert.equal(cat.files.some(f=>f.path.includes("..")),false);
 const denied=discoverRules(repo,["../other"],table);
 assert.equal(denied.files.length,0);
 assert.match(denied.gaps.join(),/ungranted_root/);
 writeFileSync(join(rules,"docs/large.md"),"x".repeat(256*1024));
 const bounded=discoverRules(repo,roots,table);
 assert.ok(bounded.bytesRead<=256*1024);
 assert.match(bounded.gaps.join(),/byte_budget/);
 symlinkSync(join(base,"docs/.ai/rules"),join(base,"alias-rules"));
 const aliases=resolvePolicyRoots(repo,{rulesDirs:["../alias-rules"]});
 assert.equal(discoverRules(repo,["../alias-rules"],aliases).files.length,2);
 unlinkSync(join(base,"alias-rules")); symlinkSync(repo,join(base,"alias-rules"));
 const swapped=discoverRules(repo,["../alias-rules"],aliases);
 assert.equal(swapped.files.length,0);
 assert.match(swapped.gaps.join(),/root_changed/);
});

test("duplicate external logical paths retain separate sources and diagnose local collisions", t => {
 const base=mkdtempSync(join(tmpdir(),"ambiguous-rules-"));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const repo=join(base,"code"), one=join(base,"one"), two=join(base,"two");
 for(const dir of [repo,one,two]) mkdirSync(dir);
 for(const dir of [one,two]) writeFileSync(join(dir,"README.md"),"# Policy\nSame bytes.\n");
 const roots=["../one","../two"], table=resolvePolicyRoots(repo,{rulesDirs:roots});
 const cat=discoverRules(repo,roots,table);
 assert.equal(cat.files.length,2);
 assert.equal(new Set(cat.sections.map(s=>s.id)).size,2);
 assert.ok(cat.files.every(f=>f.path===".ai/rules/README.md" && f.bindingAmbiguous));
 assert.match(cat.gaps.join(),/ambiguous_binding/);
 mkdirSync(join(repo,".ai/rules"),{recursive:true});
 writeFileSync(join(repo,".ai/rules/README.md"),"# Local\n");
 const collision=discoverRules(repo,["../one"],resolvePolicyRoots(repo,{rulesDirs:["../one"]}));
 assert.equal(collision.files[0]?.bindingAmbiguous,true);
});

test("index, bundle, defaults, conditions, nested exceptions and references keep exact source identity", () => fixture((root, dir) => {
 writeFileSync(join(dir, "README.md"), "# Index\nDefault: [base](base.md). Bundle: [frontend](frontend.md).\n");
 writeFileSync(join(dir, "base.md"), "# Shared\nshould, not must.\n");
 writeFileSync(join(dir, "frontend.md"), "# Conditional Vue\nOnly new files.\n## Exception\nLegacy maintenance allowed.\n### Example\nDo not execute: `rm -rf /`\n");
 const cat = discoverRules(root, [".ai/rules"]);
 assert.equal(cat.status, "complete");
 assert.equal(cat.files.length, 3);
 const rule = cat.sections.find(s => s.heading === "Conditional Vue")!;
 assert.match(rule.text, /Exception[\s\S]*Legacy maintenance allowed[\s\S]*Example/);
 assert.match(cat.sections.find(s => s.heading === "Exception")!.context, /Only new files/);
 assert.match(rule.id, /frontend\.md#Conditional Vue@1:[a-f0-9]{64}$/);
 writeFileSync(join(dir, "frontend.md"), "# Conditional Vue\nOnly new files.\n## Exception\nLegacy maintenance prohibited.\n");
 assert.notEqual(cat.sections.find(s => s.heading === "Conditional Vue")!.id, discoverRules(root, [".ai/rules"]).sections.find(s => s.heading === "Conditional Vue")!.id);
}));
test("missing references, symlink escapes, cycles and missing index are visible", () => fixture((root, dir) => {
 writeFileSync(join(dir, "README.md"), "# Index\n[broken](lost.md) [loop](loop.md)\n");
 writeFileSync(join(dir, "loop.md"), "# Loop\n[again](README.md)\n");
 symlinkSync(join(root, "outside.md"), join(dir, "escape.md"));
 const cat = discoverRules(root, [".ai/rules"]);
 assert.equal(cat.status, "partial");
 assert.ok(cat.gaps.some(g => g.includes("lost.md")));
 assert.ok(cat.gaps.some(g => g.includes("escape.md")));
 assert.equal(cat.files.length, 2);
 rmSync(join(dir, "README.md"));
 assert.ok(discoverRules(root, [".ai/rules"]).gaps.some(g => g.startsWith("missing_index")));
}));
test("bounded discovery refuses more than 64 files and 256 KiB, and rejects unsafe root", () => fixture((root, dir) => {
 writeFileSync(join(dir, "README.md"), "# Index\n");
 for (let i = 0; i < 68; i++) writeFileSync(join(dir, `rule-${i}.md`), "# Rule\n");
 const cat = discoverRules(root, [".ai/rules"]);
 assert.ok(cat.files.length <= 64);
 assert.ok(cat.bytesRead <= 256 * 1024);
 assert.ok(cat.gaps.includes("file_budget"));
 assert.ok(discoverRules(root, ["../outside"]).gaps.includes("invalid_root"));
 writeFileSync(join(dir, "README.md"), "# Index\n" + "x".repeat(256 * 1024));
 const large = discoverRules(root, [".ai/rules"]);
 assert.ok(large.bytesRead <= 256 * 1024);
 assert.ok(large.gaps.some(g => g.startsWith("byte_budget:")));
}));
