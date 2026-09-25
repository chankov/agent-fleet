import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRules } from "./proactive-rules.ts";
function fixture(run: (root: string, rules: string) => void) {
 const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "rules-p3-")), rules = join(root, ".ai/rules");
 mkdirSync(rules, { recursive: true });
 try { run(root, rules); } finally { rmSync(root, { recursive: true, force: true }); }
}
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
