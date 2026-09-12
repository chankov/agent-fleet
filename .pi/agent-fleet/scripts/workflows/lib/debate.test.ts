import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SpawnAgent } from "./agent-phase.ts";
import { DEBATE_FOREIGN_PACKET_MAX_BYTES, assertForeignPacketSize, debateRoundTask, debateVoicePath, resolveDebateRounds, runDebate } from "./debate.ts";
import { ENVELOPE_EXAMPLES, type DebateReport } from "./envelopes.ts";
import type { PersonaDefinition } from "./personas.ts";
import { POLL_TOOLS } from "./poll.ts";
import { Run } from "./run.ts";
import type { Voice } from "./voices.ts";

const persona: PersonaDefinition = {
	name: "researcher", description: "read only", tools: "read,grep,find,ls,write", model: "primary/model",
	fallbackModel: "fallback/model", thinking: "low", systemPrompt: "Debate.", file: "agents/researcher.md", writes: ["docs/"],
};
const voices: Voice[] = [
	{ name: "sol", model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
	{ name: "grok", model: "xai/grok-4.6", thinking: "medium" },
	{ name: "opus", model: "github-copilot/claude-opus-5", thinking: "medium", integrator: true },
];

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "debate-"));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test"], { cwd });
	writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
	execFileSync("git", ["add", ".gitignore"], { cwd });
	execFileSync("git", ["commit", "-qm", "base"], { cwd });
	return { cwd, run: new Run({ cwd, runId: "debate-test" }) };
}

function report(position: string): DebateReport {
	return { ...ENVELOPE_EXAMPLES.debate, position, summary: position } as DebateReport;
}

test("rounds default to 3 and values outside 2–5 are refused", () => {
	assert.equal(resolveDebateRounds(), 3);
	assert.equal(resolveDebateRounds(2), 2);
	assert.equal(resolveDebateRounds(5), 5);
	assert.throws(() => resolveDebateRounds(1), /from 2 to 5 \(got 1\)/);
	assert.throws(() => resolveDebateRounds(6), /from 2 to 5 \(got 6\)/);
});

test("an oversized foreign packet is refused with the named size instead of truncated", () => {
	const huge = "x".repeat(DEBATE_FOREIGN_PACKET_MAX_BYTES + 1);
	assert.throws(() => assertForeignPacketSize(huge), new RegExp(`foreign opinion packet is ${Buffer.byteLength(huge, "utf8")} bytes \\(cap ${DEBATE_FOREIGN_PACKET_MAX_BYTES}\\)`));
	const others = [{
		ok: true as const, voice: voices[0], round: 1,
		report: { ...ENVELOPE_EXAMPLES.debate, position: "y".repeat(DEBATE_FOREIGN_PACKET_MAX_BYTES) } as DebateReport,
		path: "sol.md",
	}];
	assert.throws(() => debateRoundTask("A or B?", 2, 3, others), /foreign opinion packet is \d+ bytes \(cap 16384\)/);
});

test("each surviving voice reuses one session and receives labeled others from the previous round", async () => {
	const { cwd, run } = fixture();
	try {
		const calls: Array<{ model: string; tools: string; prompt: string; sessionFile: string; resume?: boolean }> = [];
		const spawn: SpawnAgent = async options => {
			calls.push({ model: options.model, tools: options.tools, prompt: options.prompt, sessionFile: options.sessionFile, resume: options.resume });
			return { output: JSON.stringify(report(`from ${options.model}`)), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runDebate({ run, cwd, persona, panel: "default", task: "Should we use A or B?", voices, rounds: 2, spawn });
		assert.equal(result.roundsRun.length, 2);
		assert.equal(calls.length, 6);
		assert.ok(calls.every(call => call.tools === POLL_TOOLS));
		assert.ok(calls.filter((_, index) => index < 3).every(call => call.prompt.includes("Debate round 1 of 2")));
		assert.ok(calls.filter((_, index) => index < 3).every(call => !call.prompt.includes("Labeled positions from the previous round")));
		const round2 = calls.filter((_, index) => index >= 3);
		assert.ok(round2.every(call => call.prompt.includes("Labeled positions from the previous round")));
		assert.ok(round2.every(call => call.prompt.includes("Should we use A or B?")));
		for (const voice of voices) {
			const own = round2.find(call => call.model === voice.model);
			assert.ok(own);
			assert.equal(own.prompt.includes(`## ${voice.name} (`), false);
			assert.ok(voices.filter(other => other.name !== voice.name).every(other => own.prompt.includes(`## ${other.name} (`)));
		}
		const sessions = new Set(calls.map(call => dirname(call.sessionFile)));
		assert.equal(sessions.size, 3);
		for (const voice of voices) {
			assert.equal(existsSync(debateVoicePath(cwd, "debate-test", 1, voice.name)), true);
			assert.equal(existsSync(debateVoicePath(cwd, "debate-test", 2, voice.name)), true);
			assert.match(readFileSync(debateVoicePath(cwd, "debate-test", 2, voice.name), "utf8"), /"position"/);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a failed voice is dropped from later rounds while two remain", async () => {
	const { cwd, run } = fixture();
	try {
		const seen: string[] = [];
		const spawn: SpawnAgent = async options => {
			seen.push(`${options.prompt.includes("round 1") ? "1" : "2"}:${options.model}`);
			if (options.model.includes("grok")) return { output: "", exitCode: 1, stderr: "boom", toolCallsStarted: 0, modelUsed: options.model };
			return { output: JSON.stringify(report("ok")), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
		};
		const result = await runDebate({ run, cwd, persona, panel: "default", task: "A or B?", voices, rounds: 2, spawn });
		assert.equal(result.roundsRun[0].results.filter(item => item.ok).length, 2);
		assert.equal(result.roundsRun[1].results.length, 2);
		assert.ok(result.roundsRun[1].results.every(item => item.voice.name !== "grok"));
		assert.ok(seen.some(item => item.startsWith("1:") && item.includes("grok")));
		assert.equal(seen.some(item => item.startsWith("2:") && item.includes("grok")), false);
		assert.match(readFileSync(debateVoicePath(cwd, "debate-test", 1, "grok"), "utf8"), /status: failed/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("fewer than two successful voices in round 1 fails the debate", async () => {
	const { cwd, run } = fixture();
	try {
		const spawn: SpawnAgent = async options => {
			if (options.model.includes("sol")) return { output: JSON.stringify(report("ok")), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: options.model };
			return { output: "", exitCode: 1, stderr: "nope", toolCallsStarted: 0, modelUsed: options.model };
		};
		await assert.rejects(runDebate({ run, cwd, persona, panel: "default", task: "A or B?", voices, rounds: 2, spawn }), /1 of 3 voices succeeded in round 1/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
