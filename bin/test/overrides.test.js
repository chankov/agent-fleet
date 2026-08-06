import test from "node:test";
import assert from "node:assert/strict";
import { mergeOverrides } from "../lib/overrides.js";
test("override merge preserves hand-written sections and has stable generated ordering", () => {
 const existing="# mine\n\n## agent-hub\nlanguage: English\nrules: old\n\n## custom\nkeep: me\n";
 const scan={rules:[".cursor/rules","rules"],docs:["README.md","docs"]};
 const first=mergeOverrides(existing,scan); const second=mergeOverrides(first,scan);
 assert.equal(first,second); assert.match(first,/language: English/); assert.match(first,/## custom\nkeep: me/); assert.match(first,/rules: \.cursor\/rules, rules/); assert.match(first,/docs: README.md, docs/);
});
test("empty scan does not create override keys",()=>assert.equal(mergeOverrides("",{rules:[],docs:[]}),""));
