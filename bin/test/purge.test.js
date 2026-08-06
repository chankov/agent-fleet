import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeHumanConfig } from "../lib/purge.js";
test("purge preserves human config unless explicitly requested", () => {
 const root=mkdtempSync(join(tmpdir(),"af-purge-")); mkdirSync(join(root,".ai")); writeFileSync(join(root,".ai","agent-fleet.json"),"{}");
 assert.deepEqual(purgeHumanConfig(root), { removed: [], preserved: [".ai/agent-fleet.json"] }); assert.ok(existsSync(join(root,".ai","agent-fleet.json")));
 assert.deepEqual(purgeHumanConfig(root,{purgeConfig:true}), { removed:[".ai/agent-fleet.json"], preserved:[] });
});
