// Guards for the .pi/agent-fleet relocation.
//
// `scripts/`, `hermes/` and `hooks/` moved under `.pi/agent-fleet/` and the
// personas moved to `.pi/agents/personas/`. Two failure modes outlive the move
// itself, and neither is caught by anything else in the suite:
//
//   • a relative import that still points at the old location. The harnesses
//     import the fleet runtime lazily, so `just fleet` starts clean and the
//     ERR_MODULE_NOT_FOUND lands on an operator running `/debate`.
//   • a stale path in agent-readable markdown. It never throws; it teaches the
//     next agent to write to `agents/` again, and the footprint grows back.
//
// Both rules also apply to the next move, which is the point of keeping them.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MOVED_TO, RETIRED_ROOTS, installedMarkdown, retiredRootMentions, unresolvedSpecifiers,
} from "../lib/path-boundaries.js";
import { walkTree } from "../lib/state.js";
import { pruneEmptyDirs } from "../lib/apply.js";
import { RUNTIME_DEPENDENCY_ROOTS } from "../../.pi/agent-fleet/scripts/lib/runtime-dependencies.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0").filter(Boolean);

const SOURCE_ROOTS = ["bin/", ".pi/", "skills/"];
const sourceFiles = tracked.filter((f) =>
  SOURCE_ROOTS.some((prefix) => f.startsWith(prefix)) &&
  /\.(ts|js|mjs|cjs)$/.test(f) &&
  !f.includes("/node_modules/") &&
  !f.startsWith("bin/test/fixtures/"));

// A path that is deliberately expected NOT to exist, asserted as such.
const EXPECTED_ABSENT = new Set([
  ".pi/harnesses/agent-hub/work-mode-integration.test.ts::./tools/ask-user.ts",
]);

test("every relative import resolves — nothing points at a moved directory", () => {
  const broken = [];
  for (const file of sourceFiles) {
    const source = readFileSync(join(root, file), "utf8");
    for (const hit of unresolvedSpecifiers({ root, file, source })) {
      if (EXPECTED_ABSENT.has(`${file}::${hit.specifier}`)) continue;
      broken.push(`${hit.file}: ${hit.specifier} → ${hit.resolved}`);
    }
  }
  assert.deepEqual(broken, [], `unresolved relative imports:\n  ${broken.join("\n  ")}`);
});

// Fixture strings that happen to look like a workspace path. Each entry is a
// file plus the reason the match is not a real reference.
const CODE_ALLOWLIST = new Map([
  [".pi/harnesses/agent-hub/drift-watchdog.test.js", "an arbitrary write path in a watchdog rule fixture"],
  [".pi/harnesses/agent-hub/return-contract.test.js", "fabricated evidence text in a return-contract fixture"],
  ["bin/test/apply.test.js", "a synthetic source tree built inside the test's own tmpdir"],
  ["bin/lib/path-boundaries.js", "the checker names the roots it forbids"],
  ["bin/test/path-boundaries.test.js", "this test names the roots it forbids"],
  [".pi/agent-fleet/scripts/workflows/lib/permissions.test.ts", "arbitrary write globs in a permission fixture"],
  ["bin/lib/state.js", "the schemaVersion comment names the roots the bump is about"],
]);

test("no shipped code or data names a retired workspace root", () => {
  const files = [
    ...sourceFiles,
    "justfile",
    "package.json",
    "manifest-meta.json",
    "install-manifest.json",
    "bin/catalog/harness-runtime-closure.json",
  ].filter((f) => !CODE_ALLOWLIST.has(f));

  const hits = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const hit of retiredRootMentions({ file, source })) {
      hits.push(`${hit.file}:${hit.line} — ${hit.root}/ moved to ${MOVED_TO[hit.root]}/ · ${hit.text}`);
    }
  }
  assert.deepEqual(hits, [], `retired workspace roots still referenced:\n  ${hits.join("\n  ")}`);
});

// Markdown that installs into a workspace is read by agents, so a stale path in
// it is an instruction, not a typo. `agents/` joins the list here (and only
// here): it is still a valid place for a *user's* persona, but an installed
// document must not send an agent there instead of `.pi/agents/personas/`.
const DOC_ROOTS = [...RETIRED_ROOTS, "agents"];
const DOC_ALLOWLIST = new Map([
  ["references/orchestration-patterns.md", "describes the Claude Code plugin layout, not an agent-fleet workspace"],
]);

test("agent-readable installed markdown names no retired workspace root", () => {
  const manifest = JSON.parse(readFileSync(join(root, "install-manifest.json"), "utf8"));
  const docs = installedMarkdown({ root, manifest, walk: walkTree })
    // Vendored upstream skills are a pristine import at a pinned SHA and are
    // never edited in place (docs/UPSTREAM-SKILLS.md). A shadowing native skill
    // under `skills/` is the supported way to correct one, and those are
    // checked here like everything else.
    .filter((f) => !f.startsWith("vendor/") && !DOC_ALLOWLIST.has(f));
  assert.ok(docs.length > 50, `expected the installed markdown surface, got ${docs.length}`);

  const hits = [];
  for (const file of docs) {
    const source = readFileSync(join(root, file), "utf8");
    for (const hit of retiredRootMentions({ file, source, roots: DOC_ROOTS })) {
      hits.push(`${hit.file}:${hit.line} — ${hit.root}/ moved to ${MOVED_TO[hit.root]}/ · ${hit.text}`);
    }
  }
  assert.deepEqual(hits, [], `installed markdown still names a retired root:\n  ${hits.join("\n  ")}`);
});

test("every runtime npm root in the closure exists after a move", () => {
  // Risk 2 of the relocation: RUNTIME_DEPENDENCY_ROOTS is a hand-written list
  // of workspace paths, and `just fleet` refuses to launch when one is broken.
  for (const { root: rel } of RUNTIME_DEPENDENCY_ROOTS) {
    assert.ok(statSync(join(root, rel)).isDirectory(), `${rel} does not exist in the package`);
  }
});

test("retiring a moved tree prunes the directories it emptied", () => {
  // Phase 6 of the relocation plan: no migration script, so the existing
  // cleanup has to climb. A `scripts/workflows/lib/x.ts` that leaves a binding
  // must take `lib/`, `workflows/` and `scripts/` with it — otherwise the
  // footprint "shrinks" to a tree of empty directories.
  const ws = mkdtempSync(join(tmpdir(), "af-prune-"));
  try {
    const deep = join(ws, "scripts", "workflows", "lib");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "x.ts"), "export const x = 1;\n");
    writeFileSync(join(ws, "keep.txt"), "mine\n");

    pruneEmptyDirs(ws, ["scripts/workflows/lib/x.ts"]);
    assert.equal(existsSync(join(deep, "x.ts")), true, "prune removes directories, never files");

    rmSync(join(deep, "x.ts"));
    pruneEmptyDirs(ws, ["scripts/workflows/lib/x.ts"]);
    assert.equal(existsSync(join(ws, "scripts")), false, "the whole emptied chain goes");
    assert.equal(existsSync(join(ws, "keep.txt")), true, "nothing outside the chain is touched");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a directory the user still owns survives the prune", () => {
  const ws = mkdtempSync(join(tmpdir(), "af-prune-keep-"));
  try {
    mkdirSync(join(ws, "scripts", "lib"), { recursive: true });
    writeFileSync(join(ws, "scripts", "mine.sh"), "echo hi\n");
    pruneEmptyDirs(ws, ["scripts/lib/x.ts"]);
    assert.equal(existsSync(join(ws, "scripts", "lib")), false, "the emptied leaf goes");
    assert.equal(existsSync(join(ws, "scripts", "mine.sh")), true, "the user's file keeps its directory");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
