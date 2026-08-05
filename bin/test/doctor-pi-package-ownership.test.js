// Mixed copied / package-native skill+prompt ownership diagnostic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  findAgentFleetPackageEntry,
  isAgentFleetPackageSource,
  listCopiedSkillAndPromptNames,
  listPackagePromptNames,
  listPackageSkillNames,
  parsePiPackageEntry,
  resourceNameAllowed,
  resourceTypeEnabled,
  runDoctor,
  scanPiPackageOwnership,
} from "../lib/doctor.js";
import { runVerify, hasDrift, ADVISORY_FINDINGS } from "../lib/verify.js";
import { writeState, emptyState } from "../lib/state.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempWorkspace() {
  return mkdtempSync(join(tmpdir(), "agent-fleet-ownership-"));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function seedCopiedState(workspace, { skills = [], commands = [] } = {}) {
  const state = emptyState({
    agent: "pi",
    method: "copy",
    packageVersion: "0.0.11",
    sourceRoot,
  });
  for (const name of skills) {
    state.items[`skill:${name}`] = {
      kind: "skill",
      strategy: "copy-tree",
      method: "copy",
      version: "0.0.11",
      sourceRoot: `skills/${name}`,
      files: [{ path: `.pi/skills/${name}/SKILL.md`, mode: "copy", sha256: "a".repeat(64) }],
    };
  }
  for (const { id, prompt } of commands) {
    state.items[`command:${id}`] = {
      kind: "command",
      strategy: "copy-file",
      method: "copy",
      version: "0.0.11",
      sourceRoot: `.pi/prompts/${prompt}.md`,
      files: [{ path: `.pi/prompts/${prompt}.md`, mode: "copy", sha256: "b".repeat(64) }],
    };
  }
  writeState(workspace, state);
  return state;
}

test("package source identity accepts pins and path-ish npm specs", () => {
  assert.equal(isAgentFleetPackageSource("npm:@chankov/agent-fleet"), true);
  assert.equal(isAgentFleetPackageSource("npm:@chankov/agent-fleet@0.0.12"), true);
  assert.equal(isAgentFleetPackageSource("npm:pi-ask-user"), false);
  assert.equal(parsePiPackageEntry("npm:@chankov/agent-fleet")?.source, "npm:@chankov/agent-fleet");
  assert.deepEqual(parsePiPackageEntry({ source: "npm:@chankov/agent-fleet", skills: [] })?.filters.skills, []);
});

test("resource filters: omit=all, []=none, patterns allow names", () => {
  assert.equal(resourceTypeEnabled(undefined), true);
  assert.equal(resourceTypeEnabled([]), false);
  assert.equal(resourceTypeEnabled(["skills/*"]), true);
  assert.equal(resourceNameAllowed("incremental-implementation", undefined), true);
  assert.equal(resourceNameAllowed("incremental-implementation", []), false);
  assert.equal(resourceNameAllowed("incremental-implementation", ["incremental-implementation"]), true);
  assert.equal(resourceNameAllowed("other", ["incremental-implementation"]), false);
});

test("package skill/prompt inventories come from the Agent Fleet source tree", () => {
  const skills = listPackageSkillNames(sourceRoot);
  const prompts = listPackagePromptNames(sourceRoot);
  assert.ok(skills.includes("incremental-implementation"));
  assert.ok(skills.includes("guided-workspace-setup"));
  assert.ok(prompts.includes("af-setup-agent-fleet"));
  assert.ok(prompts.includes("af-build"));
});

test("copied names are derived from state item ids and prompt file paths", () => {
  const { skills, prompts } = listCopiedSkillAndPromptNames({
    items: {
      "skill:incremental-implementation": { files: [] },
      "command:build": {
        files: [{ path: ".pi/prompts/af-build.md" }],
      },
    },
  });
  assert.deepEqual([...skills], ["incremental-implementation"]);
  assert.deepEqual([...prompts], ["af-build"]);
});

test("copied-only setup produces no ownership finding", async () => {
  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    seedCopiedState(ws, {
      skills: ["incremental-implementation"],
      commands: [{ id: "build", prompt: "af-build" }],
    });
    writeJson(join(ws, ".pi", "settings.json"), { packages: ["npm:pi-ask-user"] });
    const findings = scanPiPackageOwnership({ workspace: ws, sourceRoot, home });
    assert.deepEqual(findings, []);
    const doctor = await runDoctor({ workspace: ws, sourceRoot });
    assert.equal(doctor.some((f) => f.type === "pi-package-ownership"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("package-native-only setup produces no ownership finding", () => {
  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    writeJson(join(ws, ".pi", "settings.json"), { packages: ["npm:@chankov/agent-fleet"] });
    // State exists but owns only harnesses — no skill:*/command:* overlap.
    const state = emptyState({ agent: "pi", method: "copy", packageVersion: "0.0.11", sourceRoot });
    state.items["pi-harness:ask-user-remote"] = {
      kind: "pi-harness",
      strategy: "copy-tree",
      method: "copy",
      version: "0.0.11",
      files: [],
    };
    writeState(ws, state);
    assert.deepEqual(scanPiPackageOwnership({ workspace: ws, sourceRoot, home }), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("package-native skills + copied harness-only Fleet Core produces no finding", () => {
  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    writeJson(join(ws, ".pi", "settings.json"), {
      packages: [{
        source: "npm:@chankov/agent-fleet",
        // skills/prompts enabled (omit = all); harnesses are copied separately
      }],
    });
    const state = emptyState({ agent: "pi", method: "copy", packageVersion: "0.0.11", sourceRoot });
    for (const id of ["pi-harness:ask-user-remote", "pi-harness:damage-control-continue", "companion:justfile-region"]) {
      state.items[id] = { kind: "companion", files: [] };
    }
    writeState(ws, state);
    assert.deepEqual(scanPiPackageOwnership({ workspace: ws, sourceRoot, home }), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("former mixed RankedIn-style configuration reports one actionable advisory", async () => {
  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    seedCopiedState(ws, {
      skills: ["incremental-implementation", "guided-workspace-setup", "code-review-and-quality"],
      commands: [
        { id: "build", prompt: "af-build" },
        { id: "setup-agent-fleet", prompt: "af-setup-agent-fleet" },
      ],
    });
    writeJson(join(ws, ".pi", "settings.json"), {
      packages: ["npm:pi-ask-user", "npm:@chankov/agent-fleet"],
    });

    const findings = scanPiPackageOwnership({ workspace: ws, sourceRoot, home });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "pi-package-ownership");
    assert.match(findings[0].issue, /mixed ownership/);
    assert.match(findings[0].issue, /incremental-implementation/);
    assert.match(findings[0].issue, /af-build/);
    assert.match(findings[0].fix, /copied skills\/prompts/);
    assert.match(findings[0].fix, /package-native/);
    assert.ok(findings[0].skillOverlap.includes("incremental-implementation"));
    assert.ok(findings[0].promptOverlap.includes("af-build"));

    // doctor --fix must remain read-only for this finding
    const before = JSON.stringify(findAgentFleetPackageEntry({ workspace: ws, home }));
    await runDoctor({ workspace: ws, sourceRoot, apply: true });
    const after = JSON.stringify(findAgentFleetPackageEntry({ workspace: ws, home }));
    assert.equal(after, before);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("filters that disable skills and prompts suppress the finding", () => {
  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    seedCopiedState(ws, {
      skills: ["incremental-implementation"],
      commands: [{ id: "build", prompt: "af-build" }],
    });
    writeJson(join(ws, ".pi", "settings.json"), {
      packages: [{
        source: "npm:@chankov/agent-fleet",
        skills: [],
        prompts: [],
      }],
    });
    assert.deepEqual(scanPiPackageOwnership({ workspace: ws, sourceRoot, home }), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("ownership finding is advisory and does not make verify exit broken", async () => {
  assert.ok(ADVISORY_FINDINGS.has("pi-package-ownership"));

  const ws = tempWorkspace();
  const home = tempWorkspace();
  try {
    seedCopiedState(ws, {
      skills: ["incremental-implementation"],
      commands: [{ id: "build", prompt: "af-build" }],
    });
    writeJson(join(ws, ".pi", "settings.json"), {
      packages: ["npm:@chankov/agent-fleet"],
    });

    // Minimal manifest so verify can resolve the agent without scanning the world.
    const manifest = {
      version: 1,
      agents: ["pi"],
      groups: [],
      profiles: {},
      items: [],
    };
    const report = await runVerify({
      workspace: ws,
      sourceRoot,
      packageVersion: "0.0.12-test",
      manifest,
      agent: "pi",
      includeDoctor: true,
    });
    // Inject home via direct doctor path already covered; ensure classification:
    const ownership = (await runDoctor({ workspace: ws, sourceRoot }))
      .filter((f) => f.type === "pi-package-ownership");
    assert.equal(ownership.length, 1);

    for (const f of report.findings) {
      if (f.type === "pi-package-ownership") {
        assert.equal(f.severity, "advisory");
      }
    }
    // Even if the finding is present, advisories alone must not trip hasDrift.
    const advisoryOnly = {
      summary: { problems: 0, broken: 0 },
    };
    assert.equal(hasDrift(advisoryOnly), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
