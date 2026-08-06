import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../lib/scan.js";
const ws = () => mkdtempSync(join(tmpdir(), "af-scan-"));
test("scan omits empty detections and orders bounded conventional paths", () => {
 const root=ws(); assert.deepEqual(scanProject(root), {rules:[],docs:[]});
 mkdirSync(join(root,"rules")); mkdirSync(join(root,".cursor/rules"),{recursive:true}); mkdirSync(join(root,"docs")); writeFileSync(join(root,"README.md"),"x");
 assert.deepEqual(scanProject(root), {rules:[".cursor/rules","rules"],docs:["README.md","docs"]});
});
