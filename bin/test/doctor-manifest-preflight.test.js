import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { manifestPreflight } from "../lib/doctor.js";

const root = resolve(new URL("../..", import.meta.url).pathname);
const temp = (t) => { const dir = mkdtempSync(join(tmpdir(), "af-doctor-preflight-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test("manifest preflight distinguishes exact missing files, missing tools, and unavailable platforms", (t) => {
  const workspace = temp(t), sourceRoot = temp(t);
  const state = { agent: "pi", items: {
    "companion:runtime": { files: [{ path: ".pi/runtime/required.js" }] },
    "external:tool": { files: [] },
    "companion:darwin": { files: [{ path: ".pi/runtime/darwin.js" }] },
  } };
  const manifest = { packageVersion: "test", presets: { default: { items: [] } }, items: [
    { id: "companion:runtime", platform: "any", agents: { pi: { strategy: "copy-file", source: ["runtime.js"], target: ".pi/runtime/required.js" } } },
    { id: "external:tool", platform: "any", package: { manager: "npm", probe: "definitely-missing-agent-fleet-tool" }, agents: { pi: { strategy: "external", source: [], target: null } } },
    { id: "companion:darwin", platform: "darwin", agents: { pi: { strategy: "copy-file", source: ["darwin.js"], target: ".pi/runtime/darwin.js" } } },
  ] };
  const report = manifestPreflight({ workspace, sourceRoot, manifest, state, platform: "linux", pathValue: "" });
  assert.equal(report.status, "missing_install");
  assert.deepEqual(report.missingFiles, [".pi/runtime/required.js"]);
  assert.equal(report.tools[0].status, "missing");
  assert.deepEqual(report.unavailablePlatform, [{ itemId: "companion:darwin", status: "unavailable_platform", requiredPlatform: "darwin" }]);
  assert.deepEqual(report.remediation, ["agent-fleet doctor --fix", "agent-fleet setup --allow-exec --yes"]);
  const unknown = manifestPreflight({ workspace, sourceRoot, manifest, state, platform: "freebsd", pathValue: "" });
  assert.equal(unknown.unavailablePlatform[0].status, "unknown_platform");
});

test("doctor invocation reports the known incomplete-worktree fixture and never repairs it", (t) => {
  const workspace = temp(t), ai = join(workspace, ".ai"); mkdirSync(ai, { recursive: true });
  const fixture = join(root, "bin", "test", "fixtures", "agent-fleet-2.0.5", ".ai", "agent-fleet-state.json");
  cpSync(fixture, join(ai, "agent-fleet-state.json"));
  const before = readFileSync(join(ai, "agent-fleet-state.json"), "utf8");
  const result = spawnSync(process.execPath, [join(root, "bin", "cli.js"), "doctor", "--workspace", workspace, "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.preflight.schema, "agent-fleet.installation-preflight/v1");
  assert.equal(report.preflight.classification, "environment");
  assert.equal(report.preflight.status, "missing_install");
  assert.ok(report.preflight.missingFiles.length >= 90, `expected the known large missing-install fixture, got ${report.preflight.missingFiles.length}`);
  assert.ok(report.preflight.missingFiles.includes(".pi/harnesses/agent-hub/index.ts"));
  assert.deepEqual(report.preflight.remediation, ["agent-fleet doctor --fix"]);
  assert.equal(readFileSync(join(ai, "agent-fleet-state.json"), "utf8"), before);
  assert.equal(existsSync(join(workspace, ".pi", "harnesses", "agent-hub", "index.ts")), false, "bare doctor never installs or repairs");
});
