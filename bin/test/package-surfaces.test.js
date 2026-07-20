// Package and guided-setup runtime closure checks for the pre-Gate-P Codex pilot.
// The guided installer is skill-driven; this test exercises the manifest's
// copy/symlink/removal semantics against fixtures so its closure cannot drift.

import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(root, "skills", "guided-workspace-setup", "companion-manifest.json");
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
  assert.deepEqual(paths.directories, ["codex", "hermes", "systemd"]);
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
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /conductor-codex-pilot/);
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /conductor-codex-setup/);
      assert.match(readFileSync(join(workspace, "justfile"), "utf8"), /conductor-codex team=/);
      assert.equal(lstatSync(join(workspace, "codex")).isSymbolicLink(), method === "symlink");
      assert.equal(lstatSync(join(workspace, "scripts", "codex-remote-control.ts")).isSymbolicLink(), method === "symlink");

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

test("package, snapshot, and guided manifest surfaces stay aligned", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const required of ["codex/", "hermes/", "systemd/", "docs/codex-remote-conductor.md", "docs/coms-hermes-bridge.md"]) {
    assert.ok(pkg.files.includes(required), `package files missing ${required}`);
  }
  assert.match(pkg.scripts.test, /scripts\/coms-cli\.test\.ts/);
  assert.match(pkg.scripts.test, /scripts\/lib\/codex-remote-control\.test\.ts/);
  const snapshot = readFileSync(join(root, "bin", "snapshot-version.js"), "utf8");
  for (const required of ["codex", "hermes", "systemd", "docs/codex-remote-conductor.md", "docs/coms-hermes-bridge.md", "scripts", "justfile"]) {
    assert.match(snapshot, new RegExp(`"${required}"`), `snapshot missing ${required}`);
  }
  assert.doesNotMatch(snapshot, /^\s*"docs",$/m, "snapshot must not include docs omitted from the package root allowlist");
  const skill = readFileSync(join(root, "skills", "guided-workspace-setup", "SKILL.md"), "utf8");
  assert.match(skill, /companion-manifest\.json/);
  assert.match(skill, /last.*pi harness/i);
});
