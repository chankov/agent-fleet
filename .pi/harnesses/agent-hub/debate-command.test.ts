import assert from "node:assert/strict";
import test from "node:test";
import { formatAfDebateDigest, formatAfDebateStarted, handleAfDebate, parseAfDebateArgs } from "./debate-command.ts";

test("parseAfDebateArgs reads --panel, optional --persona and --rounds, and the rest as the question", () => {
	const parsed = parseAfDebateArgs("--panel default --rounds 2 --persona researcher should we extract?");
	assert.deepEqual(parsed, { panel: "default", persona: "researcher", rounds: 2, question: "should we extract?" });
	assert.match(parseAfDebateArgs("--rounds 1 q").error ?? "", /from 2 to 5/);
	assert.match(parseAfDebateArgs("").error ?? "", /Usage: \/af-debate/);
});

test("formatAfDebateStarted is a main-loop receipt and the digest stays vertical", () => {
	const started = formatAfDebateStarted({
		panel: "default", persona: "researcher", question: "should we extract?", rounds: 3,
		voices: [{ name: "sol", model: "p/sol" }],
	});
	assert.match(started, /^DEBATE STARTED \(panel default, persona researcher, rounds 3\)/);
	const digest = formatAfDebateDigest({
		panel: "default", directory: "polls/run1/debate/", rounds: 3,
		voices: [{ name: "sol", model: "p/sol", ok: true, round: 3, position: "Yes.", changed: false }],
	});
	assert.match(digest, /sol · p\/sol · round 3\n  position: Yes\./);
	assert.match(digest, /Full debate: polls\/run1\/debate\//);
});

test("handleAfDebate charges once and emits onAccepted before execute", async () => {
	const order: string[] = [];
	const result = await handleAfDebate({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		checkBudget: () => null,
		chargeBudget: () => { order.push("charge"); },
		onAccepted: () => { order.push("accepted"); },
		execute: async ({ rounds }) => {
			order.push("execute");
			assert.equal(rounds, 3);
			return { panel: "default", directory: "d/", rounds, voices: [] };
		},
	});
	assert.equal(result.ok, true);
	assert.deepEqual(order, ["charge", "accepted", "execute"]);
});
