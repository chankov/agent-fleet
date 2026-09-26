// T13 — diagnostics for setup bindings and provenance: concrete file/reason
// findings, structural validity never sold as compliance, no second settings
// writer, no ownership change to ordinary setup.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateOverrides, OVERRIDES_REL_PATH } from "../lib/validate-overrides.js";
import { AI_STATE_REL_PATH } from "../lib/project-provenance.js";

function workspaceWith(overridesText, { extraFiles = {} } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "af-setup-diag-"));
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
const HUB = (rules, docs = "docs/README.md") =>
  `## agent-hub\nrules: ${rules}\ndocs: ${docs}\n`;

test("existing root without an index names the file and the fallback", () => {
  const ws = workspaceWith(HUB(".ai/rules"), { extraFiles: { ".ai/rules": true, "docs/README.md": "# docs\n" } });
  try {
    const findings = validateOverrides({ workspace: ws, env: {} });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "overrides");
    assert.match(findings[0].issue, /\.ai\/rules/);
    assert.match(findings[0].issue, /no index/);
    assert.match(findings[0].issue, /recursive scan/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("indexed root is silent; missing root keeps the existing warning", () => {
  for (const [extra, count] of [
    [{ ".ai/rules": true, ".ai/rules/README.md": "# index\n", "docs/README.md": "# docs\n" }, 0],
    [{ "docs/README.md": "# docs\n" }, 1],
  ]) {
    const ws = workspaceWith(HUB(".ai/rules"), { extraFiles: extra });
    try {
      const findings = validateOverrides({ workspace: ws, env: {} });
      assert.equal(findings.length, count);
      if (count) assert.match(findings[0].issue, /not found/);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});

test("corrupt sidecar is a provenance finding with file and reason; absence is silent", () => {
  const clean = workspaceWith(HUB(".ai/rules"), {
    extraFiles: { ".ai/rules": true, ".ai/rules/README.md": "# index\n", "docs/README.md": "# docs\n" },
  });
  try {
    assert.deepEqual(validateOverrides({ workspace: clean, env: {} }), []);
  } finally { rmSync(clean, { recursive: true, force: true }); }
  const broken = workspaceWith(HUB(".ai/rules"), {
    extraFiles: {
      ".ai/rules": true, ".ai/rules/README.md": "# index\n", "docs/README.md": "# docs\n",
      [AI_STATE_REL_PATH]: "{broken",
    },
  });
  try {
    const findings = validateOverrides({ workspace: broken, env: {} });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].type, "provenance");
    assert.equal(findings[0].path, AI_STATE_REL_PATH);
    assert.match(findings[0].issue, /corrupt/);
    assert.match(findings[0].fix, /never auto-fixed/);
  } finally { rmSync(broken, { recursive: true, force: true }); }
});

test("diagnostics never write: inputs are byte-identical afterwards", () => {
  const body = HUB(".ai/rules");
  const ws = workspaceWith(body, {
    extraFiles: {
      ".ai/rules": true, "docs/README.md": "# docs\n",
      [AI_STATE_REL_PATH]: "{broken",
    },
  });
  try {
    validateOverrides({ workspace: ws, env: {} });
    assert.equal(readFileSync(join(ws, OVERRIDES_REL_PATH), "utf8"), body);
    assert.equal(readFileSync(join(ws, AI_STATE_REL_PATH), "utf8"), "{broken");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
