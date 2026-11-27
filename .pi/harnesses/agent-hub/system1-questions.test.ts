// PLAN-11-01 task 18 (D34–D35): four practices tell a delegate when an Ask System 1 question may help;
// the delegate only suggests one with a `SYSTEM1_QUESTION:` line. The parent Hub shows a ready input when
// ask_system1 is active, and nothing is ever called until the operator calls it. An answer is advice.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAgenticConfig } from "../lib/system1/config-agentic.js";
import { createAgenticRuntime } from "./agentic-runtime.ts";
import { PRACTICE_IDS, PRACTICES } from "./config/practices.ts";
import { formatAssignmentBlock, resolveAssignment, type ResolvedAssignment } from "./config/roles.ts";
import { extractAskUserQuestions, extractNeedsResearch } from "./presentation.ts";
import { extractSystem1Questions, MAX_SYSTEM1_QUESTIONS, system1QuestionNotice } from "./system1-questions.ts";
import { createDispatchExecutor } from "./tools/dispatch-execution.ts";
import { prepareDeps } from "./tools/dispatch-execution.test-support.ts";

const ctx = { cwd: process.cwd(), ui: { notify() {} } } as any;
const text = (result: any) => result?.content?.[0]?.text ?? "";
const CONSULTING = ["research", "planning", "independent-review", "security"] as const;
const reference = readFileSync("references/system1-consultation.md", "utf8");

const suggestion = {
	uncertainty: "Which acceptance claim has the weakest support?",
	input: { state: "A1: parser handles CRLF (tests/crlf.test.ts). A2: errors keep line numbers (no test cited).", questions: [{ id: "weakest", type: "choice", instructions: "Which claim is least supported by the cited evidence?", options: { A1: "A1", A2: "A2", unknown: "Cannot tell" } }] },
	verify: "Check A2's evidence against the named revision before writing the verdict.",
};
const line = `SYSTEM1_QUESTION: ${JSON.stringify(suggestion)}`;

function block(agent: string, practices: string[]): string {
	const assignment = resolveAssignment({ agent, practices }, [process.cwd()]);
	assert.equal(assignment.ok, true, JSON.stringify(assignment));
	return formatAssignmentBlock(assignment as ResolvedAssignment);
}

test("four practices carry a trigger, a typed question and the next verification; the shared rule appears once", () => {
	const expected: Record<(typeof CONSULTING)[number], RegExp> = {
		research: /ordinal question per candidate file \(low, medium or high likelihood of containing the enforcing rule\)\. Next, read the highest-ranked candidate and trace its caller/,
		planning: /choice among the listed dependency IDs: which assumption, if false, would invalidate the first step\? Next, inspect that dependency's contract or fixture/,
		"independent-review": /choice among the criterion IDs: which claim is least supported by the supplied evidence excerpts\? Next, check the original evidence against the named revision yourself; the verdict stays yours/,
		security: /choice among the listed flow IDs: which crossing most needs inspection for a missing authorization check\? Next, trace that flow from input to destination/,
	};
	for (const id of CONSULTING) {
		const role = PRACTICES[id].roles.includes("researcher") ? "researcher" : "reviewer";
		const assembled = block(role, [id]);
		assert.match(assembled, new RegExp(`^Ask System 1 \\(optional\\): .*${expected[id].source}`, "m"), id);
		assert.equal(assembled.match(/### Ask System 1 suggestions/g)?.length, 1, id);
		assert.match(assembled, /You never call ask_system1; only the parent Hub operator may, at its discretion and only when the tool is active there \(shared rule: `references\/system1-consultation\.md`/);
		assert.match(assembled, /An answer is advice and never counts as evidence, a verdict, a finding or a decision\./);
	}
	assert.equal(block("reviewer", ["independent-review", "security"]).match(/### Ask System 1 suggestions/g)?.length, 1);
	for (const id of PRACTICE_IDS.filter(id => !(CONSULTING as readonly string[]).includes(id))) assert.equal(PRACTICES[id].system1, undefined, id);
	assert.doesNotMatch(block("editor", ["implementation"]), /SYSTEM1_QUESTION|Ask System 1/);
});

test("the four named skill sections point at the shared rule, and its example is a valid suggestion", () => {
	for (const [path, section] of [
		["skills/context-engineering/SKILL.md", "### Level 3: Relevant Source Files"],
		["skills/planning-and-task-breakdown/SKILL.md", "### Step 2: Identify the Dependency Graph"],
		["skills/code-review-and-quality/SKILL.md", "### Step 5: Verify the Verification"],
		["skills/security-and-hardening/SKILL.md", "## Process: Threat Model First"],
	]) {
		const skill = readFileSync(path, "utf8");
		const start = skill.indexOf(section);
		assert.ok(start >= 0, path);
		const level = section.split(" ")[0].length;
		const rest = skill.slice(start + section.length);
		const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
		const body = next < 0 ? rest : rest.slice(0, next);
		assert.match(body, /\*\*Optional Ask System 1 \(Hub operator only\)\.\*\*.*`SYSTEM1_QUESTION:` line; only the operator decides whether to ask\. Either way, /, path);
		assert.match(body, /Shared rule: \[`\.\.\/\.\.\/references\/system1-consultation\.md`\]\(\.\.\/\.\.\/references\/system1-consultation\.md\)/, path);
	}
	const example = reference.split("\n").find(row => row.trim().startsWith("SYSTEM1_QUESTION: "))!.trim();
	const parsed = extractSystem1Questions(example);
	assert.deepEqual(parsed.ignored, []);
	assert.equal(parsed.suggestions[0].input.questions.length, 2, "one ordinal question per candidate file");
	assert.match(reference, /Only the parent Hub operator calls `ask_system1`/);
	assert.match(reference, /never counts as evidence, a review verdict, a security finding or an\n {2}acceptance check/);
});

test("a suggestion is validated with ask_system1's own validator; invalid lines say why", () => {
	const parsed = extractSystem1Questions([
		line,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, input: { ...suggestion.input, questions: [{ ...suggestion.input.questions[0], options: { A1: "A1", A2: "A2" } }] } })}`,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, input: { ...suggestion.input, evidenceRefs: ["ask1:abc"] } })}`,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, input: { questions: suggestion.input.questions } })}`,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, verify: "" })}`,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, call: true })}`,
		"SYSTEM1_QUESTION: {",
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, uncertainty: "second" })}`,
		`SYSTEM1_QUESTION: ${JSON.stringify({ ...suggestion, uncertainty: "third" })}`,
	].join("\n"));
	assert.equal(parsed.suggestions.length, MAX_SYSTEM1_QUESTIONS);
	assert.deepEqual(parsed.ignored.map(item => item.line), [2, 3, 4, 5, 6, 7, 9]);
	assert.match(parsed.ignored[0].reason, /not a valid ask_system1 input \(invalid_input\); a choice needs an "other" or "unknown" option/);
	assert.match(parsed.ignored[1].reason, /"evidenceRefs" are the operator's own opted-in output refs/);
	assert.match(parsed.ignored[2].reason, /state or paths are required/);
	assert.match(parsed.ignored[3].reason, /"verify" must be a non-empty string/);
	assert.match(parsed.ignored[4].reason, /unknown field "call"/);
	assert.match(parsed.ignored[6].reason, /at most 2 Ask System 1 suggestions per report/);
});

test("the notice shows a ready input only when ask_system1 is active, and always the verification", () => {
	const parsed = extractSystem1Questions(line);
	const active = system1QuestionNotice("reviewer", parsed, true)!;
	assert.match(active, /^ℹ SYSTEM1_QUESTION from reviewer \(1\): a suggestion only — nothing was called\. ask_system1 is active; you decide whether to call it, with context already approved for it\. Its answer is advice and never satisfies evidence, review, security or decision gates/);
	assert.match(active, /ask_system1 input: \{"state":"A1: parser handles CRLF/);
	assert.match(active, /verify: Check A2's evidence against the named revision/);
	const inactive = system1QuestionNotice("reviewer", parsed, false)!;
	assert.match(inactive, /ask_system1 is not available in this session, so nothing can be called\. Continue with the direct verification\./);
	assert.doesNotMatch(inactive, /ask_system1 input:/);
	assert.match(inactive, /verify: Check A2's evidence/);
	assert.equal(system1QuestionNotice("reviewer", extractSystem1Questions("nothing"), true), null);
});

test("walk: a reviewer suggests, the parent declines or invokes; only the explicit call reaches the service, with approved data", async () => {
	const calls: any[] = [];
	const service = { evaluate: async (request: any) => { calls.push(request); return { status: "ok", evaluation: { answers: [], metadata: { provider: "fake", requestedModel: "fake", returnedModel: "fake", questionSetVersion: "agentic-ask/v1", latencyMs: 0, attempts: 1 } } } as any; } };
	const runtime = createAgenticRuntime({ config: parseAgenticConfig({ mode: "on", remoteContextApproved: true }), service, sessionId: "s", context: () => "task", persist() {} });
	const verdict = "Review at HEAD: A2 is unproven — blocking.";
	const run = async (output: string, active: boolean) => {
		const d = prepareDeps({ agents: ["editor", "reviewer"] });
		(d as any).extractAskUserQuestions = extractAskUserQuestions;
		(d as any).extractNeedsResearch = extractNeedsResearch;
		(d as any).isAskSystem1Active = () => active;
		d.dispatchAgent = async () => ({ output, exitCode: 0, elapsed: 0, dispatchId: `s1-${Math.random()}` }) as any;
		return createDispatchExecutor(d as any)("review", { agent: "reviewer", practices: ["independent-review"], task: "Review the parser" }, undefined, undefined, ctx);
	};
	const suggested = await run(`${verdict}\n${line}`, true);
	const plain = await run(verdict, true);
	assert.match(text(suggested), /ask_system1 input: /);
	assert.equal(calls.length, 0, "a suggestion and the notice cause zero calls");
	const a = suggested.details as any, b = plain.details as any;
	for (const key of ["status", "accepted", "acceptanceStatus", "taskAccepted", "recoveryCategory"]) assert.deepEqual(a[key], b[key], `${key}: the suggestion changes nothing about the review`);
	// Declining is doing nothing: still zero calls. Invoking is the operator's explicit ask_system1 call.
	const input = a.system1Questions.suggestions[0].input;
	const answer = await runtime.evaluate(input);
	assert.equal(calls.length, 1);
	assert.equal(answer.advisory, true, "the answer is advice");
	assert.deepEqual(calls[0].questions, suggestion.input.questions, "exactly the suggested typed question");
	const sent = typeof calls[0].state === "string" ? JSON.parse(calls[0].state) : calls[0].state;
	assert.equal(sent.state, suggestion.input.state, "only the suggested, approved state");
	assert.deepEqual(sent.sources, [], "no source beyond what the call named");
	// Unconsented or disabled: the parent continues with direct inspection; no call is possible.
	const inactive = await run(`${verdict}\n${line}`, false);
	assert.match(text(inactive), /ask_system1 is not available in this session/);
	for (const config of [parseAgenticConfig({ mode: "on" }), parseAgenticConfig({ mode: "off", remoteContextApproved: true })]) {
		const off = createAgenticRuntime({ config, service, sessionId: "s2", context: () => "task", persist() {} });
		assert.equal(off.enabled, false);
		assert.equal((await off.evaluate(input)).status, "skipped");
	}
	const child = createAgenticRuntime({ config: parseAgenticConfig({ mode: "on", remoteContextApproved: true }), service, sessionId: "s3", context: () => "task", persist() {}, parent: false });
	assert.equal((await child.evaluate(input)).status, "skipped", "a child session cannot call");
	assert.equal(calls.length, 1);
});
