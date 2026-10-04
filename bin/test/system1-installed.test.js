// Installed-package proof for System 1: real tarball, copied workspace, zero-network skips.
import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { collectModelTargets } from "../lib/doctor.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACK_MAX_BUFFER = 64 * 1024 * 1024;
const SYSTEM1_RUNTIME = [
  "config.js", "config-v2.js", "config-proactive.js", "config-triage.js", "config-json.js", "config-loader.js",
  "selection.js",
  "contracts.ts",
  "demo.ts",
  "jev.ts",
  "service.ts",
];

function fakePiListingScript() {
  const models = [...new Set(collectModelTargets(root).map((target) => target.model).filter(Boolean))];
  const rows = ["provider model", ...models.map((id) => {
    const slash = id.indexOf("/");
    return `${id.slice(0, slash)} ${id.slice(slash + 1)}`;
  })];
  return `#!/usr/bin/env sh\ncat <<'EOF'\n${rows.join("\n")}\nEOF\n`;
}

function materializeRuntimeDependencies(workspace) {
  for (const dependencyRoot of [".pi/extensions", ".pi/harnesses", ".pi/agent-fleet/scripts"]) {
    const runtimePackage = JSON.parse(readFileSync(join(workspace, dependencyRoot, "package.json"), "utf8"));
    for (const dependency of Object.keys(runtimePackage.dependencies ?? {})) {
      const target = join(workspace, dependencyRoot, "node_modules", dependency);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, "node_modules", dependency), target, { recursive: true });
    }
  }
}

// This test process may spawn the packaged demo. Scrub any ambient live credential
// once for the whole file so a future --live regression cannot contact the provider.
delete process.env.TYPESAFE_API_KEY;

function runDemo(workspace, extraArgs = [], extraEnv = {}) {
  const demo = join(workspace, ".pi", "harnesses", "lib", "system1", "demo.ts");
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
  }
  const result = spawnSync(process.execPath, [
    "--import",
    join(root, "bin/test/helpers/system1-no-network.js"),
    "--experimental-strip-types",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    demo,
    ...extraArgs,
  ], {
    cwd: workspace,
    encoding: "utf8",
    env,
  });
  return result;
}

function findNode18() {
  const candidates = [process.env.AF_NODE18, "node18", "nodejs18", process.execPath];
  const nvmRoot = process.env.NVM_DIR || join(homedir(), ".nvm");
  const versionsRoot = join(nvmRoot, "versions", "node");
  if (existsSync(versionsRoot)) {
    for (const version of readdirSync(versionsRoot).filter((name) => /^v18\./.test(name)).sort().reverse()) {
      candidates.push(join(versionsRoot, version, "bin", "node"));
    }
  }
  for (const bin of candidates) {
    if (!bin) continue;
    const version = spawnSync(bin, ["-v"], { encoding: "utf8" });
    if (version.status === 0 && /^v18\./.test(version.stdout.trim())) return bin;
  }
  return null;
}

test("extracted tarball installs System 1 workspaces without publishing tests", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "af-system1-installed-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", fixture], { cwd: root, encoding: "utf8", maxBuffer: PACK_MAX_BUFFER }));
    const tarball = join(fixture, packed[0].filename);
    const extracted = join(fixture, "node_modules", "@chankov", "agent-fleet");
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", extracted]);

    const hubRoot = join(extracted, ".pi", "harnesses", "agent-hub");
    for (const file of ["drift-runtime.ts", "drift-system1.ts", "drift-judge.ts", "drift-system1-policy.ts", "system1-activity.ts", "system1-runtime.ts", "system1-report.ts", "watchdog-evaluation.ts", "dispatch-triage-contract.ts", "dispatch-triage-state.ts", "dispatch-triage-policy.ts", "dispatch-triage-runtime.ts", "dispatch-triage-eval.ts", "system1-communication-store.ts", "ui/system1-communication.ts", "tools/dispatch-triage.ts"]) {
      assert.ok(existsSync(join(hubRoot, file)), `packed watchdog runtime missing ${file}`);
      assert.equal(existsSync(join(hubRoot, file.replace(/\.ts$/, ".test.ts"))), false);
    }
    // Node's built-in type stripper refuses TS inside node_modules. Exercise the
    // extracted package's copies at the same non-node_modules path setup installs.
    const installedHarnesses = join(fixture, "installed-workspace", ".pi", "harnesses");
    cpSync(join(extracted, ".pi", "harnesses"), installedHarnesses, { recursive: true });
    const installedHub = join(installedHarnesses, "agent-hub");
    const closure = spawnSync(process.execPath, ["--experimental-strip-types", "--import", join(root, "bin/test/helpers/system1-no-network.js"), "--input-type=module", "-e",
      `await import(${JSON.stringify(new URL(`file://${join(installedHub, "dispatch-triage-eval.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "system1-communication-store.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "drift-judge.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "system1-runtime.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "system1-activity.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "system1-report.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHub, "watchdog-evaluation.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHarnesses, "lib", "fleet-read-model.ts")}`).href)}); await import(${JSON.stringify(new URL(`file://${join(installedHarnesses, "lib", "fleet-strip-view.ts")}`).href)});`
    ], { cwd: join(fixture, "installed-workspace"), encoding: "utf8" });
    assert.equal(closure.status, 0, closure.stderr);
    const system1Root = join(extracted, ".pi", "harnesses", "lib", "system1");
    for (const file of SYSTEM1_RUNTIME) {
      assert.ok(existsSync(join(system1Root, file)), `packed runtime missing ${file}`);
    }
    assert.equal(existsSync(join(system1Root, "config.test.js")), false);
    assert.equal(existsSync(join(system1Root, "demo.test.ts")), false);
    assert.equal(existsSync(join(system1Root, "jev.test.ts")), false);
    assert.equal(existsSync(join(system1Root, "service.test.ts")), false);
    assert.equal(existsSync(join(system1Root, "fake-provider.test.ts")), false);
    assert.equal(existsSync(join(extracted, ".pi", "harnesses", "agent-hub", "system1-c4-pi-ui.ts")), false);
    assert.equal(existsSync(join(extracted, ".pi", "harnesses", "agent-hub", "system1-c4-pi-ui-state.ts")), false);
    assert.equal(existsSync(join(extracted, "bin", "test", "helpers", "system1-c4-pi-ui.ts")), false);

    const configSource = readFileSync(join(system1Root, "config.js"), "utf8");
    assert.match(configSource, /export function resolveSystem1Readiness/);
    for (const rel of ["contracts.ts", "demo.ts", "jev.ts", "service.ts"]) {
      const text = readFileSync(join(system1Root, rel), "utf8");
      const imports = [...text.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
      for (const spec of imports) {
        const resolved = join(system1Root, spec);
        assert.ok(existsSync(resolved), `${rel} import missing from tarball: ${spec}`);
      }
    }

    const fakeBin = join(fixture, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "pi"), fakePiListingScript());
    chmodSync(join(fakeBin, "pi"), 0o755);
    const doctorEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
    const cli = join(extracted, "bin", "cli.js");

    const defaultWs = join(fixture, "default");
    mkdirSync(defaultWs);
    execFileSync(process.execPath, [cli, "setup", "--workspace", defaultWs, "--preset", "default", "--features", "none", "--yes"], { encoding: "utf8" });
    materializeRuntimeDependencies(defaultWs);
    const defaultDesired = JSON.parse(readFileSync(join(defaultWs, ".ai", "agent-fleet.json"), "utf8"));
    assert.notEqual(defaultDesired.features?.system1, true);
    assert.equal(existsSync(join(defaultWs, ".ai", "system1.json")), false);
    const defaultDemo = runDemo(defaultWs);
    assert.equal(defaultDemo.status, 0, defaultDemo.stderr);
    const defaultReport = JSON.parse(defaultDemo.stdout);
    assert.equal(defaultReport.mode, "offline");
    assert.equal(defaultReport.status, "skipped");
    assert.equal(defaultReport.reason, "disabled");

    const fullWs = join(fixture, "full");
    mkdirSync(fullWs);
    execFileSync(process.execPath, [cli, "setup", "--workspace", fullWs, "--preset", "full", "--features", "none", "--yes"], { encoding: "utf8" });
    materializeRuntimeDependencies(fullWs);
    const fullDesired = JSON.parse(readFileSync(join(fullWs, ".ai", "agent-fleet.json"), "utf8"));
    assert.notEqual(fullDesired.features?.system1, true);
    const fullDemo = runDemo(fullWs);
    assert.equal(fullDemo.status, 0, fullDemo.stderr);
    assert.equal(JSON.parse(fullDemo.stdout).reason, "disabled");

    const system1Ws = join(fixture, "system1");
    mkdirSync(system1Ws);
    const humanConfigText = `${JSON.stringify({
      version: 2,
      consumers: {},
      mode: "auto",
      provider: "typesafe",
      model: "jev-1.13.0",
      apiKeyEnv: "TYPESAFE_API_KEY",
    }, null, 2)}\n`;
    mkdirSync(join(system1Ws, ".ai"), { recursive: true });
    writeFileSync(join(system1Ws, ".ai", "system1.json"), humanConfigText);
    execFileSync(process.execPath, [cli, "setup", "--workspace", system1Ws, "--preset", "default", "--features", "system1", "--yes"], { encoding: "utf8" });
    materializeRuntimeDependencies(system1Ws);
    assert.equal(readFileSync(join(system1Ws, ".ai", "system1.json"), "utf8"), humanConfigText);
    const selected = JSON.parse(readFileSync(join(system1Ws, ".ai", "agent-fleet.json"), "utf8"));
    assert.equal(selected.features.system1, true);

    const second = JSON.parse(execFileSync(process.execPath, [cli, "setup", "--workspace", system1Ws, "--dry-run", "--json"], { encoding: "utf8" }));
    assert.equal(second.summary.changes, 0);

    assert.equal(process.env.TYPESAFE_API_KEY, undefined, "installed smoke process scrubs ambient live credentials");
    const missingKeyDemo = runDemo(system1Ws, ["--live"]);
    assert.equal(missingKeyDemo.status, 0, missingKeyDemo.stderr);
    const missingKeyReport = JSON.parse(missingKeyDemo.stdout);
    assert.equal(missingKeyReport.mode, "live");
    assert.equal(missingKeyReport.status, "skipped");
    assert.equal(missingKeyReport.reason, "missing_key");

    const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "--workspace", system1Ws, "--json"], {
      encoding: "utf8",
      env: { ...doctorEnv, TYPESAFE_API_KEY: "" },
    }));
    const system1Finding = doctor.findings.find((finding) => finding.type === "system1");
    assert.ok(system1Finding);
    assert.equal(system1Finding.readiness, "missing_key");

    const triageWs = join(fixture, "task-triage");
    mkdirSync(triageWs);
    execFileSync(process.execPath, [cli, "setup", "--workspace", triageWs, "--preset", "default", "--features", "none", "--yes"], { encoding: "utf8" });
    assert.equal(existsSync(join(triageWs, ".ai/task-triage.json")), false);
    const triagePreview = JSON.parse(execFileSync(process.execPath, [cli, "setup", "--workspace", triageWs,
      "--preset", "default", "--features", "system1-task-triage", "--dry-run", "--json"], { encoding: "utf8" }));
    assert.equal(triagePreview.taskTriage.write, true);
    assert.equal(triagePreview.taskTriageProvider.write, false);
    const noConsent = spawnSync(process.execPath, [cli, "setup", "--workspace", triageWs, "--preset", "default",
      "--features", "system1-task-triage", "--yes"], { encoding: "utf8" });
    assert.equal(noConsent.status, 1);
    assert.match(noConsent.stderr, /--task-triage-consent/);
    assert.equal(existsSync(join(triageWs, ".ai/task-triage.json")), false);
    execFileSync(process.execPath, [cli, "setup", "--workspace", triageWs, "--preset", "default",
      "--features", "system1-task-triage", "--task-triage-consent", "--yes"], { encoding: "utf8" });
    const triageConfigPath = join(triageWs, ".ai/system1.json");
    const humanTriage = readFileSync(triageConfigPath, "utf8");
    assert.equal(JSON.parse(humanTriage).consumers.taskTriage.remoteContextApproved, true);
    assert.equal(JSON.parse(readFileSync(join(triageWs, ".ai/system1.json"), "utf8")).mode, "auto");
    assert.equal(JSON.parse(readFileSync(join(triageWs, ".ai/agent-fleet-state.json"), "utf8")).taskTriageSelected, true);
    assert.ok(existsSync(join(triageWs, ".pi/harnesses/agent-hub/task-triage-config.ts")), "installed runtime closure contains the consumer config gate");
    const installedConfigUrl = new URL(`file://${join(triageWs, ".pi/harnesses/agent-hub/task-triage-config.ts")}`).href;
    const runtimeStatus = () => spawnSync(process.execPath, ["--import", join(root, "bin/test/helpers/system1-no-network.js"),
      "--experimental-strip-types", "--input-type=module", "-e",
      `const mod = await import(${JSON.stringify(installedConfigUrl)}); process.stdout.write(mod.loadTaskTriageConfig(process.cwd()).status);`],
    { cwd: triageWs, encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "synthetic-test-only-key", PI_OFFLINE: "1" } });
    const enabled = runtimeStatus();
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(enabled.stdout, "active", "installed code sees explicit experimental consent");
    materializeRuntimeDependencies(triageWs);
    const triageDoctorText = execFileSync(process.execPath, [cli, "doctor", "--workspace", triageWs, "--json"], {
      encoding: "utf8", env: { ...doctorEnv, TYPESAFE_API_KEY: "synthetic-test-only-key" },
    });
    assert.equal(triageDoctorText.includes("synthetic-test-only-key"), false);
    const triageDoctor = JSON.parse(triageDoctorText).findings.find(f => f.type === "task-triage");
    assert.equal(triageDoctor.readiness, "missing_local_producer", "installed Default lacks a planner even with a locally ready provider");
    assert.ok(triageDoctor.missingLocalProducers.includes("planner"));
    assert.match(triageDoctor.fix, /\/af-agents-add planner/);
    execFileSync(process.execPath, [cli, "setup", "--workspace", triageWs, "--preset", "default", "--features", "none", "--yes"], { encoding: "utf8" });
    assert.equal(readFileSync(triageConfigPath, "utf8"), humanTriage, "disable preserves the human config");
    const disabled = runtimeStatus();
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stdout, "off", "installed runtime obeys the applied feature switch");

    const node18 = findNode18();
    await t.test('packaged digest-bound migration runs on Node 18 without TypeScript or inference', { skip: node18 ? false : 'Node 18 binary not on PATH' }, () => {
      const migrationWs = join(fixture, 'migration-node18');
      mkdirSync(join(migrationWs, '.ai'), { recursive: true });
      writeFileSync(join(migrationWs, '.ai/system1.json'), JSON.stringify({ version: 1, mode: 'off', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' }));
      writeFileSync(join(migrationWs, '.ai/proactive-review.json'), '{"version":1,"mode":"shadow","include":["src/**"]}');
      writeFileSync(join(migrationWs, '.ai/agent-fleet-overrides.md'), '## Agent-Team\nWatchdog-System1: shadow\n');
      const args = [cli, 'setup', '--workspace', migrationWs, '--migrate-system1-config'];
      const env = { PI_OFFLINE: '1', NODE_OPTIONS: `--import=${join(root, 'bin/test/helpers/system1-no-network.js')}` };
      const preview = spawnSync(node18, [...args, '--dry-run'], { encoding: 'utf8', env });
      assert.equal(preview.status, 0, preview.stderr);
      const digest = JSON.parse(preview.stdout).digest;
      const applied = spawnSync(node18, [...args, '--yes', '--expect-digest', digest], { encoding: 'utf8', env });
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(JSON.parse(applied.stdout).result.status, 'migrated');
      const saved = JSON.parse(readFileSync(join(migrationWs, '.ai/system1.json'), 'utf8'));
      assert.equal(saved.version, 2); assert.equal(saved.mode, 'off');
      assert.equal(saved.consumers.watchdog.mode, 'shadow');
      assert.equal(saved.consumers.proactiveReview.mode, 'shadow');
      assert.equal(existsSync(join(migrationWs, '.ai/proactive-review.json')), false);
    });
    await t.test("packaged doctor runs on Node 18", { skip: node18 ? false : "Node 18 binary not on PATH" }, () => {
      const doctor18 = spawnSync(node18, [cli, "doctor", "--workspace", system1Ws, "--json"], {
        encoding: "utf8",
        env: { ...doctorEnv, TYPESAFE_API_KEY: "" },
      });
      assert.equal(doctor18.status, 0, doctor18.stderr);
      const report18 = JSON.parse(doctor18.stdout);
      assert.ok(report18.findings.some((finding) => finding.type === "system1" && finding.readiness === "missing_key"));
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
