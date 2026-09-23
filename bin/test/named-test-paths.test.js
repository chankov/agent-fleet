import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { missingNamedTests } from "./helpers/assert-named-tests.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("F-17 a missing named test is not a pass when a sibling exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "af-named-tests-"));
  const present = join(dir, "present.test.js");
  const missing = join(dir, "missing.test.js");
  const helper = fileURLToPath(new URL("./helpers/assert-named-tests.js", import.meta.url));
  writeFileSync(present, "import test from 'node:test'; test('present ran', () => {});\n");
  assert.deepEqual(missingNamedTests([present, missing]), [missing]);
  const blocked = spawnSync(process.execPath, [helper, present, missing], { encoding: "utf8" });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /named tests missing/);
  assert.doesNotMatch(`${blocked.stdout}\n${blocked.stderr}`, /present ran/);
  const ran = spawnSync(process.execPath, [helper, present], { encoding: "utf8" });
  assert.equal(ran.status, 0);
  assert.match(`${ran.stdout}\n${ran.stderr}`, /present ran/);
  assert.match(`${ran.stdout}\n${ran.stderr}`, /pass 1/);
});

test("F-16 C4 mock scaffolding is outside the published harness copy-tree", () => {
  for (const published of [
    ".pi/harnesses/agent-hub/system1-c4-pi-ui.ts",
    ".pi/harnesses/agent-hub/system1-c4-pi-ui-state.ts",
    ".pi/harnesses/agent-hub/system1-c4-pi-ui.test.ts",
    ".pi/harnesses/agent-hub/system1-c4-mock-driver.test.ts",
  ]) assert.equal(existsSync(join(root, published)), false, published);
});

