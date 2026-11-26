// Tests for the advisory overrides-file validation. Each test builds a tiny
// temp workspace so folder- and .env-dependent checks run against real files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { validateOverrides, OVERRIDES_REL_PATH, OVERRIDE_PRACTICES, OVERRIDE_ROLES } from "../lib/validate-overrides.js";
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
    return validateOverrides({ workspace: ws, env: opts.env ?? {}, retiredPersonas: opts.retiredPersonas });
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
model.editor: anthropic/claude-sonnet-5-5
models.editor: anthropic/claude-sonnet-5-5, anthropic/claude-haiku-5-5
thinking.reviewer: xhigh
subagents.reviewer.docs: anthropic/claude-sonnet-5-5, tools=read,grep
delegate-depth.reviewer: 1
recon-search-timeout-s: 120
rules: docs/rules
docs: Docs/AGENTS.md

## workflows
quality: npm test
`;
  const findings = findingsFor(text, {
    extraFiles: { "docs/rules": true, "docs/rules/README.md": "# index\n", "Docs/AGENTS.md": "# guide\n" },
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

test("## workflows is known, with quality and a per-repository quality key", () => {
  assert.deepEqual(findingsFor(`## workflows
quality: npm test
quality.ringithub: dotnet test
quality.apps/api: npm test
`), []);
  const findings = findingsFor(`## workflows
qualty: npm test
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /unknown key "qualty" in ## workflows/);
  assert.match(findings[0].fix, /quality\.<repository>/);
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
thinking.editor: ultra
delegate-depth.editor: -1
recon-search-timeout-s: 0
`);
  const issues = findings.map((f) => f.issue);
  assert.equal(findings.length, 6);
  assert.match(issues[0], /todo .* "inline" is not one of: embedded\|separate/);
  assert.match(issues[1], /branching .* "sometimes"/);
  assert.match(issues[2], /persona-gate in ## agent-hub: ignored — dispatcher persona selection was removed/);
  assert.match(issues[3], /thinking\.editor .* "ultra" is not one of: off\|minimal/);
  assert.match(issues[4], /delegate-depth\.editor .* not a non-negative integer/);
  assert.match(issues[5], /recon-search-timeout-s .* not an integer from 1 to 3600 or "off"/);
});

test("child deadline and recycling keys accept valid values", () => {
  assert.deepEqual(findingsFor(`## agent-hub
agent-turn-timeout-s: off
session-recycle-runs: 5
`), []);
});

test("per-practice model and thinking keys the Hub reads are accepted (PLAN-11-01, D9)", () => {
  assert.deepEqual(findingsFor(`## agent-hub
model.editor: openai-codex/gpt-6-luna
model.editor.planning: anthropic/claude-opus-4-8
thinking.editor.planning: high
model.reviewer.independent-review: openai-codex/gpt-6-luna
thinking.researcher.browser-debugging: low
`), []);
});

test("per-practice keys flag an unknown role, an unknown practice, and a bad thinking level", () => {
  const issues = findingsFor(`## agent-hub
model.builder.planning: m/x
model.editor.plannning: m/x
thinking.editor.planning: extreme
`).map((f) => f.issue);
  assert.equal(issues.length, 3, JSON.stringify(issues));
  assert.match(issues[0], /model\.builder\.planning in ## agent-hub: "builder" is not a role \(researcher, reviewer, editor\)/);
  assert.match(issues[1], /model\.editor\.plannning in ## agent-hub: "plannning" is not a known practice/);
  assert.match(issues[2], /thinking\.editor\.planning in ## agent-hub: "extreme" is not one of: off\|minimal\|low\|medium\|high\|xhigh/);
});

test("the mirrored role and practice ids match the Hub's own tables", async () => {
  const { PRACTICE_IDS } = await import("../../.pi/harnesses/agent-hub/config/practices.ts");
  const { ROLE_NAMES } = await import("../../.pi/harnesses/agent-hub/config/roles.ts");
  assert.deepEqual([...OVERRIDE_PRACTICES], [...PRACTICE_IDS]);
  assert.deepEqual([...OVERRIDE_ROLES], [...ROLE_NAMES]);
});

// ── retired persona keys (PLAN-11-01, D22) ───────────────────────────────────
// The mapping is the Hub's own (roles.ts), passed in the way the doctor does;
// validate-overrides.js keeps no copy of it.

const { retiredAssignments } = await import("../../.pi/harnesses/agent-hub/config/roles.ts");
const retiredFindingsFor = (text) => findingsFor(text, { retiredPersonas: retiredAssignments });

test("an unambiguous retired persona key names its file, line and exact replacement", () => {
  const findings = retiredFindingsFor(`# overrides

## agent-hub
language: English
model.builder: m/x
thinking.deep-researcher: high
models.documenter: m/x, m/y
subagents.builder.recon: m/x, tools=read
delegate-depth.releaser: 1
`);
  assert.deepEqual(findings.map((f) => [f.path, f.line, f.key, f.replacement]), [
    [`${OVERRIDES_REL_PATH}:5`, 5, "model.builder", "model.editor.implementation"],
    [`${OVERRIDES_REL_PATH}:6`, 6, "thinking.deep-researcher", "thinking.researcher.research"],
    [`${OVERRIDES_REL_PATH}:7`, 7, "models.documenter", "models.editor"],
    [`${OVERRIDES_REL_PATH}:8`, 8, "subagents.builder.recon", "subagents.editor.recon"],
    [`${OVERRIDES_REL_PATH}:9`, 9, "delegate-depth.releaser", "delegate-depth.editor"],
  ]);
  for (const f of findings) assert.equal(f.type, "overrides");
  assert.match(findings[0].issue, /model\.builder in ## agent-hub names the retired persona "builder", so the Hub never reads it/);
  assert.match(findings[0].fix, /^rename to model\.editor\.implementation \(editor with practices \[implementation\] for implementation; add testing as needed\); doctor never edits this file$/);
});

test("an ambiguous retired persona key shows the full role-and-practice mapping instead of a key", () => {
  const findings = retiredFindingsFor(`## agent-hub
thinking.planner: high
subagents.test-engineer.recon: m/x
model.architect: m/x
`);
  assert.equal(findings.length, 3);
  for (const f of findings) assert.equal(f.replacement, undefined, f.key);
  assert.equal(findings[0].path, `${OVERRIDES_REL_PATH}:2`);
  assert.match(findings[0].fix, /"planner" maps to more than one assignment — pick the one you meant and rename by hand to thinking\.<role>\.<practice>: editor with practices \[planning\] for a saved plan; or researcher with practices \[planning\] for advice/);
  assert.match(findings[1].fix, /rename by hand to subagents\.<role>\.recon: editor with practices \[testing\] for test changes; or reviewer with practices \[testing, independent-review\] for coverage assessment/);
  assert.match(findings[2].fix, /researcher with practices \[architecture\] for analysis; or editor with practices \[architecture, documentation\] for an ADR/);
});

test("every retired persona is reported, and each proposed key is one the Hub reads", async () => {
  const { RETIRED_PERSONAS } = await import("../../.pi/harnesses/agent-hub/config/roles.ts");
  const { parseAgentTeamOverrides } = await import("../../.pi/harnesses/agent-hub/config/overrides.ts");
  const names = Object.keys(RETIRED_PERSONAS);
  const findings = retiredFindingsFor(`## agent-hub\n${names.map((name) => `model.${name}: m/x`).join("\n")}\n`);
  assert.deepEqual(findings.map((f) => f.key), names.map((name) => `model.${name}`));
  const unambiguous = findings.filter((f) => f.replacement);
  assert.deepEqual(unambiguous.map((f) => f.key).sort(),
    ["model.builder", "model.code-reviewer", "model.deep-researcher", "model.documenter", "model.plan-reviewer", "model.releaser"]);
  const ws = workspaceWith(`## agent-hub\n${[...new Set(unambiguous.map((f) => f.replacement))].map((key) => `${key}: m/x`).join("\n")}\n`);
  try {
    const parsed = parseAgentTeamOverrides(ws);
    assert.deepEqual(parsed.warnings, []);
    for (const f of unambiguous) assert.equal(parsed.practiceModels[f.replacement.slice("model.".length)]?.model, "m/x", f.replacement);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("retired keys that collide on one replacement, or whose replacement is already set, say so", () => {
  const findings = retiredFindingsFor(`## agent-hub
model.code-reviewer: m/x
model.plan-reviewer: m/y
thinking.builder: high
thinking.editor.implementation: low
`);
  assert.equal(findings.length, 3);
  assert.match(findings[0].fix, /rename to model\.reviewer\.independent-review .* — model\.plan-reviewer \(line 3\) also maps to model\.reviewer\.independent-review; keep one value/);
  assert.match(findings[1].fix, /model\.code-reviewer \(line 2\) also maps to model\.reviewer\.independent-review; keep one value/);
  assert.match(findings[2].fix, /^thinking\.editor\.implementation is already set on line 5 — keep that value and remove this key/);
});

test("without the Hub's table a retired key is still reported, as a name that is not a role", () => {
  // The doctor passes the lookup only when it can import roles.ts; on an older
  // Node the same key is still dead config and still reported.
  const findings = findingsFor(`## agent-team
model.builder: m/x
thinking.my-agent: high
`);
  assert.equal(findings.length, 3);
  assert.match(findings[0].issue, /legacy section name/);
  assert.equal(findings[1].path, `${OVERRIDES_REL_PATH}:2`);
  assert.match(findings[1].issue, /^model\.builder in ## agent-team: "builder" is not a role \(researcher, reviewer, editor\) — the Hub never reads this key$/);
  assert.match(findings[2].issue, /"my-agent" is not a role/);
  // With the table, a name that is not retired gets the same generic finding.
  assert.match(retiredFindingsFor("## agent-hub\nmodels.my-agent: m/x\n")[0].issue, /"my-agent" is not a role/);
});

test("retired persona keys are advisory: runDoctor reports them with the mapping and never edits the file", async () => {
  const text = "## agent-hub\nmodel.builder: x/y\nthinking.planner: high\n";
  const ws = workspaceWith(text);
  try {
    const findings = (await runDoctor({ workspace: ws, sourceRoot })).filter((f) => f.type === "overrides");
    assert.deepEqual(findings.map((f) => [f.path, f.replacement ?? null]), [
      [`${OVERRIDES_REL_PATH}:2`, "model.editor.implementation"],
      [`${OVERRIDES_REL_PATH}:3`, null],
    ]);
    assert.match(findings[1].fix, /editor with practices \[planning\] for a saved plan; or researcher with practices \[planning\] for advice/);
    await runDoctor({ workspace: ws, sourceRoot, apply: true });
    assert.equal(readFileSync(join(ws, OVERRIDES_REL_PATH), "utf8"), text);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("retired continuation quota keys are flagged for removal", () => {
  const issues = findingsFor(`## agent-hub
max-dispatches-per-turn: 8
max-research-per-turn: off
turn-wall-time-s: 3600
`).map((f) => f.issue);
  assert.equal(issues.length, 3);
  for (const [index, key] of ["max-dispatches-per-turn", "max-research-per-turn", "turn-wall-time-s"].entries())
    assert.match(issues[index], new RegExp(`${key} in ## agent-hub: ignored — continuation quotas were removed`));
});

test("legacy persona-gate key is deprecated", () => {
  const issues = findingsFor(`## agent-hub
persona-gate: on
`).map((f) => f.issue);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /persona-gate in ## agent-hub: ignored — dispatcher persona selection was removed/);
});

test("valid legacy mode key is deprecated and invalid budget values still flag", () => {
  const issues = findingsFor(`## agent-hub
mode: fast
agent-turn-timeout-s: zero
session-recycle-runs: -1
`).map((f) => f.issue);
  assert.equal(issues.length, 3);
  assert.match(issues[0], /mode in ## agent-hub: ignored — execution modes were removed/);
  assert.match(issues[1], /agent-turn-timeout-s .* not an integer from 1 to 86400 or "off"/);
  assert.match(issues[2], /session-recycle-runs .* not an integer from 1 to 1000 or "off"/);
});

test("watchdog keys accept valid values", () => {
  assert.deepEqual(findingsFor(`## agent-hub
watchdog: auto
watchdog-judge-model: openai-codex/gpt-6-luna
`), []);
});

test("watchdog setting flags invalid values", () => {
  const issues = findingsFor(`## agent-hub
watchdog: sometimes
`).map((f) => f.issue);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /watchdog .* "sometimes" is not one of: on\|off\|auto/);
});

test("recon search timeout accepts its integer range and off", () => {
  assert.deepEqual(findingsFor(`## agent-hub
recon-search-timeout-s: 1
`), []);
  assert.deepEqual(findingsFor(`## agent-hub
recon-search-timeout-s: 3600
`), []);
  assert.deepEqual(findingsFor(`## agent-hub
recon-search-timeout-s: off
`), []);
});

test("missing rules folders are flagged, existing ones are not", () => {
  const text = `## agent-hub
rules: docs/rules, .ai/rules
`;
  const findings = findingsFor(text, { extraFiles: { "docs/rules": true } });
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /rules folder not found .*\.ai\/rules/);
});

test("poll-panel and append-prompt pass when the panel and files exist", () => {
  const findings = findingsFor(`## agent-hub
poll-panel: default
append-prompt: references/communication-contract.md, docs/note.md
`, {
    extraFiles: {
      ".pi/agents/voices.yaml": "default:\n  - name: sol\n    model: p/sol\n  - name: grok\n    model: p/grok\n",
      "references/communication-contract.md": "# contract\n",
      "docs/note.md": "# note\n",
    },
  });
  assert.deepEqual(findings, []);
});

test("poll-panel is ignored when voices.yaml is absent and flagged when the panel is missing", () => {
  assert.deepEqual(findingsFor(`## agent-hub
poll-panel: default
`), []);
  const findings = findingsFor(`## agent-hub
poll-panel: missing
`, {
    extraFiles: { ".pi/agents/voices.yaml": "default:\n  - name: sol\n    model: p/sol\n  - name: grok\n    model: p/grok\n" },
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /poll-panel in ## agent-hub: panel "missing" was not found/);
  assert.match(findings[0].issue, /available: default/);
});

test("append-prompt flags listed files that do not exist", () => {
  const findings = findingsFor(`## agent-hub
append-prompt: references/communication-contract.md
`);
  assert.equal(findings.length, 1);
  assert.match(findings[0].issue, /append-prompt file not found .*references\/communication-contract.md/);
});

test("a typo in poll-panel or append-prompt is reported like other unknown keys", () => {
  const findings = findingsFor(`## agent-hub
poll-panle: default
append_prompt: references/x.md
`);
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => /unknown key "poll-panle"/.test(f.issue)));
  assert.ok(findings.some((f) => /unknown key "append_prompt"/.test(f.issue)));
  assert.ok(findings.every((f) => /poll-panel/.test(f.fix) && /append-prompt/.test(f.fix)));
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
thinking.editor: warp
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
