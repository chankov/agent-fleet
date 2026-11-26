import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor, collectModelTargets } from "../lib/doctor.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function workspace(files = {}) {
  const ws = mkdtempSync(join(tmpdir(), "agent-fleet-visibility-"));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(ws, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return ws;
}

function hidden(models) {
  return {
    models: models.map((model) => ({
      model, ok: false, failed: ["child-visible"],
      reasons: [`${model}: child-visible check failed`],
    })),
  };
}

function visible(models) {
  return { models: models.map((model) => ({ model, ok: true, failed: [], reasons: [] })) };
}

const PERSONA = `---
name: editor
description: stub
tools: read
model: missing/model
subagents:
  scout:
    model: also/missing
    tools: read,grep,find,ls
---
stub
`;

test("model-visibility names the persona or voice, model, and failed check", async () => {
  const ws = workspace({
    "agents/editor.md": PERSONA,
    ".pi/agents/voices.yaml": `default:\n  - name: sol\n    model: bad/voice\n  - name: grok\n    model: also/voice\n`,
  });
  try {
    const findings = (await runDoctor({
      workspace: ws, sourceRoot, checkVisibility: hidden,
    })).filter((f) => f.type === "model-visibility");
    assert.equal(findings.length, 4);
    for (const f of findings) {
      assert.equal(f.type, "model-visibility");
      assert.match(f.issue, /child-visible check failed/);
      assert.ok(f.model);
      assert.equal(f.check, "child-visible");
    }
    assert.ok(findings.some((f) => f.issue.includes('persona "editor"') && f.issue.includes("missing/model") && f.path === "agents/editor.md"));
    assert.ok(findings.some((f) => f.issue.includes('subagent "editor/scout"') && f.issue.includes("also/missing")));
    assert.ok(findings.some((f) => f.issue.includes('voice "default/sol"') && f.path === ".pi/agents/voices.yaml"));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("missing voices.yaml is not a finding", async () => {
  const ws = workspace({ "agents/editor.md": PERSONA });
  try {
    const findings = await runDoctor({ workspace: ws, sourceRoot, checkVisibility: visible });
    assert.equal(findings.filter((f) => f.type === "model-visibility").length, 0);
    assert.equal(findings.some((f) => (f.path ?? "").includes("voices.yaml")), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("doctor does not auto-fix model-visibility findings", async () => {
  const ws = workspace({ "agents/editor.md": PERSONA });
  try {
    const before = readFileSync(join(ws, "agents/editor.md"), "utf8");
    const applied = await runDoctor({ workspace: ws, sourceRoot, apply: true, checkVisibility: hidden });
    assert.deepEqual({ repaired: applied.repaired, deleted: applied.deleted }, { repaired: 0, deleted: 0 });
    assert.equal(readFileSync(join(ws, "agents/editor.md"), "utf8"), before);
    const findings = applied.findings.filter((f) => f.type === "model-visibility");
    assert.ok(findings.length >= 1);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("visible models produce no model-visibility findings", async () => {
  const ws = workspace({ "agents/editor.md": PERSONA });
  try {
    const findings = (await runDoctor({
      workspace: ws, sourceRoot, checkVisibility: visible,
    })).filter((f) => f.type === "model-visibility");
    assert.deepEqual(findings, []);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("a definition that is not a role is not a visibility target — the Hub never loads it (D2)", async () => {
  const retired = PERSONA.replace("name: editor", "name: builder");
  const ws = workspace({ "agents/builder.md": retired, ".pi/agents/personas/my-own.md": PERSONA.replace("name: editor", "name: my-own") });
  try {
    assert.deepEqual(collectModelTargets(ws), []);
    const findings = await runDoctor({ workspace: ws, sourceRoot, checkVisibility: hidden });
    assert.equal(findings.filter((f) => f.type === "model-visibility").length, 0);
    // The retired file is reported once, as what it is.
    assert.deepEqual(findings.filter((f) => f.type === "retired-persona").map((f) => f.path), ["agents/builder.md"]);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('doctor includes complete profile defaults, child roles, services and inline voices',()=>{
 const dir=mkdtempSync(join(tmpdir(),'profile-doctor-'));
 try{
  mkdirSync(join(dir,'.pi','agents'),{recursive:true});
  writeFileSync(join(dir,'.pi','agents','model-profiles.yaml'),`local:\n  version: 2\n  defaults: {model: omlx/laguna}\n  dispatcher: omlx/laguna\n  subagents:\n    editor:\n      recon: omlx/qwen\n  services:\n    watchdog: omlx/laguna\n  panel:\n    - {name: second, model: omlx/qwen}\n`);
  const targets=collectModelTargets(dir);
  assert.ok(targets.some(t=>t.subject==='local/editor/recon'&&t.model==='omlx/qwen'));
  assert.ok(targets.some(t=>t.subject==='local/panel/second'));
  assert.ok(targets.some(t=>t.subject==='local/defaults'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
