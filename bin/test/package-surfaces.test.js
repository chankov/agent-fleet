// Package and deterministic lifecycle runtime-closure checks.
// This test exercises the manifest's
// copy/symlink/removal semantics against fixtures so its closure cannot drift.

import test from "node:test";
import assert from "node:assert/strict";
import {
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
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildPlan } from "../lib/plan.js";
import { applyPlan } from "../lib/apply.js";
import { extractRegion } from "../lib/merge-forms.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
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

test("manifest contains the complete Codex/Hermes/systemd runtime closure", () => {
  const paths = validateManifest(root);
  assert.deepEqual(paths.directories, ["codex", "hermes/skills", "systemd"]);
  assert.equal([...paths.directories, ...paths.files].some((path) => path.startsWith("hermes/desktop-plugins/") || path.startsWith("hermes/plugins/")), false);
  for (const required of [
    "justfile",
    "docs/codex-remote-conductor.md",
    "docs/coms-hermes-bridge.md",
    "scripts/codex-conductor.ts",
    "scripts/codex-remote-control.ts",
    "scripts/coms-cli.ts",
    "scripts/coms-hermes-bridge.ts",
    "scripts/team-up.ts",
    "scripts/lib/codex-conductor.ts",
    "scripts/lib/codex-remote-control.ts",
    "scripts/lib/coms-envelope.ts",
    "scripts/lib/herdr-layout.ts",
    "scripts/lib/hermes-bridge-core.ts",
    "scripts/lib/team-project.ts",
  ]) assert.ok(paths.files.includes(required), required);
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
    rmSync(join(fixture, "scripts", "lib", "codex-remote-control.ts"));
    assert.throws(() => validateManifest(fixture), /scripts\/lib\/codex-remote-control\.ts/);
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
      assert.match(installedJustfile, /_fleet-conductor-codex-setup/);
      assert.match(installedJustfile, /_fleet-conductor-codex team=/);
      assert.doesNotMatch(installedJustfile, /\n(?:hub|hub-team|team-up|safe-coms|conductor-codex)(?: |:)/);
      assert.equal(lstatSync(join(workspace, "codex")).isSymbolicLink(), method === "symlink");
      assert.equal(lstatSync(join(workspace, "scripts", "codex-remote-control.ts")).isSymbolicLink(), method === "symlink");
      assert.equal(existsSync(join(workspace, "hermes", "desktop-plugins")), false, `${method}: desktop plugins must not install`);
      assert.equal(existsSync(join(workspace, "hermes", "plugins")), false, `${method}: generic plugins must not install`);
      const fleetHelp = execFileSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          join(workspace, "scripts", "fleet.ts"),
          "help",
        ],
        { cwd: workspace, encoding: "utf8" },
      );
      assert.match(fleetHelp, /Agent Fleet — one guarded Hub runtime, two postures, independent topology/, `${method}: installed fleet entrypoint must load`);

      if (method === "copy") writeFileSync(join(workspace, "systemd", "user-owned.service"), "[Unit]\n");
      removeClosure(root, workspace, owned);
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /user-recipe/);
      assert.equal(readFileSync(join(workspace, "justfile"), "utf8").includes("agent-fleet:harnesses"), false);
      assert.equal(existsSync(join(workspace, "codex")), false);
      assert.equal(existsSync(join(workspace, "systemd", "user-owned.service")), method === "copy");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("package dry-run includes each versioned harness entrypoint, module, and adjacent manifest", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
  const paths = new Set(packed[0].files.map(({ path }) => path));
  assert.ok(paths.has("bin/catalog/harness-runtime-closure.json"), "relocated harness closure must ship in package");
  assert.equal([...paths].some((path) => /guided-workspace-setup|af-(?:setup|doctor)-agent-fleet/.test(path)), false, "tarball must not ship retired setup surfaces");
  const prompts = [...paths].filter((path) => path.startsWith(".pi/prompts/af-")).sort();
  assert.deepEqual(prompts, [
    ".pi/prompts/af-build.md", ".pi/prompts/af-code-simplify.md", ".pi/prompts/af-plan.md",
    ".pi/prompts/af-review.md", ".pi/prompts/af-set-hermes-telegram.md", ".pi/prompts/af-set-hermes-watchdog.md",
    ".pi/prompts/af-ship.md", ".pi/prompts/af-spec.md", ".pi/prompts/af-test.md",
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
  assert.equal([...paths].some((path) => path.startsWith("hermes/desktop-plugins/")), true, "desktop monitor runtime is packaged");
  assert.equal([...paths].some((path) => path.startsWith("hermes/plugins/")), true, "backend monitor runtime is packaged");
});

// The full watchdog release surface — runtime modules, lifecycle commands,
// exclusions, and content leak checks — lives in package-hermes-watchdog.test.js.
test("isolated tarball supports Default and Full deterministic setup", () => {
  const fixture = mkdtempSync(join(tmpdir(), "af-tarball-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8" }));
    const tarball = join(root, packed[0].filename);
    const extracted = join(fixture, "package");
    execFileSync("tar", ["-xzf", tarball, "-C", fixture]);

    for (const preset of ["default", "full"]) {
      const workspace = join(fixture, preset);
      mkdirSync(workspace);
      const result = execFileSync(process.execPath, [
        join(extracted, "bin", "cli.js"), "setup", "--workspace", workspace,
        "--preset", preset, "--features", "none", "--yes",
      ], { encoding: "utf8" });
      assert.match(result, /Setup complete\./);
      const desired = JSON.parse(readFileSync(join(workspace, ".ai", "agent-fleet.json"), "utf8"));
      assert.equal(desired.preset, preset);
      if (preset === "default") assert.equal(existsSync(join(workspace, ".claude")), false);
      else assert.ok(existsSync(join(workspace, ".claude", "hooks", "coms-stop-hook.mjs")));
    }
  } finally {
    for (const file of readdirSync(root)) if (/^chankov-agent-fleet-.*\.tgz$/.test(file)) rmSync(join(root, file), { force: true });
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
  for (const required of ["codex/", "hermes/README.md", "hermes/skills/", "systemd/", "docs/codex-remote-conductor.md", "docs/coms-hermes-bridge.md", "docs/MIGRATION-agent-fleet.md"]) {
    assert.ok(pkg.files.includes(required), `package files missing ${required}`);
  }
  assert.equal(pkg.files.includes("hermes/"), false);
  assert.ok(pkg.files.includes("hermes/plugins/"));
  assert.ok(pkg.files.includes("hermes/desktop-plugins/"));
  assert.ok(pkg.files.includes("!hermes/watchdog-tests/"));
  assert.ok(pkg.files.includes("!hermes/**/__pycache__/"));
  assert.match(pkg.scripts.test, /scripts\/coms-cli\.test\.ts/);
  assert.match(pkg.scripts.test, /scripts\/lib\/codex-remote-control\.test\.ts/);
  const snapshot = readFileSync(join(root, "bin", "snapshot-version.js"), "utf8");
  for (const required of ["codex", "hermes", "systemd", "docs/codex-remote-conductor.md", "docs/coms-hermes-bridge.md", "scripts", "justfile", "bin/catalog/harness-runtime-closure.json"]) {
    assert.match(snapshot, new RegExp(`"${required}"`), `snapshot missing ${required}`);
  }
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

test("the relocated harness runtime closure is a manifest companion of every harness", () => {
  const installManifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  const closure = installManifest.items.find((i) => i.id === "companion:harness-runtime-closure");
  assert.ok(closure, "the relocated harness closure has no manifest item");
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
