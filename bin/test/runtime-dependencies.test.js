import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_DEPENDENCY_ROOTS,
  assertRuntimeDependencies,
  checkRuntimeDependencies,
  runtimeDependencyFindings,
} from "../../scripts/lib/runtime-dependencies.js";
import { runDoctor } from "../lib/doctor.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspace = () => mkdtempSync(join(tmpdir(), "af-runtime-deps-"));

function installRoot(ws, root, dependencies = { example: "1.0.0" }) {
  mkdirSync(join(ws, root, "node_modules"), { recursive: true });
  writeFileSync(join(ws, root, "package.json"), JSON.stringify({ private: true, dependencies }));
}

const healthyNpm = (_command, _args, _options) => ({ status: 0, stdout: "{}", stderr: "" });

test("runtime dependency check runs npm ls for all three installed roots", () => {
  const ws = workspace();
  try {
    for (const { root } of RUNTIME_DEPENDENCY_ROOTS) installRoot(ws, root);
    const calls = [];
    const report = checkRuntimeDependencies({
      workspace: ws,
      run(command, args, options) {
        calls.push({ command, args, cwd: options.cwd });
        return healthyNpm();
      },
    });
    assert.equal(report.healthy, true);
    assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
      ["npm", "ls", "--prefix", ".pi/extensions", "--depth=0", "--json"],
      ["npm", "ls", "--prefix", ".pi/harnesses", "--depth=0", "--json"],
      ["npm", "ls", "--prefix", "scripts", "--depth=0", "--json"],
    ]);
    assert.ok(calls.every((call) => call.cwd === ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("missing scripts/node_modules is launch-blocking with actionable remediation", () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, "scripts"), { recursive: true });
    writeFileSync(join(ws, "scripts", "package.json"), JSON.stringify({ dependencies: { yaml: "^2.9.0" } }));
    const report = checkRuntimeDependencies({ workspace: ws, run: healthyNpm });
    assert.equal(report.healthy, false);
    assert.equal(report.failures[0].root, "scripts");
    assert.match(report.failures[0].reason, /scripts\/node_modules is missing/);

    const findings = runtimeDependencyFindings({ workspace: ws, run: healthyNpm });
    assert.equal(findings[0].type, "runtime-dependencies");
    assert.equal(findings[0].path, "scripts/node_modules");
    assert.match(findings[0].fix, /just fleet deps/);
    assert.match(findings[0].fix, /setup --allow-exec/);

    assert.throws(
      () => assertRuntimeDependencies(ws, { run: healthyNpm }),
      (error) => {
        assert.equal(error.name, "RuntimeDependencyError");
        assert.match(error.message, /stopped before Pi startup/);
        assert.match(error.message, /just fleet deps/);
        assert.match(error.message, /setup --allow-exec/);
        return true;
      },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("npm ls problems identify an incomplete existing dependency tree", () => {
  const ws = workspace();
  try {
    installRoot(ws, ".pi/harnesses", { yaml: "^2.9.0" });
    const report = checkRuntimeDependencies({
      workspace: ws,
      run: () => ({
        status: 1,
        stdout: JSON.stringify({ problems: ["missing: yaml@^2.9.0, required by fixture@"] }),
        stderr: "npm log path must not be surfaced",
      }),
    });
    assert.equal(report.healthy, false);
    assert.match(report.failures[0].reason, /missing: yaml/);
    assert.doesNotMatch(report.failures[0].reason, /npm log path/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("doctor includes runtime dependency findings without auto-installing them", async () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, "scripts"), { recursive: true });
    writeFileSync(join(ws, "scripts", "package.json"), JSON.stringify({ dependencies: { yaml: "^2.9.0" } }));
    const findings = await runDoctor({
      workspace: ws,
      sourceRoot,
      checkVisibility: () => ({ models: [] }),
      checkDependencies: healthyNpm,
    });
    const dependency = findings.find((finding) => finding.type === "runtime-dependencies");
    assert.equal(dependency.path, "scripts/node_modules");
    assert.match(dependency.issue, /workflow runtime dependencies are incomplete/);

    const applied = await runDoctor({
      workspace: ws,
      sourceRoot,
      apply: true,
      checkVisibility: () => ({ models: [] }),
      checkDependencies: healthyNpm,
    });
    assert.equal(applied.repaired, 0);
    assert.equal(applied.deleted, 0);
    assert.ok(applied.findings.some((finding) => finding.type === "runtime-dependencies"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
