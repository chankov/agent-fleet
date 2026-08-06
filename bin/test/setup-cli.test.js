// End-to-end lifecycle CLI contract: all workspaces are disposable temp fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildReconcilePlan } from "../lib/reconcile.js";
import { applyPlan } from "../lib/apply.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const workspace = () => mkdtempSync(join(tmpdir(), "af-setup-cli-"));
const run = (args, input = undefined) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input });
const setup = (ws, ...args) => run(["setup", "--workspace", ws, ...args]);

function writeState(ws, extra = {}) {
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "agent-fleet-state.json"), JSON.stringify({
    schemaVersion: 1, agent: "pi", method: "copy", packageVersion: "0.0.1", sourceRoot: root,
    profiles: [], installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    items: {}, externalPackages: [], events: [], ...extra,
  }));
}

test("A7 fresh non-interactive setup, ephemeral desired flags, dry-run, migration gate, and aliases", () => {
  const fresh = workspace();
  let result = setup(fresh, "--preset", "default", "--features", "none", "--yes");
  assert.equal(result.status, 0, result.stderr);
  const desiredPath = join(fresh, ".ai", "agent-fleet.json");
  assert.ok(existsSync(desiredPath));

  const original = JSON.stringify({ schemaVersion: 1, preset: "full", features: { telegram: false, "codex-remote": false } }, null, 2) + "\n";
  writeFileSync(desiredPath, original);
  result = setup(fresh, "--preset", "default", "--features", "none", "--yes");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(desiredPath, "utf8"), original, "CLI overrides are ephemeral without --save-desired");
  result = setup(fresh, "--preset", "default", "--features", "none", "--save-desired", "--yes");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(readFileSync(desiredPath, "utf8"), original);

  const preview = workspace();
  result = setup(preview, "--preset", "default", "--features", "none", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(preview, ".ai")), false, "dry-run writes nothing and needs no --yes");

  const legacy = workspace(); writeState(legacy);
  result = setup(legacy, "--yes");
  assert.equal(result.status, 1); assert.match(result.stderr, /first migration requires --migrate/);
  result = setup(legacy, "--migrate", "--preset", "default", "--features", "none", "--yes");
  assert.equal(result.status, 0, result.stderr);

  result = run(["install", "--workspace", workspace(), "--preset", "default", "--features", "none", "--yes"]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /deprecated; use setup/);
  result = run(["install", "--workspace", workspace(), "--items", "skill:any", "--yes"]);
  assert.equal(result.status, 0, result.stderr); // legacy install aliases retain raw-item compatibility.
});

test("setup --json --yes applies and dry-run remains write-free", () => {
  const applyWorkspace = workspace();
  let result = setup(applyWorkspace, "--preset", "default", "--features", "none", "--json", "--yes");
  assert.equal(result.status, 0, result.stderr);
  const applied = JSON.parse(result.stdout);
  assert.equal(applied.exitCode, 0);
  assert.ok(existsSync(join(applyWorkspace, ".ai", "agent-fleet.json")), "consented JSON setup applies");

  const previewWorkspace = workspace();
  result = setup(previewWorkspace, "--preset", "default", "--features", "none", "--json", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verb, "setup");
  assert.equal(existsSync(join(previewWorkspace, ".ai")), false, "JSON dry-run remains write-free");
});

test("primary setup rollback removes partial files and does not commit desired or state", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "af-setup-failure-src-"));
  const ws = workspace();
  mkdirSync(join(sourceRoot, "skills", "alpha"), { recursive: true });
  mkdirSync(join(sourceRoot, "skills", "beta"), { recursive: true });
  writeFileSync(join(sourceRoot, "skills", "alpha", "SKILL.md"), "alpha\n");
  writeFileSync(join(sourceRoot, "skills", "beta", "SKILL.md"), "beta\n");
  const miniManifest = {
    schemaVersion: 2, packageVersion: "1.0.0", groups: [{ id: "skills", title: "Skills", order: 1, agents: ["pi"] }],
    presets: { default: { title: "Default", items: ["skill:alpha", "skill:beta"] }, full: { title: "Full", items: ["skill:alpha", "skill:beta"] } },
    features: {}, profiles: { all: { title: "all", rule: "all" } },
    items: ["alpha", "beta"].map((name) => ({
      id: `skill:${name}`, kind: "skill", group: "skills", title: name, summary: "", recommended: true,
      consent: "file", platform: "any", stability: "stable", companions: [], requires: [],
      agents: { pi: { source: [`skills/${name}`], sourceMode: "first", target: `.pi/skills/${name}`, strategy: "copy-tree" } },
    })),
  };
  const plan = buildReconcilePlan({
    workspace: ws, sourceRoot, packageVersion: "1.0.0", manifest: miniManifest,
    preset: "default", features: "none", yes: true,
  });
  rmSync(join(sourceRoot, "skills", "beta"), { recursive: true, force: true });
  const result = applyPlan({ plan, manifest: miniManifest });
  assert.equal(result.exitCode, 1);
  assert.match(result.failure.detail, /skill:beta.*no source available/);
  assert.equal(existsSync(join(ws, ".pi", "skills", "alpha", "SKILL.md")), false, "earlier writes rolled back");
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet.json")), false, "desired state was not committed");
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet-state.json")), false, "applied state was not committed");
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet-setup.md")), false, "legacy record was not committed");
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet-transaction.json")), false, "journal was cleared after rollback");
});

test("setup validates and threads --on-conflict values", () => {
  for (const policy of ["ours", "theirs"]) {
    const result = setup(workspace(), "--preset", "default", "--features", "none", "--on-conflict", policy, "--yes");
    assert.equal(result.status, 0, `${policy}: ${result.stderr}`);
  }
  const invalid = setup(workspace(), "--preset", "default", "--features", "none", "--on-conflict", "keep-both", "--yes");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--on-conflict must be "ours" or "theirs"/);
});

test("setup and deprecated upgrade publish verb-specific conflict guidance", () => {
  const setupHelp = run(["setup", "--help"]);
  assert.equal(setupHelp.status, 0, setupHelp.stderr);
  assert.match(setupHelp.stdout, /--on-conflict <ours\|theirs>/);
  assert.match(setupHelp.stdout, /Resolve conflicts with --on-conflict/);

  const upgradeHelp = run(["upgrade", "--help"]);
  assert.equal(upgradeHelp.status, 0, upgradeHelp.stderr);
  assert.match(upgradeHelp.stdout, /Resolve conflicts with --accept-theirs.*--accept-ours/s);
  assert.doesNotMatch(upgradeHelp.stdout, /Resolve conflicts with --on-conflict/);
});

test("setup --on-conflict resolves real both-changed conflicts under ours and theirs", () => {
  // Fixture mirrors plan three-way conflict: base v1, package v2, local edit.
  // buildReconcilePlan is the accept path setup uses after CLI validation.
  const pkg = mkdtempSync(join(tmpdir(), "af-on-conflict-pkg-"));
  mkdirSync(join(pkg, "skills", "alpha"), { recursive: true });
  writeFileSync(join(pkg, "skills", "alpha", "SKILL.md"), "alpha v2\n");
  mkdirSync(join(pkg, ".versions", "0.0.1", "skills", "alpha"), { recursive: true });
  writeFileSync(join(pkg, ".versions", "0.0.1", "skills", "alpha", "SKILL.md"), "alpha v1\n");
  const miniManifest = {
    schemaVersion: 2,
    packageVersion: "0.0.2",
    groups: [{ id: "skills", title: "Skills", order: 1, agents: ["pi"] }],
    presets: { default: { title: "Default", items: ["skill:alpha"] }, full: { title: "Full", items: ["skill:alpha"] } },
    features: {},
    profiles: { all: { title: "all", rule: "all" } },
    items: [{
      id: "skill:alpha", kind: "skill", group: "skills", title: "alpha",
      summary: "", recommended: true, consent: "file", platform: "any",
      stability: "stable", companions: [], requires: [],
      agents: { pi: { source: ["skills/alpha"], sourceMode: "first", target: ".pi/skills/alpha", strategy: "copy-tree" } },
    }],
  };
  writeFileSync(join(pkg, "install-manifest.json"), JSON.stringify(miniManifest, null, 2));
  writeFileSync(join(pkg, ".versions", "0.0.1", "install-manifest.json"), JSON.stringify({
    ...miniManifest, packageVersion: "0.0.1",
  }, null, 2));

  const planFor = (accept) => {
    const ws = workspace();
    mkdirSync(join(ws, ".pi", "skills", "alpha"), { recursive: true });
    writeFileSync(join(ws, ".pi", "skills", "alpha", "SKILL.md"), "my local edit\n");
    const hash = createHash("sha256").update("alpha v1\n").digest("hex");
    writeState(ws, {
      packageVersion: "0.0.1",
      sourceRoot: pkg,
      items: { "skill:alpha": { kind: "skill", files: [{ path: ".pi/skills/alpha/SKILL.md", sha256: hash }] } },
    });
    writeFileSync(join(ws, ".ai", "agent-fleet.json"), JSON.stringify({
      schemaVersion: 1, preset: "default", features: {},
    }, null, 2));
    return buildReconcilePlan({
      workspace: ws, sourceRoot: pkg, packageVersion: "0.0.2", manifest: miniManifest,
      preset: "default", features: [], accept,
    });
  };

  const blocked = planFor(null);
  assert.equal(blocked.conflicts.length, 1);
  assert.equal(blocked.actions.find((a) => a.id === "skill:alpha").kind, "conflict");
  const theirs = planFor("theirs");
  assert.equal(theirs.conflicts.length, 0);
  assert.equal(theirs.actions.find((a) => a.id === "skill:alpha").kind, "refresh");
  const ours = planFor("ours");
  assert.equal(ours.conflicts.length, 0);
  assert.equal(ours.actions.find((a) => a.id === "skill:alpha").kind, "keep");
});

test("noninteractive uninstall requires explicit --all or --items", () => {
  const ws = workspace();
  writeState(ws, {
    items: {
      "skill:alpha": { kind: "skill", files: [{ path: ".pi/skills/alpha/SKILL.md", sha256: "0".repeat(64) }] },
    },
  });
  let result = run(["uninstall", "--workspace", ws, "--yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uninstall needs --items .* or an explicit --all/);
  assert.ok(existsSync(join(ws, ".ai", "agent-fleet-state.json")), "refused uninstall leaves state");
  result = run(["uninstall", "--workspace", ws, "--items", "skill:alpha", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
});

test("setup confirmation output lists every configuration write and warns for unignored .env", () => {
  const ws = workspace();
  const result = setup(ws, "--preset", "default", "--features", "voice", "--yes");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configuration writes/);
  assert.match(result.stdout, /\.ai\/agent-fleet\.json/);
  assert.match(result.stdout, /\.ai\/stt\.json/);
  assert.match(result.stdout, /^  \.env$/m);
  assert.match(result.stdout, /\.env is not covered by the target \.gitignore/);
});

test("A8 non-TTY setup mutation directs users to --yes", () => {
  const result = setup(workspace(), "--preset", "default", "--features", "none");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --yes in non-TTY mode/);
});

test("A9 bare doctor is read-only; doctor --fix recovers transactions and retries runtime repairs", () => {
  const ws = workspace();
  writeState(ws, { runtimeRepairs: [{ id: "runtime:test", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: "." }] });
  const before = readFileSync(join(ws, ".ai", "agent-fleet-state.json"), "utf8");
  let result = run(["doctor", "--workspace", ws, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(readFileSync(join(ws, ".ai", "agent-fleet-state.json"), "utf8"), before, "bare doctor does not write");
  result = run(["doctor", "--workspace", ws, "--fix", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, ".ai", "agent-fleet-state.json"), "utf8")).runtimeRepairs, []);
  mkdirSync(join(ws, ".pi", "agents"), { recursive: true });
  const peers = join(ws, ".pi", "agents", "peers.yaml");
  writeFileSync(peers, "team:\n  runner: pi\n");
  result = run(["doctor", "--workspace", ws, "--json"]);
  assert.equal(result.status, 0, result.stderr, "advisories are non-actionable");
  assert.equal(readFileSync(peers, "utf8"), "team:\n  runner: pi\n", "bare doctor never changes advisory files");

  const tx = workspace();
  const backup = mkdtempSync(join(tmpdir(), "af-doctor-backup-"));
  mkdirSync(join(backup, ".ai"), { recursive: true });
  writeFileSync(join(backup, "restored.txt"), "restored");
  mkdirSync(join(tx, ".ai"), { recursive: true });
  writeFileSync(join(tx, ".ai", "agent-fleet-transaction.json"), JSON.stringify({ schemaVersion: 2, backup, paths: ["restored.txt"], present: ["restored.txt"] }));
  result = run(["doctor", "--workspace", tx, "--fix", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(tx, "restored.txt"), "utf8"), "restored");
  assert.equal(existsSync(join(tx, ".ai", "agent-fleet-transaction.json")), false);
});

test("doctor reports and --fix discards an unrecoverable installer journal", () => {
  const ws = workspace();
  mkdirSync(join(ws, ".ai"), { recursive: true });
  const journal = join(ws, ".ai", "agent-fleet-transaction.json");
  writeFileSync(journal, JSON.stringify({ schemaVersion: 2, backup: join(ws, "missing-backup"), paths: [], present: [] }));
  let result = run(["doctor", "--workspace", ws, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /unrecoverable-transaction/);
  assert.ok(existsSync(journal), "read-only doctor retains the journal");
  result = run(["doctor", "--workspace", ws, "--fix", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(journal), false, "--fix discards only the unrecoverable journal");
  assert.match(result.stdout, /discardedUnrecoverableJournal/);
});

test("A14 self-hosted just lifecycle removes itself last and package setup restores it", (context) => {
  if (spawnSync("just", ["--version"], { encoding: "utf8" }).error) {
    context.skip("just is not installed");
    return;
  }
  const ws = workspace();
  const fakeBin = join(ws, "fake-bin");
  try {
    let result = setup(ws, "--preset", "full", "--features", "none", "--yes");
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(ws, "justfile"), readFileSync(join(ws, "justfile"), "utf8") + "\nmine:\n    echo keep\n");
    mkdirSync(fakeBin);
    const fakeNpx = join(fakeBin, "npx");
    writeFileSync(fakeNpx, `#!/bin/sh\nshift\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} \"$@\"\n`);
    chmodSync(fakeNpx, 0o755);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    result = spawnSync("just", ["fleet", "uninstall", "--all", "--yes"], { cwd: ws, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /agent-fleet.*uninstall/i);
    assert.equal(readFileSync(join(ws, "justfile"), "utf8").includes("agent-fleet:harnesses"), false);
    assert.match(readFileSync(join(ws, "justfile"), "utf8"), /^mine:$/m);
    assert.equal(existsSync(join(ws, "scripts", "fleet.ts")), false);
    assert.equal(existsSync(join(ws, ".ai", "agent-fleet-state.json")), false);

    result = spawnSync(fakeNpx, ["@chankov/agent-fleet", "setup", "--workspace", ws, "--preset", "default", "--features", "none", "--yes"], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync("just", ["fleet", "doctor"], { cwd: ws, env, encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("A10 uninstall preserves human and foreign files, purges only on request, and removes recorded bridge hook", () => {
  const ws = workspace();
  let result = setup(ws, "--preset", "full", "--features", "none", "--yes");
  assert.equal(result.status, 0, result.stderr);
  mkdirSync(join(ws, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(ws, ".claude", "foreign.txt"), "foreign");
  writeFileSync(join(ws, ".claude", "hooks", "foreign.mjs"), "foreign");
  mkdirSync(join(ws, ".pi", "extensions", "foreign"), { recursive: true });
  writeFileSync(join(ws, ".pi", "extensions", "foreign", "index.js"), "foreign");
  writeFileSync(join(ws, ".ai", "agent-fleet-overrides.md"), "human");
  // The bridge hook is state-owned even though Full does not opt into the
  // Claude bridge feature. A recorded hook must be removed without touching
  // sibling foreign .claude content.
  const hook = readFileSync(join(root, "hooks", "coms-stop-hook.mjs"));
  writeFileSync(join(ws, ".claude", "hooks", "coms-stop-hook.mjs"), hook);
  const statePath = join(ws, ".ai", "agent-fleet-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.items["hook:coms-stop-hook"] = {
    kind: "hook", strategy: "copy-file", method: "copy", version: "0.0.11",
    files: [{ path: ".claude/hooks/coms-stop-hook.mjs", mode: "copy", sha256: createHash("sha256").update(hook).digest("hex") }],
  };
  writeFileSync(statePath, JSON.stringify(state));
  result = run(["uninstall", "--workspace", ws, "--all", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(ws, ".ai", "agent-fleet.json")));
  assert.ok(existsSync(join(ws, ".ai", "agent-fleet-overrides.md")));
  assert.ok(existsSync(join(ws, ".claude", "foreign.txt")));
  assert.ok(existsSync(join(ws, ".claude", "hooks", "foreign.mjs")));
  assert.ok(existsSync(join(ws, ".pi", "extensions", "foreign", "index.js")));
  assert.equal(existsSync(join(ws, ".claude", "hooks", "coms-stop-hook.mjs")), false, `recorded bridge hook is removed\n${result.stdout}\n${result.stderr}`);
  result = run(["uninstall", "--workspace", ws, "--all", "--purge-config", "--yes"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet.json")), false);
  assert.equal(existsSync(join(ws, ".ai", "agent-fleet-overrides.md")), false);
});
