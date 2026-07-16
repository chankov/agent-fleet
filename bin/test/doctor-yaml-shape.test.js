// Tests for the doctor's peers.yaml shape scan. The team-up launcher's
// minimal parser silently drops field lines that sit under a team before any
// `- name: ...` list item, so the doctor flags them as advisory findings.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor } from "../lib/doctor.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PEERS_REL = ".pi/agents/peers.yaml";

function workspaceWithPeers(yamlText) {
  const ws = mkdtempSync(join(tmpdir(), "agent-fleet-peers-"));
  if (yamlText !== null) {
    mkdirSync(join(ws, ".pi", "agents"), { recursive: true });
    writeFileSync(join(ws, PEERS_REL), yamlText);
  }
  return ws;
}

async function shapeFindingsFor(yamlText) {
  const ws = workspaceWithPeers(yamlText);
  try {
    const findings = await runDoctor({ workspace: ws, sourceRoot });
    return findings.filter((f) => f.type === "yaml-shape");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

const WELL_FORMED = `# comment
full:
  - name: web-debugger
    persona: web-debugger
    model: openai-codex/gpt-5.5
  - name: documenter
    persona: documenter

web:
  - name: web-debugger
    persona: web-debugger
`;

test("well-formed peers.yaml yields no yaml-shape findings", async () => {
  assert.deepEqual(await shapeFindingsFor(WELL_FORMED), []);
});

test("absent peers.yaml yields no yaml-shape findings", async () => {
  assert.deepEqual(await shapeFindingsFor(null), []);
});

test("an orphan field block before the first list item is flagged once per team", async () => {
  const broken = `full:
    persona: web-debugger
    model: openai-codex/gpt-5.5
    extensions: chrome-devtools-mcp
  - name: documenter
    persona: documenter

web:
  - name: web-debugger
    persona: web-debugger
`;
  const findings = await shapeFindingsFor(broken);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, PEERS_REL);
  assert.match(findings[0].issue, /team "full"/);
  assert.match(findings[0].issue, /persona: web-debugger/);
  assert.match(findings[0].issue, /line 2/);
  assert.match(findings[0].fix, /- name: <peer>/);
});

test("two broken teams produce two findings", async () => {
  const broken = `full:
    persona: web-debugger
  - name: documenter
    persona: documenter

docs:
    persona: documenter
`;
  const findings = await shapeFindingsFor(broken);
  assert.equal(findings.length, 2);
  assert.match(findings[0].issue, /team "full"/);
  assert.match(findings[1].issue, /team "docs"/);
});

test("comments and blank lines under a team do not trip the scan", async () => {
  const text = `full:
  # leading comment before the first peer

  - name: documenter
    persona: documenter
`;
  assert.deepEqual(await shapeFindingsFor(text), []);
});

test("fields after a list item are fine even across comments", async () => {
  const text = `full:
  - name: web-debugger
    # the extension this peer needs
    persona: web-debugger
    extensions: chrome-devtools-mcp
`;
  assert.deepEqual(await shapeFindingsFor(text), []);
});

test("apply leaves the malformed file untouched (advisory only)", async () => {
  const broken = `full:
    persona: web-debugger
  - name: documenter
    persona: documenter
`;
  const ws = workspaceWithPeers(broken);
  try {
    const result = await runDoctor({ workspace: ws, sourceRoot, apply: true });
    assert.equal(result.repaired, 0);
    assert.equal(result.deleted, 0);
    assert.equal(readFileSync(join(ws, PEERS_REL), "utf8"), broken);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the repo's own peers.yaml is well-formed", async () => {
  const real = readFileSync(join(sourceRoot, PEERS_REL), "utf8");
  assert.deepEqual(await shapeFindingsFor(real), []);
});
