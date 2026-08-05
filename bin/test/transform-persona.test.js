// Tests for the persona transformer — run against the REAL canonical
// personas in agents/, not synthetic fixtures, so format drift in the
// source tree fails loudly here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  listPersonas,
  transformPersona,
  targetRelPath,
  PI_ONLY_PERSONAS,
  TRANSFORM_AGENTS,
} from "../lib/transform-persona.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const personaSource = (name) =>
  readFileSync(join(sourceRoot, "agents", `${name}.md`), "utf8");
const allPersonaNames = readdirSync(join(sourceRoot, "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.replace(/\.md$/, ""));

function frontmatterOf(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "transformed content has frontmatter");
  return m[1];
}
function bodyOf(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

// ── availability matrix ─────────────────────────────────────────────────────

test("matrix: pi lists every persona, claude-code excludes the pi-only set", () => {
  const pi = listPersonas(sourceRoot, { agent: "pi" }).map((p) => p.name);
  assert.deepEqual(pi.sort(), [...allPersonaNames].sort());

  const names = listPersonas(sourceRoot, { agent: "claude-code" }).map((p) => p.name);
  assert.equal(names.length, allPersonaNames.length - PI_ONLY_PERSONAS.length);
  for (const piOnly of PI_ONLY_PERSONAS) {
    assert.ok(!names.includes(piOnly), `${piOnly} must not be offered for claude-code`);
  }
});

test("matrix: every persona parses and transforms for every allowed agent", () => {
  for (const agent of TRANSFORM_AGENTS) {
    for (const { name, sourcePath, targetRelPath: rel } of listPersonas(sourceRoot, { agent })) {
      const out = transformPersona(readFileSync(sourcePath, "utf8"), { agent });
      assert.equal(out.name, name);
      assert.equal(out.targetRelPath, rel);
      assert.ok(out.content.startsWith("---\n"), `${name}/${agent} has frontmatter`);
    }
  }
});

test("pi-only persona refused for other agents", () => {
  assert.throws(
    () => transformPersona(personaSource("bowser"), { agent: "claude-code" }),
    /pi-only/,
  );
  assert.throws(
    () => transformPersona(personaSource("orchestrator"), { agent: "claude-code" }),
    /pi-only/,
  );
});

test("unknown agent refused", () => {
  assert.throws(() => transformPersona(personaSource("builder"), { agent: "cursor" }), /unknown agent/);
  assert.throws(() => listPersonas(sourceRoot, { agent: "gemini" }), /unknown agent/);
});

// ── per-target spec, worked example: code-reviewer ─────────────────────────

test("code-reviewer → claude-code: exact frontmatter", () => {
  const { content, targetRelPath: rel } = transformPersona(personaSource("code-reviewer"), {
    agent: "claude-code",
  });
  assert.equal(rel, join(".claude", "agents", "code-reviewer.md"));
  const fm = frontmatterOf(content).split("\n");
  assert.equal(fm[0], "name: code-reviewer");
  assert.match(fm[1], /^description: Senior code reviewer/);
  assert.equal(fm[2], "tools: Read, Bash, Grep, Glob");
  // model: openai-codex/gpt-5.5 (default) is a non-Claude route → inherit the session model
  assert.equal(fm.length, 3, "non-Claude default route inherits model; nothing else survives");
});

test("code-reviewer → pi: byte-identical passthrough", () => {
  const source = personaSource("code-reviewer");
  const { content, targetRelPath: rel } = transformPersona(source, { agent: "pi" });
  assert.equal(content, source);
  assert.equal(rel, join("agents", "code-reviewer.md"));
});

// ── edge personas ───────────────────────────────────────────────────────────

test("architect (no tools key): tools omitted", () => {
  const cc = transformPersona(personaSource("architect"), { agent: "claude-code" });
  assert.ok(!/^tools:/m.test(frontmatterOf(cc.content)), "no tools → inherit (claude-code)");
  assert.ok(!/^model:/m.test(frontmatterOf(cc.content)), "openai-codex route → inherit model");
});

test("releaser: hex color dropped for claude-code", () => {
  const { content } = transformPersona(personaSource("releaser"), { agent: "claude-code" });
  assert.ok(!/^color:/m.test(frontmatterOf(content)), "hex color is not a Claude Code color name");
});

test("researcher: kind dropped, read-only tool set mapped", () => {
  const { content } = transformPersona(personaSource("researcher"), { agent: "claude-code" });
  const fm = frontmatterOf(content);
  assert.ok(!/^kind:/m.test(fm));
  assert.match(fm, /^tools: Read, Grep, Glob$/m); // read,grep,find,ls — find+ls dedupe into Glob
});

test("builder (rw persona): write tools survive", () => {
  const cc = transformPersona(personaSource("builder"), { agent: "claude-code" });
  assert.match(frontmatterOf(cc.content), /^tools: Read, Write, Edit, Bash, Grep, Glob$/m);
});

test("agent-hub-only keys never leak into transformed output", () => {
  for (const { sourcePath } of listPersonas(sourceRoot, { agent: "claude-code" })) {
    const fm = frontmatterOf(
      transformPersona(readFileSync(sourcePath, "utf8"), { agent: "claude-code" }).content,
    );
    for (const dropped of ["models", "thinking", "delegate_depth", "subagents", "kind", "skills"]) {
      assert.ok(!new RegExp(`^${dropped}:`, "m").test(fm), `${dropped} dropped (${sourcePath})`);
    }
    assert.ok(!/github-copilot\/|openai-codex\//.test(fm), "pi model routes never leak");
  }
});

test("body passes through unchanged", () => {
  for (const { name, sourcePath } of listPersonas(sourceRoot, { agent: "claude-code" })) {
    const source = readFileSync(sourcePath, "utf8");
    const { content } = transformPersona(source, { agent: "claude-code" });
    assert.equal(bodyOf(content), bodyOf(source), `${name} body unchanged`);
  }
});

test("targetRelPath: per-agent install locations", () => {
  assert.equal(targetRelPath("claude-code", "x"), join(".claude", "agents", "x.md"));
  assert.equal(targetRelPath("pi", "x"), join("agents", "x.md"));
});
