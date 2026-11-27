// PLAN-11-01 task 13 (D29–D31): four practices tell a delegate when to propose a Poll or a Debate;
// the Hub turns a valid `DECISION_QUESTION:` line into one operator notice with a ready question.
// A proposal never starts anything, never blocks the run and never changes a verdict.
import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { PRACTICE_IDS, PRACTICES } from "./config/practices.ts";
import { formatAssignmentBlock, resolveAssignment, type ResolvedAssignment } from "./config/roles.ts";
import { decisionQuestionNotice, extractDecisionQuestions, MAX_DECISION_QUESTIONS } from "./decision-questions.ts";
import { parseAfDebateArgs } from "./debate-command.ts";
import { DEBATE_PANEL_PARAMETERS } from "./tools/debate-panel-core.ts";
import { createDispatchExecutor, createResearchExecutor } from "./tools/dispatch-execution.ts";
import { prepareDeps } from "./tools/dispatch-execution.test-support.ts";
import { extractAskUserQuestions, extractNeedsResearch } from "./presentation.ts";

const ctx = { cwd: process.cwd(), ui: { notify() {} } } as any;
const text = (result: any) => result?.content?.[0]?.text ?? "";
const DECIDING = ["planning", "architecture", "independent-review", "security"] as const;

const debateLine = `DECISION_QUESTION: ${JSON.stringify({
	method: "debate",
	decision: "Where should the export retry limit live",
	alternatives: ["one default in src/http/client.ts", "a per-job setting in src/export/job.ts"],
	objection: "a client-wide default would also retry the non-idempotent POST in src/billing/charge.ts",
	evidence: ["src/http/client.ts", "src/billing/charge.ts"],
	constraints: "no public API change",
})}`;
const pollLine = `DECISION_QUESTION: ${JSON.stringify({ method: "poll", decision: "Which migration order?", alternatives: ["(A) schema first", "(B) readers first"], evidence: ["docs/plans/x.md"] })}`;

function block(agent: string, practices: string[]): string {
	const assignment = resolveAssignment({ agent, practices }, [process.cwd()]);
	assert.equal(assignment.ok, true, JSON.stringify(assignment));
	return formatAssignmentBlock(assignment as ResolvedAssignment);
}

test("the four practices carry their own trigger; the shared format appears once, names the skill, and never grants a tool", () => {
	const triggers: Record<(typeof DECIDING)[number], RegExp> = {
		planning: /propose a Poll for independent theses\. Where a dependency or rollback objection could change the chosen plan, propose a Debate/,
		architecture: /trade-off estimate with its assumptions and evidence\. Propose a Poll .*; propose a Debate when conflicting assumptions could change the interface/,
		"independent-review": /tied to the named revision, or a Debate when the remedies are incompatible\. Keep the evidence references and any dissent\. The verdict stays yours/,
		security: /Establish the risk with evidence first, then compare the plausible mitigations\. Propose a Debate when a disputed threat-model assumption or residual risk/,
	};
	for (const id of DECIDING) {
		const role = PRACTICES[id].roles.includes("editor") ? "editor" : "reviewer";
		const assembled = block(role, [id]);
		assert.match(assembled, new RegExp(`^Decision questions: .*${triggers[id].source}`, "m"), id);
		assert.equal(assembled.match(/### Decision questions/g)?.length, 1, id);
		assert.match(assembled, /You never start a Poll or a Debate; the operator decides whether to run one \(operator guidance: the `debate` skill\)/);
		assert.match(assembled, /A fact is never a decision question: look it up, or report NEEDS_RESEARCH/);
		assert.match(assembled, /DECISION_QUESTION: \{"method":"poll"\|"debate"/);
		assert.match(assembled, /A proposal never blocks you: finish the assignment with your own recommendation and its evidence\. If your work cannot continue without the decision, also raise ASK_USER/);
	}
	const combined = block("editor", ["planning", "architecture", "security"]);
	assert.equal(combined.match(/### Decision questions/g)?.length, 1, "one shared paragraph for several deciding practices");
	assert.equal(combined.match(/^Decision questions: /gm)?.length, 3);
	for (const id of PRACTICE_IDS.filter(id => !(DECIDING as readonly string[]).includes(id))) {
		assert.equal(PRACTICES[id].decisions, undefined, id);
	}
	assert.doesNotMatch(block("editor", ["implementation", "testing"]), /DECISION_QUESTION|Decision questions/);
	for (const id of DECIDING) assert.ok(!PRACTICES[id].skills.includes("debate"), `${id} keeps its skills list (D30)`);
});

test("a valid line becomes a ready poll_panel or debate_panel question in the Debate skill's framing", () => {
	const parsed = extractDecisionQuestions(`Report.\n${debateLine}\n${pollLine}\n${debateLine}`);
	assert.deepEqual(parsed.ignored, [], "an identical line is counted once");
	const [debate, poll] = parsed.proposals;
	assert.equal(debate.tool, "debate_panel");
	assert.equal(debate.question, "Decision: Where should the export retry limit live. Alternatives: (A) one default in src/http/client.ts; (B) a per-job setting in src/export/job.ts. Objection to test: a client-wide default would also retry the non-idempotent POST in src/billing/charge.ts. Evidence: src/http/client.ts, src/billing/charge.ts. Constraints: no public API change.");
	assert.ok(Value.Check(DEBATE_PANEL_PARAMETERS, { question: debate.question }));
	assert.equal(parseAfDebateArgs(JSON.stringify(debate.question)).question, debate.question, "also usable as a quoted /af-debate question");
	assert.equal(poll.tool, "poll_panel");
	assert.match(poll.question, /^Decision: Which migration order\? Alternatives: \(A\) schema first; \(B\) readers first\. Evidence: docs\/plans\/x\.md\.$/);
});

test("invalid lines are reported with the reason, never silently dropped; at most two proposals count", () => {
	const lines = [
		"DECISION_QUESTION: not json",
		`DECISION_QUESTION: ${JSON.stringify({ method: "debate", decision: "d", alternatives: ["a", "b"] })}`,
		`DECISION_QUESTION: ${JSON.stringify({ method: "vote", decision: "d", alternatives: ["a", "b"] })}`,
		`DECISION_QUESTION: ${JSON.stringify({ method: "poll", decision: "d", alternatives: ["only"] })}`,
		`DECISION_QUESTION: ${JSON.stringify({ method: "poll", decision: "d", alternatives: ["a", "b"], judge: "x" })}`,
		`DECISION_QUESTION: ${JSON.stringify({ method: "poll", decision: "x".repeat(601), alternatives: ["a", "b"] })}`,
		pollLine,
		debateLine,
		`decision_question: ${JSON.stringify({ method: "poll", decision: "third", alternatives: ["a", "b"] })}`,
	];
	const parsed = extractDecisionQuestions(lines.join("\n"));
	assert.equal(parsed.proposals.length, MAX_DECISION_QUESTIONS);
	assert.deepEqual(parsed.ignored.map(item => [item.line, item.reason]), [
		[1, "the value is not one JSON object on the same line"],
		[2, `"objection" is required`],
		[3, `"method" must be "poll" or "debate"`],
		[4, `"alternatives" needs at least two viable options; a single option is not a decision`],
		[5, `unknown field "judge"`],
		[6, `"decision" is longer than 600 characters`],
		[9, "at most 2 decision questions per report"],
	]);
	const notice = decisionQuestionNotice("editor", parsed)!;
	assert.match(notice, /^ℹ DECISION_QUESTION from editor \(2\): a proposal only — nothing was started, and the run's status is unchanged\. You decide whether to run it \(the `debate` skill\); never poll or debate a fact\./);
	assert.match(notice, /\n  1\. poll_panel with question: "Decision: Which migration order\?/);
	assert.match(notice, /\n  2\. debate_panel with question: "Decision: Where should/);
	assert.match(notice, /⚠ DECISION_QUESTION line 2 from editor ignored: "objection" is required\. Expected DECISION_QUESTION: \{"method":"poll"\|"debate"/);
	assert.equal(decisionQuestionNotice("editor", extractDecisionQuestions("no proposals here")), null);
});

function dispatchDeps(output: string) {
	const d = prepareDeps({ agents: ["editor", "reviewer"] });
	(d as any).extractAskUserQuestions = extractAskUserQuestions;
	(d as any).extractNeedsResearch = extractNeedsResearch;
	let runs = 0;
	d.dispatchAgent = async () => ({ output, exitCode: 0, elapsed: 0, dispatchId: `decision-${++runs}` }) as any;
	return d;
}

test("walk: a known objection in a plan reaches the operator as a ready Debate; the editor's run is not blocked", async () => {
	const d = dispatchDeps(`Plan written with option A, recommended because of src/http/client.ts.\n${debateLine}`);
	const result = await createDispatchExecutor(d as any)("plan", { agent: "editor", practices: ["planning"], task: "Plan the retry change" }, undefined, undefined, ctx);
	const details = result.details as any;
	assert.match(text(result), /ℹ DECISION_QUESTION from editor \(1\): a proposal only — nothing was started/);
	assert.match(text(result), /1\. debate_panel with question: "Decision: Where should the export retry limit live\. .*Objection to test: a client-wide default/);
	assert.equal(details.decisionQuestions.proposals[0].tool, "debate_panel");
	assert.deepEqual(details.questions, [], "a proposal is not an ASK_USER question");
	assert.notEqual(details.recoveryCategory, "blocked_on_user", "unrelated and dependent work can continue");
	assert.equal(details.status, "completed_unverified", "the run's own status is unchanged");
	// The editor can still be dispatched again right away: nothing is waiting on the operator.
	const next = await createDispatchExecutor(d as any)("next", { agent: "editor", task: "Implement option A" }, undefined, undefined, ctx);
	assert.equal((next.details as any).status, "completed_unverified");
});

test("walk: a blocking fork still uses ASK_USER; the proposal frames it for the operator's Poll", async () => {
	const d = dispatchDeps(`ASK_USER: Migrate schema first or readers first? Options: A, B. I recommend B.\n${pollLine}`);
	const result = await createDispatchExecutor(d as any)("fork", { agent: "editor", practices: ["planning"], task: "Plan the migration" }, undefined, undefined, ctx);
	const details = result.details as any;
	assert.equal(details.recoveryCategory, "blocked_on_user", "ASK_USER is the only blocking route");
	assert.match(text(result), /ASK_USER question\(s\) raised by editor/);
	assert.match(text(result), /1\. poll_panel with question: "Decision: Which migration order\?/);
});

test("walk: incompatible remedies in a review are proposed for Debate while the reviewer keeps its verdict", async () => {
	const verdict = "Review of src/auth at HEAD: F2 stale permissions after a role change — blocking.";
	const remedies = `DECISION_QUESTION: ${JSON.stringify({ method: "debate", decision: "Which remedy closes F2 at HEAD", alternatives: ["invalidate the cache in src/auth/roles.ts", "cut the TTL in src/auth/cache.ts"], objection: "invalidation writes once per role in the bulk import src/admin/import.ts", evidence: ["src/auth/roles.ts", "src/admin/import.ts"] })}`;
	const withProposal = await createDispatchExecutor(dispatchDeps(`${verdict}\n${remedies}`) as any)("review", { agent: "reviewer", practices: ["independent-review"], task: "Review src/auth" }, undefined, undefined, ctx);
	const without = await createDispatchExecutor(dispatchDeps(verdict) as any)("review", { agent: "reviewer", practices: ["independent-review"], task: "Review src/auth" }, undefined, undefined, ctx);
	const a = withProposal.details as any, b = without.details as any;
	assert.equal(a.decisionQuestions.proposals[0].tool, "debate_panel");
	for (const key of ["status", "accepted", "acceptanceStatus", "taskAccepted", "recoveryCategory"]) assert.deepEqual(a[key], b[key], `${key}: a proposal never changes the reviewer's result`);
	assert.deepEqual(a.reviewEvidence?.status, b.reviewEvidence?.status);
	assert.match(text(withProposal), /Review of src\/auth at HEAD: F2/);
});

test("walk: a factual gap goes to research, not to a Debate; a researcher's proposal is surfaced the same way", async () => {
	const d = prepareDeps({ agents: ["editor"] });
	const outputs = [
		"NEEDS_RESEARCH: which module owns the retry default?\nFindings so far: none.",
		`Findings: src/http/client.ts owns the default (src/http/client.ts:12).\n${debateLine}`,
	];
	(d as any).research = {
		anonymousDef: () => ({ name: "research", tools: "read,grep,find,ls" }),
		createState: (def: any) => ({ id: 7, def }),
		resolveModel: () => "provider/model",
		spawn: async () => ({ output: outputs.shift(), exitCode: 0, elapsed: 0 }),
	};
	(d.state as any).getTurnReport = () => ({ refusals: 0, research: 0 });
	(d.state as any).getSessionTotals = () => ({ refusals: 0, research: 0 });
	(d.state as any).getTaskTier = () => "feature"; // architecture is refused at trivial/small
	const research = createResearchExecutor(d as any);
	const gap = await research("gap", { task: "Who owns the retry default?", practices: ["research", "architecture"] }, undefined, undefined, ctx);
	assert.equal((gap.details as any).exitCode, 0, text(gap));
	assert.doesNotMatch(text(gap), /DECISION_QUESTION from/);
	assert.deepEqual((gap.details as any).decisionQuestions.proposals, []);
	const proposal = await research("design", { task: "Where should the retry default live?", practices: ["architecture"] }, undefined, undefined, ctx);
	assert.match(text(proposal), /ℹ DECISION_QUESTION from research r7 \(1\)/);
	assert.equal((proposal.details as any).decisionQuestions.proposals[0].tool, "debate_panel");
});
