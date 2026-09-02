import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import type { SpawnPiAgentOptions } from "../../../.pi/harnesses/agent-hub/spawn.ts";
import { runAgentPhase, type SpawnAgent } from "./agent-phase.ts";
import { ENVELOPE_EXAMPLES } from "./envelopes.ts";
import { GateReport } from "./gates.ts";
import type { PersonaDefinition } from "./personas.ts";
import { Run } from "./run.ts";

const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls", model: "primary/model", models: ["fallback/model"], fallbackModel: "fallback/model",
	thinking: "low", systemPrompt: "Use skills/incremental-implementation/SKILL.md", file: "agents/researcher.md", writes: [],
};
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "flow-agent-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return { cwd, run: new Run({ cwd, runId: "agent-test" }) };
}

test("agent phase uses replacement context, fallback, detached safety, and same-session correction", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: Array<{ options: SpawnPiAgentOptions; fallback?: string }> = [];
		const spawn: SpawnAgent = async (options, fallback, callbacks) => {
			calls.push({ options, fallback });
			callbacks?.onProcess?.({ pid: 4321 } as ChildProcess);
			mkdirSync(dirname(options.sessionFile), { recursive: true }); writeFileSync(options.sessionFile, "session");
			callbacks?.onUsage?.({ input: 100, output: 20 }, "agent_end");
			return { output: calls.length === 1 ? JSON.stringify({ status: "success", summary: "missing findings" }) : JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn });
		assert.deepEqual(result, ENVELOPE_EXAMPLES.scout);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].options.resume, false);
		assert.equal(calls[1].options.resume, true);
		assert.equal(calls[0].fallback, "fallback/model");
		assert.equal(calls[0].options.detached, true);
		assert.equal(calls[0].options.signal, run.signal);
		assert.equal(run.trace.events().find(event => event.type === "agent_process")?.pid, 4321);
		assert.equal(run.trace.events().find(event => event.type === "agent_process")?.processGroup, -4321);
		assert.equal(calls[0].options.turnDeadlineMs, 1_200_000);
		assert.deepEqual(calls[0].options.toolWatchdog, { timeoutMs: 120_000 });
		assert.deepEqual(calls[0].options.extensions, [".pi/harnesses/damage-control-continue/index.ts"]);
		assert.ok(calls[0].options.systemPrompt?.startsWith("# Managed Specialist"));
		assert.equal(calls[0].options.appendSystemPrompt, undefined);
		assert.match(calls[1].options.prompt, /findings/);
		const invalidAttempts = run.trace.events().filter(event => event.invalidEnvelope === true);
		assert.equal(invalidAttempts.length, 1);
		assert.deepEqual(invalidAttempts[0].attempt, 1);
		assert.ok((invalidAttempts[0].errors as string[]).some(error => error.includes("findings")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("agent-declared fail rejects the containing run without correction", async () => {
	const { cwd, run } = fixture();
	try {
		let calls = 0;
		const spawn: SpawnAgent = async options => {
			calls++;
			return { output: JSON.stringify({ ...ENVELOPE_EXAMPLES.scout, status: "fail", summary: "blocked" }), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await assert.rejects(run.phase({ name: "scout", kind: "agent", owner: "researcher", description: "Reject reconnaissance that reports its own failure", retries: 2 }, () => runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn })), /agent declared fail/);
		assert.equal(calls, 1);
		const end = run.trace.events().find(event => event.type === "run_end");
		assert.deepEqual([end?.accepted, end?.exitCode], [false, 1]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("context-window pressure recycles persisted session before spawn", async () => {
	const { cwd, run } = fixture();
	try {
		const dir = join(run.trace.directory, "researcher"); mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "session.json"), "old");
		writeFileSync(join(dir, "session-meta.json"), JSON.stringify({ contextTokens: 950 }));
		let seenResume: boolean | undefined;
		const spawn: SpawnAgent = async options => {
			seenResume = options.resume;
			return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		await runAgentPhase({ run, persona, task: "A".repeat(500), envelope: "scout", cwd, spawn, contextWindow: 1000 });
		assert.equal(seenResume, false);
		assert.ok(run.trace.events().some(event => String(event.message).includes("session recycled before spawn")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("failed executable gate corrects in the same bounded session", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: SpawnPiAgentOptions[] = []; let gateCalls = 0;
		const spawn: SpawnAgent = async options => { calls.push(options); mkdirSync(dirname(options.sessionFile), { recursive: true }); writeFileSync(options.sessionFile, "session"); return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		const report = await runAgentPhase({ run, persona, task: "Locate X", envelope: "scout", cwd, spawn, gateRetries: 1, gates: [() => new GateReport("stub").check("item", ++gateCalls > 1, "RED GATE EVIDENCE")] });
		assert.deepEqual(report, ENVELOPE_EXAMPLES.scout); assert.equal(calls.length, 2); assert.equal(calls[1].resume, true); assert.match(calls[1].prompt, /RED GATE EVIDENCE/);
		assert.equal(run.trace.events().filter(event => event.type === "gate_report").length, 2);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("agent phase refuses a missing writes policy before spawning", async () => {
	const { cwd, run } = fixture();
	try {
		let calls = 0;
		const spawn: SpawnAgent = async options => { calls++; return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		await assert.rejects(runAgentPhase({ run, persona: { ...persona, writes: undefined }, task: "Locate X", envelope: "scout", cwd, spawn }), /has no writes policy/);
		assert.equal(calls, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("PermissionBreach rolls back and terminates without correction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "flow-agent-permission-"));
	try {
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd }); execFileSync("git", ["config", "user.email", "test@example.com"], { cwd }); execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(join(cwd, "base.txt"), "base"); writeFileSync(join(cwd, ".gitignore"), ".pi/flow-sessions/\n"); execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "base"], { cwd });
		const run = new Run({ cwd, runId: "breach" }); let calls = 0;
		const restricted = { ...persona, writes: [] };
		const spawn: SpawnAgent = async options => { calls++; writeFileSync(join(cwd, "forbidden.txt"), "bad"); return { output: JSON.stringify(ENVELOPE_EXAMPLES.scout), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model }; };
		await assert.rejects(run.phase({ name: "restricted", kind: "agent", owner: "researcher", description: "Enforce repository writes without retrying a breach", retries: 2 }, () => runAgentPhase({ run, persona: restricted, task: "Locate X", envelope: "scout", cwd, spawn, gateRetries: 2 })), /PermissionBreach/);
		assert.equal(calls, 1); assert.equal(existsSync(join(cwd, "forbidden.txt")), false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
