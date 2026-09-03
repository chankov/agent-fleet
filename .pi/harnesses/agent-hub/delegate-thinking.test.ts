import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fileURLToPath } from "node:url";
import { parseAgentFile } from "./config/agents.ts";
import { parseAgentTeamOverrides } from "./config/overrides.ts";
import registerDelegate from "./delegate.ts";

function personaFile(dir: string, body: string): string {
	const path = join(dir, "agents", "planner.md");
	mkdirSync(join(dir, "agents"), { recursive: true });
	writeFileSync(path, body);
	return path;
}

test("planner declares scout, rules, and voice-1..3 — not risk", () => {
	const planner = parseAgentFile(fileURLToPath(new URL("../../../agents/planner.md", import.meta.url)));
	assert.deepEqual(Object.keys(planner?.subagents ?? {}).sort(), ["rules", "scout", "voice-1", "voice-2", "voice-3"]);
	assert.equal(planner?.subagents?.["voice-1"].thinking, "medium");
	assert.equal(planner?.subagents?.["voice-2"].thinking, "medium");
	assert.equal(planner?.subagents?.["voice-3"].thinking, "medium");
});

test("a sub-role without thinking is stored without a thinking field (spawn defaults to off)", () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-thinking-off-"));
	try {
		const def = parseAgentFile(personaFile(dir, `---
name: planner
subagents:
  scout:
    model: p/fast
    tools: read,grep,find,ls
---
prompt
`));
		assert.equal(def?.subagents?.scout.model, "p/fast");
		assert.equal(def?.subagents?.scout.thinking, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a sub-role with thinking: medium keeps medium", () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-thinking-medium-"));
	try {
		const def = parseAgentFile(personaFile(dir, `---
name: planner
subagents:
  voice-1:
    model: openai-codex/gpt-5.6-sol
    thinking: medium
    tools: read,grep,find,ls
---
prompt
`));
		assert.equal(def?.subagents?.["voice-1"].thinking, "medium");
		assert.equal(def?.warnings, undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an invalid sub-role thinking value warns at load and is reduced to off", () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-thinking-bad-"));
	try {
		const def = parseAgentFile(personaFile(dir, `---
name: planner
subagents:
  voice-1:
    model: p/sol
    thinking: turbo
    tools: read,grep,find,ls
---
prompt
`));
		assert.equal(def?.subagents?.["voice-1"].thinking, undefined);
		assert.ok(def?.warnings?.some(warning => /voice-1/.test(warning) && /turbo/.test(warning) && /using off/.test(warning)));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("subagents.<persona>.<role> override accepts thinking= next to model= and tools=", () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-thinking-override-"));
	try {
		mkdirSync(join(dir, ".ai"), { recursive: true });
		writeFileSync(join(dir, ".ai", "agent-fleet-overrides.md"), `## agent-hub
subagents.planner.voice-1: openai-codex/gpt-5.6-sol, tools=read,grep, thinking=high
subagents.planner.voice-2: p/grok, thinking=nope
subagents.planner.scout: p/fast,tools=read,grep
`);
		const overrides = parseAgentTeamOverrides(dir);
		assert.deepEqual(overrides.personaSubagents.planner["voice-1"], {
			model: "openai-codex/gpt-5.6-sol",
			tools: "read,grep",
			thinking: "high",
		});
		assert.deepEqual(overrides.personaSubagents.planner.scout, { model: "p/fast", tools: "read,grep" });
		assert.equal(overrides.personaSubagents.planner["voice-2"].thinking, undefined);
		assert.ok(overrides.warnings.some(warning => /voice-2/.test(warning) && /nope/.test(warning)));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegate spawn uses the role thinking level and defaults missing thinking to off", async () => {
	const dir = mkdtempSync(join(tmpdir(), "delegate-thinking-spawn-"));
	try {
		const fakePi = join(dir, "pi");
		const captured = join(dir, "thinking.txt");
		writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require("node:fs");
const i = process.argv.indexOf("--thinking");
fs.appendFileSync(${JSON.stringify(captured)}, (i >= 0 ? process.argv[i + 1] : "MISSING") + "\\n");
process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }) + "\\n");
`);
		chmodSync(fakePi, 0o755);
		let tool;
		process.env.AGENT_HUB_DELEGATE_CONFIG = JSON.stringify({
			persona: "planner", tag: "root",
			roles: {
				scout: { model: "fake/fast" },
				"voice-1": { model: "fake/sol", thinking: "medium" },
			},
			depth: 1, callBudget: 4, remainingSpawns: 4, parentTools: "read,grep,find,ls",
			personaPrompt: "", eventDir: join(dir, "events"), delegateExt: join(dir, "delegate.ts"),
			cwd: dir,
		});
		registerDelegate({ registerTool(def) { tool = def; } } as never);
		const oldPath = process.env.PATH;
		process.env.PATH = `${dir}:${oldPath ?? ""}`;
		try {
			await tool.execute("c1", { role: "scout", instruction: "map" }, undefined, () => {});
			await tool.execute("c2", { role: "voice-1", instruction: "vote" }, undefined, () => {});
		} finally {
			if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
			delete process.env.AGENT_HUB_DELEGATE_CONFIG;
		}
		assert.equal(readFileSync(captured, "utf8").trim(), "off\nmedium");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
