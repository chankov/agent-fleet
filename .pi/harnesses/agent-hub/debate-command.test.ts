import assert from "node:assert/strict";
import test from "node:test";
import {
	AF_DEBATE_FAILED_MESSAGE,
	AF_DEBATE_MESSAGE,
	checkDebateRounds,
	formatAfDebateDigest,
	formatAfDebateDispatcherNote,
	handleAfDebate,
	parseAfDebateArgs,
	presentAfDebateCommand,
	runAfDebate,
	type AfDebateHandleInput,
	type AfDebateMessage,
} from "./debate-command.ts";
import { renderDebateBlock, type DebateBlock } from "./debate-progress.ts";
import { debateFixture } from "./fixtures/debate-result.ts";

function ports(overrides: Partial<AfDebateHandleInput> = {}) {
	const calls: string[] = [];
	const input: AfDebateHandleInput = {
		cwd: "/repo",
		configuredPanel: () => null,
		listPanels: () => ["default", "cheap"],
		panelVoices: () => [{ name: "sol", model: "a/sol" }, { name: "grok", model: "b/grok" }, { name: "opus", model: "c/opus" }],
		preflight: () => { calls.push("preflight"); return null; },
		checkBudget: () => { calls.push("budget"); return null; },
		chargeBudget: () => { calls.push("charge"); },
		execute: async ({ panel, persona, rounds, question, emit }) => {
			calls.push(`execute:${panel}:${persona}:${rounds}:${question}`);
			emit({ type: "round", round: 1, voices: ["sol", "grok", "opus"] });
			emit({ type: "voice", turn: { name: "opus", model: "c/opus", round: 1, ok: true, position: "Extract after the release." } });
			return debateFixture(panel);
		},
		...overrides,
	};
	return { input, calls };
}

test("parseAfDebateArgs reads --panel, --persona and --rounds; the rest is the question", () => {
	assert.deepEqual(parseAfDebateArgs("--panel default --rounds 2 --persona reviewer should we extract?"), { panel: "default", persona: "reviewer", rounds: 2, question: "should we extract?" });
	assert.deepEqual(parseAfDebateArgs(`"keep the facade?"`), { panel: undefined, persona: "researcher", rounds: undefined, question: "keep the facade?" });
	assert.match(parseAfDebateArgs("--rounds 1 q").error ?? "", /integer from 2 to 5 \(got 1\)\. Set --rounds N, or omit it for 3/);
	assert.match(parseAfDebateArgs("--rounds six q").error ?? "", /--rounds requires an integer from 2 to 5/);
	assert.match(parseAfDebateArgs("--panel").error ?? "", /--panel requires a panel name/);
	assert.match(parseAfDebateArgs("").error ?? "", /^Usage: \/af-debate \[--panel NAME\] \[--persona researcher\|reviewer\] \[--rounds N\] <question>$/);
});

test("rounds: omitted is 3, 2 and 5 are the bounds, anything else is refused with the entry point's hint", () => {
	assert.deepEqual(checkDebateRounds(undefined), { rounds: 3 });
	assert.deepEqual(checkDebateRounds(2), { rounds: 2 });
	assert.deepEqual(checkDebateRounds(5), { rounds: 5 });
	for (const bad of [1, 6, 2.5, "3", 0]) assert.ok("error" in checkDebateRounds(bad), String(bad));
	assert.match((checkDebateRounds(9, "rounds: 2–5") as { error: string }).error, /got 9\)\. Set rounds: 2–5, or omit it for 3/);
});

test("runAfDebate: question, persona, rounds, target, panel, preflight, budget — then one charge and the rounds", async () => {
	const { input, calls } = ports();
	const result = await runAfDebate({ ...input, question: "Extract the parser now?", rounds: 5 });
	assert.equal(result.ok, true, result.message);
	assert.deepEqual(calls, ["preflight", "budget", "charge", "execute:default:researcher:5:Extract the parser now?"]);
	assert.equal(result.block!.status, "succeeded");
	assert.equal(result.block!.source, "default");
	assert.deepEqual(result.block!.voices.map(voice => voice.name), ["sol", "grok", "opus"]);
	assert.match(result.dispatcherNote!, /^DEBATE RESULT \(panel default, 3 of 3 rounds, complete\)/);
	assert.match(result.dispatcherNote!, /There is no judge: you own the decision/);
});

test("panel precedence is Poll's: explicit, then configured, then default; unknown names refuse with zero starts", async () => {
	const explicit = ports({ configuredPanel: () => "cheap" });
	assert.equal((await runAfDebate({ ...explicit.input, question: "q", panel: "default" })).block!.source, "explicit");
	const configured = ports({ configuredPanel: () => "cheap" });
	const viaConfig = await runAfDebate({ ...configured.input, question: "q" });
	assert.equal(viaConfig.block!.panel, "cheap");
	assert.equal(viaConfig.block!.source, "configured");
	const fallback = ports();
	assert.equal((await runAfDebate({ ...fallback.input, question: "q" })).block!.source, "default");

	const refusals: [Partial<AfDebateHandleInput>, string | undefined, RegExp][] = [
		[{ configuredPanel: () => "cheap" }, "typo", /Unknown panel "typo"\. Available panels: default, cheap\./],
		[{ configuredPanel: () => "gone" }, undefined, /The configured Debate panel "gone".*not in the roster/],
		[{ listPanels: () => ["cheap", "deep"] }, undefined, /No Debate panel was selected and none is named "default"/],
		[{ listPanels: () => [] }, undefined, /No Debate panel is available\. The roster is empty/],
	];
	for (const [override, panel, expected] of refusals) {
		const { input, calls } = ports(override);
		const result = await runAfDebate({ ...input, question: "q", panel });
		assert.equal(result.ok, false);
		assert.match(result.message, expected);
		assert.deepEqual(calls, [], "no preflight, charge or voice start");
		assert.equal(result.block!.panel, undefined);
	}
});

test("voice persona (D25): researcher or reviewer; retired names show their mapping; editor and unknown names refuse", async () => {
	const reviewer = ports();
	const ok = await runAfDebate({ ...reviewer.input, question: "q", persona: " Reviewer " });
	assert.equal(ok.ok, true);
	assert.match(reviewer.calls.at(-1)!, /^execute:default:reviewer:3:q$/);
	const cases: [string, RegExp][] = [
		["builder", /"builder" is a retired persona \(now agent "editor" with practices \["implementation"\].*\)\. A panel voice is read-only: use persona "researcher" \(default\) or "reviewer"\./],
		["editor", /Persona "editor" cannot be a panel voice\. A panel voice is read-only/],
		["oracle", /Unknown persona "oracle"\./],
	];
	for (const [persona, expected] of cases) {
		const { input, calls } = ports();
		const result = await runAfDebate({ ...input, question: "q", persona });
		assert.equal(result.ok, false);
		assert.match(result.message, expected);
		assert.deepEqual(calls, []);
	}
});

test("invalid rounds, an empty question, a refused target and a refused preflight start nothing", async () => {
	for (const rounds of [1, 6, 2.5]) {
		const { input, calls } = ports();
		const result = await runAfDebate({ ...input, question: "q", rounds, roundsHint: "rounds: 2–5" });
		assert.match(result.message, /Set rounds: 2–5/);
		assert.deepEqual(calls, []);
	}
	const empty = ports();
	assert.match((await runAfDebate({ ...empty.input, question: "  " })).message, /non-empty decision question/);
	const target = ports({ resolveTarget: () => ({ error: "Debate refused before any voice started: ambiguous" }) });
	assert.match((await runAfDebate({ ...target.input, question: "q" })).message, /ambiguous/);
	assert.deepEqual(target.calls, []);
	const blocked = ports({ preflight: () => "panel \"default\" has models not visible" });
	const refused = await runAfDebate({ ...blocked.input, question: "q" });
	assert.equal(refused.ok, false);
	assert.deepEqual(blocked.calls, [], "preflight refusal charges nothing");
});

test("a started debate that fails names the failure and where the round artifacts are", async () => {
	const { input, calls } = ports({
		execute: async ({ emit }) => {
			emit({ type: "round", round: 1, voices: ["sol", "grok", "opus"] });
			emit({ type: "voice", turn: { name: "sol", model: "a/sol", round: 1, ok: false, reason: "timeout" } });
			throw Object.assign(new Error("Debate failed: 1 of 3 voices succeeded in round 1 (sol: timeout; grok: crash)"), { debateDirectory: "polls/r/debate/" });
		},
	});
	const result = await runAfDebate({ ...input, question: "q" });
	assert.equal(result.ok, false);
	assert.deepEqual(calls, ["preflight", "budget", "charge"]);
	assert.match(result.message, /1 of 3 voices succeeded in round 1.*\. Round artifacts: polls\/r\/debate\/$/);
	const block = result.block!;
	assert.equal(block.status, "failed");
	assert.equal(block.directory, "polls/r/debate/");
	assert.deepEqual(block.voices.map(voice => voice.state), ["failed", "stopped", "stopped"]);
	assert.equal(renderDebateBlock(block, { expanded: false }).filter(line => /Round artifacts/.test(line)).length, 1);
});

test("the digest names each final position, what changed and why, failed voices, open disagreements and artifacts", () => {
	const digest = formatAfDebateDigest(debateFixture());
	assert.match(digest, /^Question: Extract the parser now\?\n\nFinal positions:\n/);
	assert.match(digest, /sol · a\/sol · round 3\n  position: Extract after the release\.\n  changed: round 2 — moved by: opus: the release freeze in docs\/release\.md; CI time\n  first position: Extract now\./);
	assert.match(digest, /grok · b\/grok · failed in round 2: timeout\n  last position \(round 1\): Rewrite it\./);
	assert.match(digest, /opus · c\/opus · round 3\n  position: Extract after the release, behind a flag\.\n  changed: no/);
	assert.match(digest, /Open disagreements \(final-round refutations\):\n- opus: sol's plan skips the flag/);
	assert.match(digest, /Rounds: round 1 3\/3 ok · round 2 2\/3 ok · round 3 2\/2 ok\. Each voice's report: polls\/r\/debate\/round-<N>\/<voice>\.md/);
	assert.match(digest, /Full debate: polls\/r\/debate\/$/);
	const quiet = formatAfDebateDigest({ ...debateFixture(), disagreements: [] });
	assert.match(quiet, /- none reported by the voices/);
	const stopped = { ...debateFixture(), roundsRun: 2, complete: false, stopReason: "round 2 had 1 successful voice; a round needs at least 2" };
	assert.match(formatAfDebateDispatcherNote(stopped, formatAfDebateDigest(stopped)), /^DEBATE RESULT \(panel default, 2 of 3 rounds, stopped: round 2 had 1 successful voice; a round needs at least 2\)/);
});

function commandUi() {
	const shown: (DebateBlock | undefined)[] = [];
	const sent: { message: AfDebateMessage; options: { triggerTurn: boolean } }[] = [];
	return { shown, sent, ui: { show: (block: DebateBlock | undefined) => { shown.push(block); }, send: (message: AfDebateMessage, options: { deliverAs: "followUp"; triggerTurn: boolean }) => { sent.push({ message, options }); } } };
}

test("/af-debate: a live widget while running, then exactly one transcript entry that hands the digest to the model", async () => {
	const { input } = ports();
	const { ui, shown, sent } = commandUi();
	const result = await presentAfDebateCommand({ ...input, args: "--rounds 3 Extract the parser now?" }, ui);
	assert.equal(result.ok, true);
	assert.equal(shown.at(-1), undefined, "the widget is cleared before the entry");
	assert.ok(shown.slice(0, -1).every(block => block && block.kind === "debate"));
	assert.equal(shown[0]!.status, "resolving");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, AF_DEBATE_MESSAGE);
	assert.equal(sent[0].options.triggerTurn, true);
	assert.match(sent[0].message.content, /^DEBATE RESULT \(panel default, 3 of 3 rounds, complete\)/);
	assert.equal(sent[0].message.details.debate.status, "succeeded");

	const failed = commandUi();
	await presentAfDebateCommand({ ...ports().input, args: "--persona builder q" }, failed.ui);
	assert.equal(failed.sent.length, 1);
	assert.equal(failed.sent[0].message.customType, AF_DEBATE_FAILED_MESSAGE);
	assert.equal(failed.sent[0].options.triggerTurn, false, "a failure starts no turn");
	assert.match(failed.sent[0].message.content, /^DEBATE FAILED\n\n"builder" is a retired persona/);
});

test("handleAfDebate refuses parse errors before anything runs", async () => {
	const { input, calls } = ports();
	const result = await handleAfDebate({ ...input, args: "--rounds 7 q" });
	assert.equal(result.ok, false);
	assert.deepEqual(calls, []);
	assert.equal(result.block!.status, "failed");
});

test("an apostrophe inside a word stays literal in both commands; a quote opens only at a token's start", async () => {
	const { parseAfPollArgs } = await import("./poll-command.ts");
	assert.equal(parseAfDebateArgs("--rounds 2 don't extract it, or can't we?").question, "don't extract it, or can't we?");
	assert.equal(parseAfPollArgs("--panel default isn't A simpler?").question, "isn't A simpler?");
	assert.deepEqual(parseAfDebateArgs(`--panel 'default' "keep it?"`), { panel: "default", persona: "researcher", rounds: undefined, question: "keep it?" });
});
