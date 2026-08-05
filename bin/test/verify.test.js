// Tests for the read-only verify pass (Phase 2 of the deterministic installer).
//
// Everything runs against a synthetic source root and a temp workspace so the
// three-way cases (base snapshot × recorded hash × current source) can be set
// up exactly, and so no test ever writes into the real repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runVerify, hasDrift, BROKEN_STATES } from "../lib/verify.js";
import { hashFile, hashText, STATE_SCHEMA_VERSION, STATE_REL_PATH } from "../lib/state.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const PERSONA = `---
name: demo-persona
description: A demo persona
tools: read, grep
model: claude-sonnet-4
---

Body text.
`;

function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Synthetic package: one tree skill, one persona, one multi-source companion. */
function makeSource(tmp, { skillBody = "v2 skill\n" } = {}) {
  const src = join(tmp, "src");
  write(src, "skills/demo/SKILL.md", skillBody);
  write(src, "skills/demo/reference.md", "shared reference\n");
  write(src, "agents/demo-persona.md", PERSONA);
  write(src, "extras/one.txt", "one\n");
  write(src, "extras/two.txt", "two\n");
  return src;
}

function manifestFor(packageVersion = "0.0.2") {
  return {
    schemaVersion: 1,
    packageVersion,
    groups: [
      { id: "skills", title: "Skills", order: 1, agents: ["pi"], subcategories: [] },
      { id: "personas", title: "Personas", order: 2, agents: ["pi"], subcategories: [] },
      { id: "companions", title: "Companions", order: 3, agents: ["pi"], subcategories: [] },
    ],
    profiles: {},
    items: [
      {
        id: "skill:demo", kind: "skill", group: "skills", subcategory: null,
        title: "demo", summary: "", recommended: true, consent: "file", platform: "any",
        agents: {
          pi: { source: ["skills/demo"], sourceMode: "first", target: ".pi/skills/demo", strategy: "copy-tree" },
        },
      },
      {
        id: "persona:demo-persona", kind: "persona", group: "personas", subcategory: null,
        title: "demo-persona", summary: "", recommended: false, consent: "file", platform: "any",
        agents: {
          pi: {
            source: ["agents/demo-persona.md"], sourceMode: "first",
            target: "agents/demo-persona.md", strategy: "copy-file",
          },
        },
      },
      {
        id: "companion:extras", kind: "companion", group: "companions", subcategory: null,
        title: "extras", summary: "", recommended: false, consent: "file", platform: "any",
        agents: {
          pi: {
            source: ["extras/one.txt", "extras/two.txt"], sourceMode: "all",
            target: null, preserveLayout: true, strategy: "copy-tree",
          },
        },
      },
      {
        id: "companion:deps", kind: "companion", group: "companions", subcategory: null,
        title: "deps", summary: "", recommended: false, consent: "exec", platform: "any",
        exec: { command: "npm", args: ["ci"], cwd: "." },
        agents: { pi: { source: [], sourceMode: "first", target: null, strategy: "exec" } },
      },
      {
        id: "hermes-plugin:demo", kind: "hermes-plugin", group: "companions", subcategory: null,
        title: "demo", summary: "", recommended: false, consent: "operator", platform: "any",
        agents: { pi: { source: [], sourceMode: "first", target: null, strategy: "operator" } },
      },
    ],
  };
}

function stateWith({ agent = "pi", method = "copy", packageVersion = "0.0.1", sourceRoot, items = {} }) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    agent, method, packageVersion, sourceRoot,
    profiles: [],
    installedAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items,
    externalPackages: [],
    events: [],
  };
}

async function withTmp(fn) {
  const tmp = mkdtempSync(join(tmpdir(), "af-verify-"));
  try { return await fn(tmp); } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const verify = (workspace, sourceRoot, manifest, extra = {}) =>
  runVerify({
    workspace, sourceRoot, manifest,
    packageVersion: manifest.packageVersion,
    agent: "pi", includeDoctor: false, ...extra,
  });

const stateOf = (report, id) => report.items.find((i) => i.id === id);

// ── states ──────────────────────────────────────────────────────────────────

test("a fresh workspace reports everything absent and no drift", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    mkdirSync(ws);

    const report = await verify(ws, src, manifestFor());

    assert.equal(stateOf(report, "skill:demo").state, "absent");
    assert.equal(stateOf(report, "companion:extras").state, "absent");
    assert.equal(report.stateSource, "none");
    assert.equal(report.summary.installed, 0);
    assert.equal(hasDrift(report), false);
  });
});

test("a faithfully installed and recorded item is up to date", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    cpSync(join(src, "skills/demo"), join(ws, ".pi/skills/demo"), { recursive: true });

    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      items: {
        "skill:demo": {
          kind: "skill", strategy: "copy-tree", method: "copy",
          files: [
            { path: ".pi/skills/demo/SKILL.md", sha256: hashFile(join(src, "skills/demo/SKILL.md")) },
            { path: ".pi/skills/demo/reference.md", sha256: hashFile(join(src, "skills/demo/reference.md")) },
          ],
        },
      },
    })));

    const report = await verify(ws, src, manifestFor());
    const item = stateOf(report, "skill:demo");
    assert.equal(item.state, "up-to-date");
    assert.equal(item.owned, true);
    assert.equal(item.changedCount, 0);
    // The synthetic source has no .versions/0.0.1 snapshot; that is advisory,
    // not a defect, so it must not fail the run.
    assert.equal(report.summary.advisories, 1);
    assert.equal(report.summary.problems, 0);
    assert.equal(hasDrift(report), false);
  });
});

test("a locally edited file is modified, not outdated", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    cpSync(join(src, "skills/demo"), join(ws, ".pi/skills/demo"), { recursive: true });

    const recorded = hashFile(join(src, "skills/demo/SKILL.md"));
    write(ws, ".pi/skills/demo/SKILL.md", "my own edit\n");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      items: {
        "skill:demo": {
          kind: "skill", strategy: "copy-tree", method: "copy",
          files: [{ path: ".pi/skills/demo/SKILL.md", sha256: recorded }],
        },
      },
    })));

    const item = stateOf(await verify(ws, src, manifestFor()), "skill:demo");
    assert.equal(item.state, "modified");
    assert.equal(item.files[0].path, ".pi/skills/demo/SKILL.md");
  });
});

test("an untouched copy behind a newer source is outdated", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp, { skillBody: "v2 skill\n" });
    const ws = join(tmp, "ws");
    // The workspace holds v1 and the state records v1 — the copy is faithful,
    // the source has simply moved on.
    write(ws, ".pi/skills/demo/SKILL.md", "v1 skill\n");
    write(ws, ".pi/skills/demo/reference.md", "shared reference\n");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      items: {
        "skill:demo": {
          kind: "skill", strategy: "copy-tree", method: "copy",
          files: [{ path: ".pi/skills/demo/SKILL.md", sha256: hashText("v1 skill\n") }],
        },
      },
    })));

    const report = await verify(ws, src, manifestFor());
    assert.equal(stateOf(report, "skill:demo").state, "outdated");
    // An available upgrade is not a broken workspace.
    assert.equal(report.summary.broken, 0);
    assert.equal(report.summary.upgradable, 1);
    assert.equal(hasDrift(report), false);
  });
});

test("both sides changed since the base snapshot is a conflict", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp, { skillBody: "upstream v2\n" });
    write(src, ".versions/0.0.1/skills/demo/SKILL.md", "base v1\n");

    const ws = join(tmp, "ws");
    write(ws, ".pi/skills/demo/SKILL.md", "my v1 edit\n");
    write(ws, ".pi/skills/demo/reference.md", "shared reference\n");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      packageVersion: "0.0.1",
      items: {
        "skill:demo": {
          kind: "skill", strategy: "copy-tree", method: "copy",
          files: [{ path: ".pi/skills/demo/SKILL.md", sha256: hashText("base v1\n") }],
        },
      },
    })));

    const report = await verify(ws, src, manifestFor("0.0.2"));
    assert.equal(stateOf(report, "skill:demo").state, "conflict");
    assert.ok(BROKEN_STATES.has("conflict"));
    assert.equal(hasDrift(report), true);
    assert.equal(report.summary.versionDrift, true);
    assert.equal(report.baseAvailable, true);
  });
});

test("a local edit with the upstream unchanged stays modified even with a base", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp, { skillBody: "same both sides\n" });
    write(src, ".versions/0.0.1/skills/demo/SKILL.md", "same both sides\n");

    const ws = join(tmp, "ws");
    write(ws, ".pi/skills/demo/SKILL.md", "my edit\n");
    write(ws, ".pi/skills/demo/reference.md", "shared reference\n");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      packageVersion: "0.0.1",
      items: {
        "skill:demo": {
          kind: "skill", strategy: "copy-tree", method: "copy",
          files: [{ path: ".pi/skills/demo/SKILL.md", sha256: hashText("same both sides\n") }],
        },
      },
    })));

    assert.equal(stateOf(await verify(ws, src, manifestFor()), "skill:demo").state, "modified");
  });
});

test("a recorded item deleted from disk is missing", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src,
      items: { "skill:demo": { kind: "skill", strategy: "copy-tree", method: "copy", files: [] } },
    })));

    const report = await verify(ws, src, manifestFor());
    assert.equal(stateOf(report, "skill:demo").state, "missing");
    assert.equal(hasDrift(report), true);
  });
});

test("an item present but never recorded is reported as unowned", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, ".pi/skills/demo/SKILL.md", "someone else put this here\n");

    const item = stateOf(await verify(ws, src, manifestFor()), "skill:demo");
    assert.equal(item.owned, false);
    assert.match(item.detail, /not recorded/);
  });
});

// ── symlinks ────────────────────────────────────────────────────────────────

test("a symlink into the source root is linked, not compared", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, ".pi/skills"), { recursive: true });
    symlinkSync(join(src, "skills/demo"), join(ws, ".pi/skills/demo"));

    const item = stateOf(await verify(ws, src, manifestFor()), "skill:demo");
    assert.equal(item.state, "linked");
    // linkTarget is a realpath; src is not, and on macOS /var is a symlink.
    assert.ok(item.linkTarget.startsWith(realpathSync(src)));
  });
});

test("a dangling symlink is broken and fails the run", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    mkdirSync(join(ws, ".pi/skills"), { recursive: true });
    symlinkSync(join(src, "skills/gone-away"), join(ws, ".pi/skills/demo"));

    const report = await verify(ws, src, manifestFor());
    assert.equal(stateOf(report, "skill:demo").state, "broken-link");
    assert.equal(hasDrift(report), true);
  });
});

test("a symlink resolving outside the source root is flagged", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(tmp, "elsewhere/demo/SKILL.md", "not ours\n");
    mkdirSync(join(ws, ".pi/skills"), { recursive: true });
    symlinkSync(join(tmp, "elsewhere/demo"), join(ws, ".pi/skills/demo"));

    const item = stateOf(await verify(ws, src, manifestFor()), "skill:demo");
    assert.equal(item.state, "foreign-link");
    assert.match(item.files[0].detail, /outside the source root/);
  });
});

// ── strategies ──────────────────────────────────────────────────────────────

test("personas compare byte-for-byte against the canonical source", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    // agents/*.md is already written in pi's dialect, so install is a plain
    // copy and an untouched copy must read as up-to-date.
    write(ws, "agents/demo-persona.md", PERSONA);
    assert.equal(
      stateOf(await verify(ws, src, manifestFor()), "persona:demo-persona").state,
      "up-to-date",
    );

    write(ws, "agents/demo-persona.md", PERSONA + "\nlocal edit\n");
    assert.equal(
      stateOf(await verify(ws, src, manifestFor()), "persona:demo-persona").state,
      "modified",
    );
  });
});

test('sourceMode "all" with preserveLayout checks every source at its own path', async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, "extras/one.txt", "one\n");

    // One of two present → incomplete, but nothing is broken.
    const partial = stateOf(await verify(ws, src, manifestFor()), "companion:extras");
    assert.equal(partial.state, "partial");
    assert.equal(hasDrift(await verify(ws, src, manifestFor())), false);

    write(ws, "extras/two.txt", "two\n");
    assert.equal(stateOf(await verify(ws, src, manifestFor()), "companion:extras").state, "up-to-date");

    write(ws, "extras/two.txt", "edited\n");
    assert.equal(stateOf(await verify(ws, src, manifestFor()), "companion:extras").state, "modified");
  });
});

test("exec, operator, and external items are never inspected on disk", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    mkdirSync(ws);

    const report = await verify(ws, src, manifestFor());
    const exec = stateOf(report, "companion:deps");
    const operator = stateOf(report, "hermes-plugin:demo");
    assert.equal(exec.state, "not-applicable");
    assert.match(exec.detail, /--allow-exec/);
    assert.equal(operator.state, "not-applicable");
    assert.match(operator.detail, /operator-applied/);
  });
});

test("an item whose source vanished from the package reports gone", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, ".pi/skills/demo/SKILL.md", "still here\n");
    rmSync(join(src, "skills/demo"), { recursive: true });

    const report = await verify(ws, src, manifestFor());
    assert.equal(stateOf(report, "skill:demo").state, "gone");
    assert.equal(hasDrift(report), true);
  });
});

// ── findings ────────────────────────────────────────────────────────────────

test("a missing base snapshot is reported, not guessed around", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({ sourceRoot: src, packageVersion: "0.0.1" })));

    const report = await verify(ws, src, manifestFor("0.0.2"));
    assert.equal(report.baseAvailable, false);
    assert.ok(report.findings.some((f) => f.type === "base-snapshot-missing"));
  });
});

test("a vanished or volatile source root is reported", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: join(tmp, "gone"), packageVersion: "0.0.2",
    })));
    const gone = await verify(ws, src, manifestFor());
    assert.ok(gone.findings.some((f) => f.type === "source-root-missing"));

    // The volatile-npx-cache warning only applies where symlinks are still a
    // supported mode at all, i.e. inside an agent-fleet checkout.
    write(ws, "package.json", JSON.stringify({ name: "@chankov/agent-fleet" }));
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: "/home/u/.npm/_npx/abc/node_modules/@chankov/agent-fleet",
      method: "symlink", packageVersion: "0.0.2",
    })));
    const volatile = await verify(ws, src, manifestFor());
    assert.ok(volatile.findings.some((f) => f.type === "source-root-volatile"));
  });
});

test("a symlink install outside an agent-fleet checkout is reported as retired", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, STATE_REL_PATH, JSON.stringify(stateWith({
      sourceRoot: src, method: "symlink", packageVersion: "0.0.2",
    })));

    const report = await verify(ws, src, manifestFor());
    const finding = report.findings.find((f) => f.type === "symlink-retired");
    assert.ok(finding, "no symlink-retired finding");
    assert.equal(
      finding.severity, "advisory",
      "an older install method is not a broken workspace — the next apply migrates it",
    );
    assert.equal(hasDrift(report), false);
  });
});

test("an unknown state schema is reported rather than misread", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    const state = stateWith({ sourceRoot: src, packageVersion: "0.0.2" });
    state.schemaVersion = 99;
    write(ws, STATE_REL_PATH, JSON.stringify(state));

    const report = await verify(ws, src, manifestFor());
    assert.ok(report.findings.some((f) => f.type === "state-schema"));
    assert.equal(hasDrift(report), true);
  });
});

test("a pre-engine markdown record still yields the recorded version", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    write(ws, ".ai/agent-fleet-setup.md", "## workspace-summary\nversion: 0.0.1\nagent: pi\n");

    const report = await verify(ws, src, manifestFor("0.0.2"));
    assert.equal(report.stateSource, "legacy-record");
    assert.equal(report.recordedVersion, "0.0.1");
    assert.equal(report.summary.versionDrift, true);
    // A legacy record proves nothing about ownership.
    assert.equal(report.summary.installed, 0);
  });
});

test("verify writes nothing to the workspace", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    cpSync(join(src, "skills/demo"), join(ws, ".pi/skills/demo"), { recursive: true });
    const before = hashFile(join(ws, ".pi/skills/demo/SKILL.md"));

    await verify(ws, src, manifestFor());

    assert.equal(hashFile(join(ws, ".pi/skills/demo/SKILL.md")), before);
    assert.equal(hashFile(join(ws, STATE_REL_PATH)), null, "verify must not create a state file");
  });
});

test("without a resolvable agent, verify reports it instead of guessing", async () => {
  await withTmp(async (tmp) => {
    const src = makeSource(tmp);
    const ws = join(tmp, "ws");
    mkdirSync(ws);

    const report = await verify(ws, src, manifestFor(), { agent: null });
    assert.equal(report.items.length, 0);
    assert.ok(report.findings.some((f) => f.type === "agent-unknown"));
    assert.equal(hasDrift(report), true);
  });
});
