import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeOverrides, planOverrides } from "../lib/overrides.js";

const workspace = () => mkdtempSync(join(tmpdir(), "af-overrides-"));
test("override merge preserves hand-written sections and has stable generated ordering", () => {
 const existing="# mine\n\n## agent-hub\nlanguage: English\nrules: old\n\n## custom\nkeep: me\n";
 const scan={rules:[".cursor/rules","rules"],docs:["README.md","docs"]};
 const first=mergeOverrides(existing,scan); const second=mergeOverrides(first,scan);
 assert.equal(first,second); assert.match(first,/language: English/); assert.match(first,/## custom\nkeep: me/); assert.match(first,/rules: \.cursor\/rules, rules/); assert.match(first,/docs: README.md, docs/);
});
test("empty scan does not create override keys",()=>assert.equal(mergeOverrides("",{rules:[],docs:[]}),""));

test("planOverrides leaves an existing configured file byte-identical", (context) => {
 const ws = workspace();
 context.after(() => rmSync(ws, { recursive: true, force: true }));
 const original = "## agent-hub\nlanguage: Bulgarian\nmodel.builder: custom/model\ndocs: CUSTOM.md\n";
 mkdirSync(join(ws, ".ai"), { recursive: true });
 writeFileSync(join(ws, ".ai", "agent-fleet-overrides.md"), original);
 const plan = planOverrides(ws, { rules: ["rules"], docs: ["README.md", "docs"] });
 assert.equal(plan.write, false);
 assert.equal(plan.text, original);
});

test("planOverrides seeds missing or blank files only when generated text changes", (context) => {
 const missing = workspace();
 const blank = workspace();
 context.after(() => {
  rmSync(missing, { recursive: true, force: true });
  rmSync(blank, { recursive: true, force: true });
 });
 const scan = { rules: ["rules"], docs: ["README.md", "docs"] };
 const seeded = "## agent-hub\nrules: rules\ndocs: README.md, docs\n";
 assert.equal(existsSync(join(missing, ".ai", "agent-fleet-overrides.md")), false);
 assert.deepEqual(planOverrides(missing, scan), {
  path: join(missing, ".ai", "agent-fleet-overrides.md"), text: seeded, write: true,
 });
 mkdirSync(join(blank, ".ai"), { recursive: true });
 writeFileSync(join(blank, ".ai", "agent-fleet-overrides.md"), " \n\t");
 const blankPlan = planOverrides(blank, scan);
 assert.equal(blankPlan.path, join(blank, ".ai", "agent-fleet-overrides.md"));
 assert.equal(blankPlan.write, true);
 assert.match(blankPlan.text, /## agent-hub\nrules: rules\ndocs: README.md, docs\n$/);
 assert.deepEqual(planOverrides(blank, { rules: [], docs: [] }), {
  path: join(blank, ".ai", "agent-fleet-overrides.md"), text: " \n\t", write: false,
 });
});
