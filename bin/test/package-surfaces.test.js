// Package and deterministic lifecycle runtime-closure checks.
// This test exercises the manifest's
// copy/symlink/removal semantics against fixtures so its closure cannot drift.

import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { extractRegion } from "../lib/merge-forms.js";
import { collectModelTargets } from "../lib/doctor.js";
import { buildManifest } from "../lib/manifest.js";
import { assertPiSkillDiscovery } from "./helpers/pi-skill-discovery.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// `npm pack --json` lists every shipped file — over 8,000 of them, since each
// release adds a `.versions/<x.y.z>/` snapshot. The listing passed Node's 1 MiB
// spawn default at 2.0.8, so give it room that a few hundred releases cannot use up.
const PACK_MAX_BUFFER = 64 * 1024 * 1024;

function fakePiListingScript() {
  const models = [...new Set(collectModelTargets(root).map((target) => target.model).filter(Boolean))];
  const rows = ["provider model", ...models.map((id) => {
    const slash = id.indexOf("/");
    return `${id.slice(0, slash)} ${id.slice(slash + 1)}`;
  })];
  return `#!/bin/sh\ncat <<'EOF'\n${rows.join("\n")}\nEOF\n`;
}
const manifestPath = join(root, "bin", "catalog", "harness-runtime-closure.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function relativePath(value) {
  assert.equal(typeof value, "string");
  assert.notEqual(value, "");
  assert.equal(value.startsWith("/"), false, value);
  assert.equal(value.split("/").includes(".."), false, value);
  return value;
}

function manifestPaths(value = manifest) {
  assert.equal(value.version, 1);
  assert.ok(Array.isArray(value.directories));
  assert.ok(Array.isArray(value.files));
  return {
    directories: value.directories.map(relativePath),
    files: value.files.map(relativePath),
  };
}

function validateManifest(source, value = manifest) {
  const paths = manifestPaths(value);
  for (const rel of [...paths.directories, ...paths.files]) {
    assert.ok(existsSync(join(source, rel)), `manifest source missing: ${rel}`);
  }
  return paths;
}

function managedRegion(contents) {
  const start = contents.indexOf("# >>> agent-fleet:harnesses");
  const end = contents.indexOf("# <<< agent-fleet:harnesses <<<");
  assert.ok(start >= 0 && end >= start, "source justfile lacks managed sentinels");
  return contents.slice(start, end + "# <<< agent-fleet:harnesses <<<".length);
}

function writeManagedJustfile(source, target) {
  const sourceRegion = managedRegion(readFileSync(source, "utf8"));
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source, "utf8"));
    return;
  }
  const existing = readFileSync(target, "utf8");
  const start = existing.indexOf("# >>> agent-fleet:harnesses");
  const endMarker = "# <<< agent-fleet:harnesses <<<";
  const end = existing.indexOf(endMarker);
  assert.ok(start >= 0 && end >= start, "target justfile with user content must retain managed sentinels");
  writeFileSync(target, `${existing.slice(0, start)}${sourceRegion}${existing.slice(end + endMarker.length)}`);
}

function installClosure(source, workspace, method) {
  const paths = validateManifest(source);
  const owned = new Set([...paths.directories, ...paths.files]);
  for (const rel of paths.directories) {
    const src = join(source, rel);
    const dest = join(workspace, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (method === "symlink") symlinkSync(src, dest, "dir");
    else cpSync(src, dest, { recursive: true });
  }
  for (const rel of paths.files) {
    const src = join(source, rel);
    const dest = join(workspace, rel);
    if (rel === "justfile") {
      writeManagedJustfile(src, dest);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (method === "symlink") symlinkSync(src, dest, "file");
    else cpSync(src, dest);
  }
  return owned;
}

function removeSourceTree(source, target) {
  if (!existsSync(target)) return;
  if (!lstatSync(source).isDirectory()) {
    rmSync(target, { force: true });
    return;
  }
  // `cpSync` copied the source tree. Remove only source-named entries so an
  // unrecorded file placed in the target directory remains user-owned.
  for (const entry of readdirSync(source)) removeSourceTree(join(source, entry), join(target, entry));
  try { rmdirSync(target); } catch { /* non-empty user directory remains */ }
}

function removeClosure(source, workspace, owned) {
  const paths = manifestPaths();
  for (const rel of paths.files) {
    if (!owned.has(rel)) continue;
    const target = join(workspace, rel);
    if (rel === "justfile" && existsSync(target)) {
      const existing = readFileSync(target, "utf8");
      const start = existing.indexOf("# >>> agent-fleet:harnesses");
      const marker = "# <<< agent-fleet:harnesses <<<";
      const end = existing.indexOf(marker);
      if (start >= 0 && end >= start) writeFileSync(target, `${existing.slice(0, start)}${existing.slice(end + marker.length)}`);
    } else rmSync(target, { force: true });
  }
  for (const rel of [...paths.directories].reverse()) {
    if (!owned.has(rel)) continue;
    const sourcePath = join(source, rel);
    const target = join(workspace, rel);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) rmSync(target, { recursive: true, force: true });
    else removeSourceTree(sourcePath, target);
  }
}

test("manifest contains the executable harness runtime closure without product docs", () => {
  const paths = validateManifest(root);
  assert.deepEqual(paths.directories, [".pi/agent-fleet/hermes/skills"]);
  assert.equal(paths.files.some((path) => path.startsWith(".pi/agent-fleet/scripts/workflows/") && path.includes(".test.")), false);
  assert.equal([...paths.directories, ...paths.files].some((path) => path.startsWith(".pi/agent-fleet/hermes/desktop-plugins/") || path.startsWith(".pi/agent-fleet/hermes/plugins/")), false);
  assert.equal([...paths.directories, ...paths.files].some((path) => path === "codex" || path.startsWith("docs/")), false);
  for (const required of [
    "justfile",
    ".pi/agent-fleet/scripts/coms-cli.ts",
    ".pi/agent-fleet/scripts/coms-hermes-bridge.ts",
    ".pi/agent-fleet/scripts/flow.ts",
    ".pi/agent-fleet/scripts/workflows/lib/agent-phase.ts",
    ".pi/agent-fleet/scripts/workflows/lib/scout-data-boundary.ts",
    ".pi/agent-fleet/scripts/workflows/wf-scout.ts",
    ".pi/agent-fleet/scripts/team-up.ts",
    ".pi/agent-fleet/scripts/lib/coms-envelope.ts",
    ".pi/agent-fleet/scripts/lib/herdr-layout.ts",
    ".pi/agent-fleet/scripts/lib/hermes-bridge-core.ts",
    ".pi/agent-fleet/scripts/lib/team-project.ts",
  ]) assert.ok(paths.files.includes(required), required);
  for (const retired of [".pi/agent-fleet/scripts/codex-conductor.ts", ".pi/agent-fleet/scripts/codex-remote-control.ts", ".pi/agent-fleet/scripts/lib/codex-conductor.ts", ".pi/agent-fleet/scripts/lib/codex-remote-control.ts"]) {
    assert.equal(paths.files.includes(retired), false, retired);
  }
});

test("manifest validation fails when a recursive runtime dependency is absent", () => {
  const fixture = join(tmpdir(), `agent-fleet-manifest-${process.pid}-${Date.now()}`);
  try {
    for (const rel of [...manifest.directories, ...manifest.files]) {
      const src = join(root, rel);
      const dest = join(fixture, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
    }
    rmSync(join(fixture, ".pi", "agent-fleet", "scripts", "lib", "team-project.ts"));
    assert.throws(() => validateManifest(fixture), /\.pi\/agent-fleet\/scripts\/lib\/team-project\.ts/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("copy and symlink installs carry the manifest closure and preserve user justfile content on removal", () => {
  for (const method of ["copy", "symlink"]) {
    const workspace = join(tmpdir(), `agent-fleet-${method}-${process.pid}-${Date.now()}`);
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "justfile"), "user-recipe:\n    echo keep\n# >>> agent-fleet:harnesses old\n# <<< agent-fleet:harnesses <<<\n");
      const owned = installClosure(root, workspace, method);
      for (const rel of [...manifest.directories, ...manifest.files]) assert.ok(existsSync(join(workspace, rel)), `${method}: ${rel}`);
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /user-recipe/);
      const installedJustfile = readFileSync(join(workspace, "justfile"), "utf8");
      assert.match(installedJustfile, /\nfleet \*args:/);
      assert.match(installedJustfile, /_fleet-conductor team=/);
      assert.doesNotMatch(installedJustfile, /_fleet-conductor-codex/);
      assert.doesNotMatch(installedJustfile, /\n(?:hub|hub-team|team-up|safe-coms|conductor-codex)(?: |:)/);
      assert.equal(existsSync(join(workspace, "codex")), false, `${method}: product contract must not land at repository root`);
      assert.equal(lstatSync(join(workspace, ".pi", "agent-fleet", "scripts", "coms-cli.ts")).isSymbolicLink(), method === "symlink");
      assert.equal(existsSync(join(workspace, ".pi", "agent-fleet", "hermes", "desktop-plugins")), false, `${method}: desktop plugins must not install`);
      assert.equal(existsSync(join(workspace, ".pi", "agent-fleet", "hermes", "plugins")), false, `${method}: generic plugins must not install`);
      const fleetHelp = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          join(workspace, ".pi", "agent-fleet", "scripts", "fleet.ts"),
          "help",
        ],
        { cwd: workspace, encoding: "utf8" },
      );
      assert.match(fleetHelp, /Agent Fleet — one guarded Hub runtime, two work modes, independent topology/, `${method}: installed fleet entrypoint must load`);

      if (method === "copy") writeFileSync(join(workspace, ".pi", "agent-fleet", "scripts", "user-owned.ts"), "// keep\n");
      removeClosure(root, workspace, owned);
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /user-recipe/);
      assert.equal(readFileSync(join(workspace, "justfile"), "utf8").includes("agent-fleet:harnesses"), false);
      assert.equal(existsSync(join(workspace, ".pi", "agent-fleet", "scripts", "user-owned.ts")), method === "copy");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("package dry-run includes each versioned harness entrypoint, module, and adjacent manifest", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", maxBuffer: PACK_MAX_BUFFER }));
  const paths = new Set(packed[0].files.map(({ path }) => path));
  for (const file of ["commands/probe.ts", "diagnostic-probe.ts"]) assert.equal(paths.has(`.pi/harnesses/agent-hub/${file}`), false, file);
  for (const file of ["diagnostic-series-budget.ts", "diagnostic-probe-extension.ts"]) assert.ok(paths.has(`.pi/harnesses/agent-hub/${file}`), file);
  assert.ok(paths.has("bin/catalog/harness-runtime-closure.json"), "relocated harness closure must ship in package");
  for (const file of readdirSync(join(root, ".pi/harnesses/agent-hub")).filter(name => name.startsWith("proactive-") && !name.includes(".test.") && /\.(ts|mjs)$/.test(name))) {
    assert.ok(paths.has(`.pi/harnesses/agent-hub/${file}`), `proactive runtime missing ${file}`);
  }
  assert.equal([...paths].some(path => path.startsWith(".pi/agent-sessions/") || path.startsWith(".tmp-")), false, "private proactive fixtures must not ship");
  assert.equal([...paths].some((path) => /guided-workspace-setup|af-(?:setup|doctor)-agent-fleet/.test(path)), false, "tarball must not ship retired setup surfaces");
  const prompts = [...paths].filter((path) => path.startsWith(".pi/prompts/af-")).sort();
  assert.deepEqual(prompts, [
    ".pi/prompts/af-build.md", ".pi/prompts/af-code-simplify.md", ".pi/prompts/af-constraints.md",
    ".pi/prompts/af-plan.md",
    ".pi/prompts/af-review.md", ".pi/prompts/af-set-hermes-telegram.md", ".pi/prompts/af-set-hermes-watchdog.md",
    ".pi/prompts/af-setup-rules.md", ".pi/prompts/af-ship.md", ".pi/prompts/af-spec.md", ".pi/prompts/af-test.md",
  ]);
  for (const harness of ["agent-hub", "coms", "damage-control-continue"]) {
    for (const file of ["index.ts", "version.ts", "package.json"]) {
      assert.ok(paths.has(`.pi/harnesses/${harness}/${file}`), `${harness}/${file}`);
    }
  }
  // ask-user-remote is the canonical Fleet ask_user owner; pack must ship runtime
  // sources + bundled stock dependency, never the harness test files.
  for (const file of ["index.ts", "race-core.js", "README.md"]) {
    assert.ok(paths.has(`.pi/harnesses/ask-user-remote/${file}`), `ask-user-remote/${file}`);
  }
  assert.ok(paths.has("node_modules/pi-ask-user/index.ts"), "bundled pi-ask-user runtime");
  assert.ok(paths.has("node_modules/pi-ask-user/skills/ask-user/SKILL.md"), "bundled ask-user skill");
  assert.equal(paths.has(".pi/harnesses/ask-user-remote/index.test.ts"), false);
  assert.equal(paths.has(".pi/harnesses/ask-user-remote/race-core.test.js"), false);
  for (const module of ["model", "store", "registry", "socket", "herdr"]) {
    assert.ok(paths.has(`.pi/harnesses/lib/hermes-monitor-${module}.ts`), `shared monitor module: ${module}`);
  }
  assert.equal([...paths].some((path) => path.startsWith(".pi/harnesses/damage-control/")), false);
  assert.equal([...paths].some((path) => path.startsWith(".pi/agent-fleet/hermes/desktop-plugins/")), true, "desktop monitor runtime is packaged");
  assert.equal([...paths].some((path) => path.startsWith(".pi/agent-fleet/hermes/plugins/")), true, "backend monitor runtime is packaged");
  for (const file of [
    ".pi/harnesses/lib/system1/config.js",
    ".pi/harnesses/lib/system1/contracts.ts",
    ".pi/harnesses/lib/system1/demo.ts",
    ".pi/harnesses/lib/system1/jev.ts",
    ".pi/harnesses/lib/system1/service.ts",
  ]) {
    assert.ok(paths.has(file), `system1 runtime must ship: ${file}`);
  }
  assert.equal([...paths].some((path) => path.startsWith(".pi/harnesses/lib/system1/") && /\.test\.(js|ts)$/.test(path)), false, "system1 tests must not be published");
});

test("workflow-only install runs a production policy prompt without the Hub item or source checkout", () => {
  const workspace = mkdtempSync(join(tmpdir(), "af-workflow-only-"));
  try {
    const generated = buildManifest({ sourceRoot: root, packageVersion: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version });
    const items = ["companion:workflow-runtime", "companion:pi-harness-lib"];
    assert.equal(items.includes("harness:agent-hub"), false);
    for (const id of items) {
      const item = generated.items.find(entry => entry.id === id);
      assert.ok(item, id);
      for (const source of item.agents.pi.source) {
        const from = join(root, source), to = join(workspace, source);
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to, { recursive: true });
      }
    }
    for (const dependency of ["@sinclair/typebox", "yaml"]) {
      const target = join(workspace, ".pi/agent-fleet/scripts/node_modules", dependency);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(root, "node_modules", dependency), target, { recursive: true });
    }
    const project = join(workspace, "project");
    mkdirSync(join(project, ".ai", "rules"), { recursive: true });
    writeFileSync(join(project, ".ai", "agent-fleet-overrides.md"), "## agent-hub\nrules: .ai/rules\n");
    writeFileSync(join(project, ".ai", "rules", "README.md"), "# Installed policy index\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project });
    execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-qm", "base"], { cwd: project });
    const agentPhase = pathToFileURL(join(workspace, ".pi/agent-fleet/scripts/workflows/lib/agent-phase.ts")).href;
    const runModule = pathToFileURL(join(workspace, ".pi/agent-fleet/scripts/workflows/lib/run.ts")).href;
    const script = `import { runAgentPhase } from ${JSON.stringify(agentPhase)}; import { Run } from ${JSON.stringify(runModule)};
      const cwd = ${JSON.stringify(project)}; const run = new Run({cwd,runId:'only'}); let sent = '';
      await runAgentPhase({ run, cwd, persona: {name:'scout',model:'test/model',tools:'read',thinking:'off',systemPrompt:'Read project rules',file:'agents/scout.md',writes:[]}, task:'Inspect policy',envelope:'scout', spawn: async options => { sent = options.systemPrompt; return {exitCode:0,output:JSON.stringify({status:'success',summary:'ok',artifacts:[],notes_for_next_agent:'',findings:['ok']})}; } });
      if (!sent.includes('Applicable project rules: .ai/rules')) throw Error('policy absent from installed prompt');`;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

// The full watchdog release surface — runtime modules, lifecycle commands,
// exclusions, and content leak checks — lives in package-hermes-watchdog.test.js.
test("isolated tarball supports Default and Full deterministic setup", () => {
  const fixture = mkdtempSync(join(tmpdir(), "af-tarball-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", fixture], { cwd: root, encoding: "utf8", maxBuffer: PACK_MAX_BUFFER }));
    const tarball = join(fixture, packed[0].filename);
    const extracted = join(fixture, "node_modules", "@chankov", "agent-fleet");
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", extracted]);
    const extractedPackage = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
    const extractedManifest = buildManifest({
      sourceRoot: extracted,
      packageVersion: extractedPackage.version,
    });
    assertPiSkillDiscovery({
      packageRoot: extracted,
      packageJson: extractedPackage,
      manifest: extractedManifest,
    });
    assert.equal(existsSync(join(extracted, "docs", "plans")), false, "local planning notes must not be packaged");
    const fakeBin = join(fixture, "bin");
    mkdirSync(fakeBin);
    const fakePi = join(fakeBin, "pi");
    writeFileSync(fakePi, fakePiListingScript());
    chmodSync(fakePi, 0o755);
    const doctorEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };

    for (const preset of ["default", "full"]) {
      const workspace = join(fixture, preset);
      mkdirSync(workspace);
      const result = execFileSync(process.execPath, [
        join(extracted, "bin", "cli.js"), "setup", "--workspace", workspace,
        "--preset", preset, "--features", "none", "--yes",
      ], { encoding: "utf8" });
      assert.match(result, /Files installed; (?:runtime dependencies are missing or unverified|existing readiness checks passed)/);
      assert.equal(existsSync(join(workspace, "docs", "plans", "agent-hub", "local-duo-profile.md")), false, "local profile notes must not be installed");
      // P13b/B9: the real installer path carries the full proactive runtime
      // closure (all 12 files incl the .mjs worker) and never auto-creates
      // human-owned proactive review config.
      for (const name of ["proactive-config.ts", "proactive-evaluate.ts", "proactive-feedback.ts", "proactive-findings.ts", "proactive-local.ts", "proactive-observer.ts", "proactive-rules.ts", "proactive-runtime.ts", "proactive-selection.ts", "proactive-snapshot-worker.mjs", "proactive-snapshot.ts", "proactive-types.ts"]) {
        assert.ok(existsSync(join(workspace, ".pi", "harnesses", "agent-hub", name)), `${preset}: installed ${name}`);
      }
      assert.equal(existsSync(join(workspace, ".ai", "proactive-review.json")), false, `${preset}: setup must not auto-create proactive review config`);
      // A pre-existing HUMAN fixture survives a re-setup byte-identical.
      const humanPath = join(workspace, ".ai", "proactive-review.json");
      const humanBytes = Buffer.from(`${JSON.stringify({ version: 1, owner: "human" })}\n`);
      writeFileSync(humanPath, humanBytes);
      execFileSync(process.execPath, [
        join(extracted, "bin", "cli.js"), "setup", "--workspace", workspace,
        "--preset", preset, "--features", "none", "--yes",
      ], { encoding: "utf8" });
      assert.deepEqual(readFileSync(humanPath), humanBytes, `${preset}: re-setup preserves human fixture`);
      rmSync(humanPath);
      const desired = JSON.parse(readFileSync(join(workspace, ".ai", "agent-fleet.json"), "utf8"));
      assert.equal(desired.preset, preset);
      // Nothing installs under .claude/ any more — the bridge Stop hook moved in with
      // the rest of the fleet runtime, and registering it stays the user's step.
      assert.equal(existsSync(join(workspace, ".claude")), false, `${preset}: nothing installs under .claude/`);
      if (preset !== "default") assert.ok(existsSync(join(workspace, ".pi", "agent-fleet", "hooks", "coms-stop-hook.mjs")));
      const workflowPackage = JSON.parse(readFileSync(join(workspace, ".pi", "agent-fleet", "scripts", "package.json"), "utf8"));
      assert.deepEqual(workflowPackage.dependencies, {
        "@sinclair/typebox": "^0.34.49",
        yaml: "^2.9.0",
      });
      assert.ok(existsSync(join(workspace, ".pi", "agent-fleet", "scripts", "package-lock.json")));
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /npm install --prefix \.pi\/agent-fleet\/scripts/);
      // Materialize each isolated runtime root from the already-installed root
      // fixture. `npm ls --prefix` intentionally does not borrow dependencies
      // from a sibling/root node_modules tree.
      for (const dependencyRoot of [".pi/extensions", ".pi/harnesses", ".pi/agent-fleet/scripts"]) {
        const runtimePackage = JSON.parse(readFileSync(join(workspace, dependencyRoot, "package.json"), "utf8"));
        for (const dependency of Object.keys(runtimePackage.dependencies ?? {})) {
          const target = join(workspace, dependencyRoot, "node_modules", dependency);
          mkdirSync(dirname(target), { recursive: true });
          cpSync(join(root, "node_modules", dependency), target, { recursive: true });
        }
      }
      const flowModule = pathToFileURL(join(workspace, ".pi", "agent-fleet", "scripts", "flow.ts")).href;
      const flowLoad = execFileSync(process.execPath, [
        "--experimental-strip-types", "--input-type=module", "--eval",
        `await import(${JSON.stringify(flowModule)}); process.stdout.write("loaded")`,
      ], { cwd: workspace, encoding: "utf8" });
      assert.equal(flowLoad, "loaded", "installed flow entrypoint must load with script-local dependencies");

      const doctor = JSON.parse(execFileSync(process.execPath, [
        join(extracted, "bin", "cli.js"), "doctor", "--workspace", workspace, "--json",
      ], { encoding: "utf8", env: doctorEnv }));
      assert.equal(doctor.summary.outstanding, 0, `${preset}: installed-package doctor must run under node_modules`);
      const update = JSON.parse(execFileSync(process.execPath, [join(extracted, "bin", "cli.js"), "setup", "--workspace", workspace, "--dry-run", "--json"], { encoding: "utf8" }));
      assert.equal(update.publicSchemaVersion, 1); assert.equal(update.summary.changes, 0);
    }

    const historicalWorkspace = join(fixture, "historical-update"); mkdirSync(historicalWorkspace);
    cpSync(join(root, "bin/test/fixtures/agent-fleet-2.0.5/.ai"), join(historicalWorkspace, ".ai"), { recursive: true });
    const historicalBefore = JSON.parse(readFileSync(join(historicalWorkspace, ".ai/agent-fleet-state.json"), "utf8"));
    assert.equal(historicalBefore.packageVersion, "2.0.5", "fixture is unaltered output from the published 2.0.5 installer");
    execFileSync(process.execPath, [join(extracted, "bin", "cli.js"), "setup", "--workspace", historicalWorkspace, "--repair-config", "--yes"], { encoding: "utf8" });
    const historicalAfter = JSON.parse(readFileSync(join(historicalWorkspace, ".ai/agent-fleet-state.json"), "utf8"));
    assert.equal(historicalAfter.packageVersion, JSON.parse(readFileSync(join(extracted, "package.json"), "utf8")).version);
    assert.equal(JSON.parse(readFileSync(join(historicalWorkspace, ".ai/agent-fleet.json"), "utf8")).preset, "default");

    const allPreviewWorkspace = join(fixture, "all-features-preview"); mkdirSync(allPreviewWorkspace);
    const allPreview = JSON.parse(execFileSync(process.execPath, [join(extracted, "bin", "cli.js"), "setup", "--workspace", allPreviewWorkspace,
      "--preset", "full", "--features", "browser, chatgpt-client, claude-bridge, hermes, telegram, voice", "--stt-provider", "openai", "--dry-run", "--json"], { encoding: "utf8" }));
    assert.equal(allPreview.stage, "preview"); assert.ok(allPreview.selection.desired.features.includes("chatgpt-client"));
    const nonTtyWorkspace = join(fixture, "non-tty"); mkdirSync(nonTtyWorkspace);
    const refused = spawnSync(process.execPath, [join(extracted, "bin", "cli.js"), "setup", "--workspace", nonTtyWorkspace, "--preset", "default", "--features", "none"], { encoding: "utf8" });
    assert.equal(refused.status, 1); assert.match(refused.stderr, /requires --yes/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the watchdog release note stays honest about Gate O", () => {
  // The note starts life as a pending changeset and is folded verbatim into
  // CHANGELOG.md by `changeset version`, which deletes the changeset file.
  // Assert against whichever surface currently carries it so the guarantee
  // survives release instead of ENOENT-ing the publish run on main.
  const changesetPath = join(root, ".changeset", "hermes-watchdog-supervisor.md");
  const pending = existsSync(changesetPath);
  const notes = readFileSync(pending ? changesetPath : join(root, "CHANGELOG.md"), "utf8");

  assert.match(
    notes,
    /disabled until genuine live Hermes capability evidence/i,
    pending ? "pending changeset" : "CHANGELOG.md must retain the consumed watchdog note",
  );
  assert.doesNotMatch(notes, /Gate O.*(?:passed|proven)|live delivery.*enabled/i);
});

test("published package hoists extension runtime dependencies for symlink installs", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const extensionPkg = JSON.parse(readFileSync(join(root, ".pi", "extensions", "package.json"), "utf8"));

  for (const [name, version] of Object.entries(extensionPkg.dependencies)) {
    assert.equal(
      pkg.dependencies?.[name],
      version,
      `${name} must be a root production dependency because npm does not install nested .pi/extensions/package.json dependencies`,
    );
  }
});

test("package, snapshot, and harness closure surfaces stay aligned", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const required of ["codex/", ".pi/agent-fleet/hermes/README.md", ".pi/agent-fleet/hermes/skills/", "docs/coms-hermes-bridge.md", "docs/MIGRATION-agent-fleet.md", "docs/codex-session-bridge.md"]) {
    assert.ok(pkg.files.includes(required), `package files missing ${required}`);
  }
  assert.equal(pkg.files.includes(".pi/agent-fleet/hermes/"), false);
  assert.equal(pkg.files.includes("systemd/"), false);
  assert.equal(pkg.files.includes("docs/codex-remote-conductor.md"), false);
  assert.ok(pkg.files.includes(".pi/agent-fleet/hermes/plugins/"));
  assert.ok(pkg.files.includes(".pi/agent-fleet/hermes/desktop-plugins/"));
  assert.ok(pkg.files.includes("!.pi/agent-fleet/hermes/watchdog-tests/"));
  assert.ok(pkg.files.includes("!.pi/agent-fleet/hermes/**/__pycache__/"));
  assert.match(pkg.scripts.test, /\.pi\/agent-fleet\/scripts\/coms-cli\.test\.ts/);
  assert.doesNotMatch(pkg.scripts.test, /scripts\/lib\/codex-remote-control\.test\.ts/);
  const snapshot = readFileSync(join(root, "bin", "snapshot-version.js"), "utf8");
  for (const required of ["codex", ".pi/agent-fleet/hermes", "docs/coms-hermes-bridge.md", ".pi/agent-fleet/scripts", "justfile", "bin/catalog/harness-runtime-closure.json"]) {
    assert.match(snapshot, new RegExp(`"${required}"`), `snapshot missing ${required}`);
  }
  assert.doesNotMatch(snapshot, /"systemd"/);
  assert.doesNotMatch(snapshot, /docs\/codex-remote-conductor\.md/);
  assert.doesNotMatch(snapshot, /^\s*"docs",$/m, "snapshot must not include docs omitted from the package root allowlist");
});

// The harness runtime closure and managed-region lifecycle are manifest/apply
// contracts. These assertions guard the data and behaviour directly.
test("root and harness runtime deps pin the same pi-ask-user range", () => {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const harnessPkg = JSON.parse(readFileSync(join(root, ".pi", "harnesses", "package.json"), "utf8"));
  const harnessLock = JSON.parse(readFileSync(join(root, ".pi", "harnesses", "package-lock.json"), "utf8"));
  assert.equal(rootPkg.dependencies["pi-ask-user"], "^0.14.0");
  assert.equal(harnessPkg.dependencies["pi-ask-user"], rootPkg.dependencies["pi-ask-user"]);
  // Prefer the canonical npm field; accept the historical alias only as a fallback.
  const bundled = rootPkg.bundledDependencies ?? rootPkg.bundleDependencies ?? [];
  assert.ok(bundled.includes("pi-ask-user"), "package-native installs must bundle pi-ask-user");
  assert.ok(
    !(rootPkg.bundledDependencies && rootPkg.bundleDependencies),
    "do not list both bundleDependencies and bundledDependencies",
  );
  assert.ok(harnessLock.packages?.["node_modules/pi-ask-user"], "harness lock must install pi-ask-user");
  assert.ok(
    harnessLock.packages["node_modules/pi-ask-user"].version.startsWith("0.14."),
    "harness lock should resolve pi-ask-user 0.14.x",
  );
});

test("active runtime lockfiles stay above audited vulnerable version floors", () => {
  const locks = {
    root: JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
    extensions: JSON.parse(readFileSync(join(root, ".pi", "extensions", "package-lock.json"), "utf8")),
    harnesses: JSON.parse(readFileSync(join(root, ".pi", "harnesses", "package-lock.json"), "utf8")),
  };
  const floors = [
    ["root", "node_modules/@earendil-works/pi-coding-agent", "0.84.2"],
    ["root", "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion", "5.0.9"],
    ["root", "node_modules/@earendil-works/pi-coding-agent/node_modules/undici", "8.9.0"],
    ["root", "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs", "7.6.5"],
    ["root", "node_modules/fast-uri", "3.1.5"],
    ["root", "node_modules/ip-address", "10.5.0"],
    ["root", "node_modules/hono", "4.12.34"],
    ["root", "node_modules/@hono/node-server", "1.19.15"],
    ["root", "node_modules/js-yaml", "4.3.1"],
    ["root", "node_modules/read-yaml-file/node_modules/js-yaml", "3.15.1"],
    ["extensions", "node_modules/fast-uri", "3.1.5"],
    ["extensions", "node_modules/express-rate-limit", "8.6.0"],
    ["extensions", "node_modules/ip-address", "10.5.0"],
    ["extensions", "node_modules/hono", "4.12.34"],
    ["extensions", "node_modules/@hono/node-server", "1.19.15"],
    ["extensions", "node_modules/body-parser", "2.3.0"],
    ["extensions", "node_modules/qs", "6.15.2"],
    ["harnesses", "node_modules/@earendil-works/pi-coding-agent", "0.84.2"],
    ["harnesses", "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion", "5.0.9"],
    ["harnesses", "node_modules/@earendil-works/pi-coding-agent/node_modules/undici", "8.9.0"],
  ];
  const parts = (version) => version.split(".").map((part) => Number.parseInt(part, 10));
  const atLeast = (actual, floor) => {
    const a = parts(actual);
    const b = parts(floor);
    return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
  };

  for (const [lockName, packagePath, floor] of floors) {
    const actual = locks[lockName].packages?.[packagePath]?.version;
    assert.ok(actual, `${lockName} lock is missing ${packagePath}`);
    assert.ok(atLeast(actual, floor), `${lockName} lock resolves ${packagePath} at vulnerable ${actual}; expected >= ${floor}`);
  }
});

test("the relocated harness runtime closure is a manifest companion of every harness", () => {
  const installManifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  const closure = installManifest.items.find((i) => i.id === "companion:harness-runtime-closure");
  assert.ok(closure, "the relocated harness closure has no manifest item");
  assert.equal(closure.agents.pi.source.some((path) => path === "codex" || path.startsWith("docs/")), false);
  assert.equal(installManifest.items.some((i) => i.id === "companion:codex-conductor-contract"), false);
  const workflowGuide = installManifest.items.find((i) => i.id === "companion:workflow-guide");
  assert.equal(workflowGuide?.agents.pi.target, ".pi/agent-fleet/docs/workflows.md");
  assert.equal(existsSync(join(root, "skills", "guided-workspace-setup", "companion-manifest.json")), false, "legacy skill path must not contain runtime closure");
  assert.ok(existsSync(manifestPath), "installer-owned runtime closure is missing");

  for (const rel of [...(manifest.files ?? []), ...(manifest.directories ?? [])]) {
    if (rel === "justfile") continue; // its own companion — managed region, not a whole-file copy
    assert.ok(
      closure.agents.pi.source.includes(rel),
      `companion-manifest.json declares ${rel} but the closure item does not carry it`,
    );
  }

  for (const harness of installManifest.items.filter((i) => i.kind === "pi-harness")) {
    assert.ok(harness.companions?.includes("companion:harness-runtime-closure"), harness.id);
    assert.ok(harness.companions?.includes("companion:justfile-region"), harness.id);
  }
});

test("removing the last harness strips the justfile region and keeps user recipes", () => {
  const installManifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  const workspace = mkdtempSync(join(tmpdir(), "af-justfile-"));

  const install = buildPlan({
    workspace, sourceRoot: root, packageVersion: installManifest.packageVersion,
    manifest: installManifest,
    verb: "install", agent: "pi", items: ["pi-harness:agent-hub"], platform: "linux",
  });
  applyPlan({ plan: install, manifest: installManifest });

  const justfile = join(workspace, "justfile");
  assert.ok(extractRegion(readFileSync(justfile, "utf8")), "no managed region after install");
  assert.equal(existsSync(join(workspace, ".pi/agent-fleet/codex/CONDUCTOR.md")), false);
  assert.ok(existsSync(join(workspace, ".pi/agent-fleet/docs/workflows.md")));
  for (const rel of ["docs/ARCHITECTURE.md", "docs/codex-remote-conductor.md", "docs/coms-hermes-bridge.md", "docs/workflows.md", "codex/CONDUCTOR.md"]) {
    assert.equal(existsSync(join(workspace, rel)), false, `${rel} leaked into the target repository`);
  }

  // A recipe the user added outside the sentinels must outlive the uninstall.
  writeFileSync(justfile, readFileSync(justfile, "utf8") + "\nmine:\n\techo mine\n");

  const removal = buildPlan({
    workspace, sourceRoot: root, packageVersion: installManifest.packageVersion,
    manifest: installManifest,
    verb: "uninstall", agent: "pi", all: true, platform: "linux",
  });
  applyPlan({ plan: removal, manifest: installManifest });

  const after = readFileSync(justfile, "utf8");
  assert.equal(extractRegion(after), null, "the managed region survived the removal");
  assert.match(after, /^mine:$/m, "the user's recipe was deleted with ours");
});

// Exercise the real installer ownership ledger, not a hand-written copy helper.
for (const [method, modified] of [["copy", false], ["symlink", false], ["copy", true]]) {
  test(`${method}${modified ? " user-modified" : ""} Hub refresh retires managed probe files and retains shared guards`, async () => {
    const temp = mkdtempSync(join(tmpdir(), "af-retired-probe-"));
    const source = join(temp, "source"), workspace = join(temp, "workspace");
    const hub = ".pi/harnesses/agent-hub";
    const retired = ["commands/probe.ts", "diagnostic-probe.ts"];
    const current = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
    // Limit this fixture to the unchanged Hub binding; the full closure is tested above.
    const item = structuredClone(current.items.find(item => item.id === "pi-harness:agent-hub"));
    item.companions = []; item.requires = [];
    const fixtureManifest = { ...current, items: [item] };
    try {
      cpSync(join(root, hub), join(source, hub), { recursive: true });
      for (const file of retired) {
        assert.equal(existsSync(join(source, hub, file)), false);
        writeFileSync(join(source, hub, file), "export default function retiredProbeFixture() {}\n");
      }
      const install = () => applyPlan({ plan: buildPlan({
        workspace, sourceRoot: source, packageVersion: current.packageVersion,
        manifest: fixtureManifest, verb: "install", agent: "pi",
        items: [item.id], platform: "linux", method,
      }), manifest: fixtureManifest });
      install();
      for (const file of retired) assert.ok(existsSync(join(workspace, hub, file)));
      const userContent = "// user-owned obsolete file: must not be erased\n";
      if (modified) writeFileSync(join(workspace, hub, retired[0]), userContent);
      for (const file of retired) rmSync(join(source, hub, file));
      const refreshed = install();
      for (const file of retired) assert.equal(existsSync(join(workspace, hub, file)), modified && file === retired[0], file);
      if (modified) {
        assert.equal(readFileSync(join(workspace, hub, retired[0]), "utf8"), userContent);
        assert.match(JSON.stringify(refreshed), /kept 1 user-modified obsolete path/);
      }
      for (const file of ["index.ts", "diagnostic-series-budget.ts", "diagnostic-probe-extension.ts"]) {
        assert.equal(readFileSync(join(workspace, hub, file), "utf8"), readFileSync(join(root, hub, file), "utf8"));
      }
      assert.doesNotMatch(readFileSync(join(workspace, hub, "index.ts"), "utf8"), /registerProbe|handleProbe|runDiagnosticProbes/);
      // Only local runtime dependencies; no installation or provider requests.
      for (const rel of ["node_modules", ".pi/harnesses/lib", ".pi/harnesses/ask-user-remote", ".pi/harnesses/damage-control-continue", ".pi/agent-fleet", ".pi/agents"]) {
        const target = join(workspace, rel);
        mkdirSync(dirname(target), { recursive: true });
        symlinkSync(join(root, rel), target, "dir");
      }
      const before = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, new Set(process.listeners(signal))]));
      try {
        const { loadExtensions } = await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href);
        const loaded = await loadExtensions([join(workspace, hub, "index.ts")], workspace);
        assert.deepEqual(loaded.errors, []);
        assert.equal(loaded.extensions.length, 1);
        const extension = loaded.extensions[0];
        assert.equal(extension.commands.has("af-probe"), false);
        assert.equal(extension.tools.has("af_probe_value"), false);
        for (const command of ["af-audit", "af-retry", "af-work-mode"]) assert.ok(extension.commands.has(command), command);
      } finally {
        for (const [signal, listeners] of before) for (const listener of process.listeners(signal)) {
          if (!listeners.has(listener)) process.removeListener(signal, listener);
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
