// Tests for the advisory overrides-file validation. Each test builds a tiny
// temp workspace so folder- and .env-dependent checks run against real files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateOverrides, OVERRIDES_REL_PATH } from "../lib/validate-overrides.js";
import { runDoctor } from "../lib/doctor.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function workspaceWith(overridesText, { extraFiles = {} } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "agent-fleet-overrides-"));
  if (overridesText !== null) {
    mkdirSync(join(ws, ".ai"), { recursive: true });
    writeFileSync(join(ws, OVERRIDES_REL_PATH), overridesText);
  }
  for (const [rel, content] of Object.entries(extraFiles)) {
    const path = join(ws, rel);
    if (content === true) mkdirSync(path, { recursive: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return ws;
}

function findingsFor(text, opts = {}) {
  const ws = workspaceWith(text, opts);
  try {
    return validateOverrides({ workspace: ws, env: opts.env ?? {} });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

// ── clean files ──────────────────────────────────────────────────────────────

test("absent file yields no findings", () => {
  const ws = workspaceWith(null);
  try {
    assert.deepEqual(validateOverrides({ workspace: ws, env: {} }), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a canonical file matching the documented template is clean", () => {
  const text = `# Agent Fleet — Project Overrides
#
# Comment lines are ignored.

## spec-driven-development
spec-dir: docs/prds/{area}
naming:   PRD{n}-{topic}

## planning-and-task-breakdown
plan-dir: docs/plans/{area}
naming:   PLAN-{prd-name}-{phase}
todo:     embedded

## browser-testing-with-devtools
dev-server:  npm run dev
ready-check: http://localhost:3000
base-url:    http://localhost:3000
auth-flow: |
  1. Navigate to /login
  2. Submit credentials
roles:
  admin:  env APP_TEST_ADMIN_USER / APP_TEST_ADMIN_PASS
notes: |
  self-signed certs

## git-workflow-and-versioning
branching: never

## agent-hub
language: Bulgarian
persona-gate: off
model.builder: github-copilot/claude-sonnet-4.6
models.builder: github-copilot/claude-sonnet-4.6, github-copilot/claude-haiku-4.5
thinking.code-reviewer: xhigh
subagents.code-reviewer.docs: github-copilot/claude-sonnet-4.6, tools=read,grep
delegate-depth.code-reviewer: 1
rules: docs/rules
docs: Docs/AGENTS.md
`;
  const findings = findingsFor(text, {
    extraFiles: { "docs/rules": true, "Docs/AGENTS.md": "# guide\n" },
  });
  assert.deepEqual(findings, []);
});

test("indented block content is never parsed as keys", () => {
  // `admin:` / `player:` under roles: would be unknown keys if the parser
  // wrongly treated indented lines as section keys.
  const text = `## browser-testing-with-devtools
roles:
  admin:  env A / B
  player: env C / D
`;
  assert.deepEqual(findingsFor(text), []);
});

// ── structural problems ──────────────────────────────────────────────────────

test("unknown section is flagged and its keys are not validated", () => {
  const findings = findingsFor(`## agent-hab
language: Bulgarian
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /unknown section "## agent-hab"/);
  assert.match(findings[0].fix, /agent-hub/);
});

test("unknown key in a known section is flagged with the known keys", () => {
  const findings = findingsFor(`## planning-and-task-breakdown
plan_output: Docs/plans
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /unknown key "plan_output"/);
  assert.match(findings[0].fix, /plan-dir/);
});

test("legacy ## agent-team gets a rename nudge but its keys still validate", () => {
  const findings = findingsFor(`## agent-team
language: Bulgarian
modle.builder: some/model
`);
  assert.equal(findings.length, 2);
  assert.match(findings[0].issue, /legacy section name "## agent-team"/);
  assert.match(findings[0].fix, /agent-hub/);
  assert.match(findings[1].issue, /unknown key "modle.builder"/);
});

// ── value checks ─────────────────────────────────────────────────────────────

test("invalid enum values are flagged", () => {
  const findings = findingsFor(`## planning-and-task-breakdown
todo: inline

## git-workflow-and-versioning
branching: sometimes

## agent-hub
persona-gate: maybe
thinking.builder: ultra
delegate-depth.builder: -1
`);
  const issues = findings.map((f) => f.issue);
  assert.equal(findings.length, 5);
  assert.match(issues[0], /todo .* "inline" is not one of: embedded\|separate/);
  assert.match(issues[1], /branching .* "sometimes"/);
  assert.match(issues[2], /persona-gate .* "maybe"/);
  assert.match(issues[3], /thinking\.builder .* "ultra" is not one of: off\|minimal/);
  assert.match(issues[4], /delegate-depth\.builder .* not a non-negative integer/);
});

test("missing rules folders are flagged, existing ones are not", () => {
  const text = `## agent-hub
rules: docs/rules, .ai/rules
`;
  const findings = findingsFor(text, { extraFiles: { "docs/rules": true } });
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /rules folder not found .*\.ai\/rules/);
});

test("missing docs entry points are flagged, existing files and folders are not", () => {
  const text = `## agent-hub
docs: Docs/AGENTS.md, Docs/architecture, Docs/MISSING.md
`;
  const findings = findingsFor(text, {
    extraFiles: { "Docs/AGENTS.md": "# guide\n", "Docs/architecture": true },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /docs entry point not found .*Docs\/MISSING\.md/);
});

// ── ## env ───────────────────────────────────────────────────────────────────

test("env required vars pass via process env or root .env, fail otherwise", () => {
  const text = `## env
required: FROM_ENV, FROM_DOTENV, MISSING_ONE, not a name
`;
  const findings = findingsFor(text, {
    env: { FROM_ENV: "1" },
    extraFiles: { ".env": "# secrets\nexport FROM_DOTENV=abc\n" },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /MISSING_ONE is not set and not declared in \.env/);
  assert.match(findings[0].issue, /"not a name" is not a valid env var name/);
  assert.doesNotMatch(findings[0].issue, /FROM_ENV|FROM_DOTENV/);
});

// ── doctor integration ───────────────────────────────────────────────────────

test("runDoctor surfaces overrides findings and apply leaves the file alone", async () => {
  const ws = workspaceWith(`## agent-hub
thinking.builder: warp
`);
  try {
    const findings = await runDoctor({ workspace: ws, sourceRoot });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "overrides");
    assert.equal(findings[0].path, OVERRIDES_REL_PATH);

    const { repaired, deleted, skipped } = await runDoctor({
      workspace: ws, sourceRoot, apply: true,
    });
    assert.deepEqual({ repaired, deleted, skipped }, { repaired: 0, deleted: 0, skipped: 0 });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
