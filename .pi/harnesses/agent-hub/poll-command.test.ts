import assert from "node:assert/strict";
import test from "node:test";
import {
	formatAfPollDigest,
	formatAfPollStarted,
	formatAfPollVoiceProgress,
	handleAfPoll,
	HUB_POLL_DEFAULT_PERSONA,
	parseAfPollArgs,
	resolveAfPollPanel,
} from "./poll-command.ts";

test("parseAfPollArgs reads --panel, optional --persona, and the rest as the question", () => {
	const parsed = parseAfPollArgs(`--panel default --persona builder should we extract this module?`);
	assert.deepEqual(parsed, {
		panel: "default",
		persona: "builder",
		question: "should we extract this module?",
	});
	assert.equal(parseAfPollArgs(`--panel default "keep the facade?"`).question, "keep the facade?");
	assert.equal(parseAfPollArgs("just the question").persona, HUB_POLL_DEFAULT_PERSONA);
});

test("parseAfPollArgs refuses a missing question and a dangling flag", () => {
	assert.match(parseAfPollArgs("--panel default").error ?? "", /Usage: \/af-poll/);
	assert.match(parseAfPollArgs("--panel").error ?? "", /--panel requires a panel name/);
	assert.match(parseAfPollArgs("--panel --persona builder q").error ?? "", /--panel requires a panel name/);
	assert.match(parseAfPollArgs("").error ?? "", /Usage: \/af-poll/);
});

test("resolveAfPollPanel prefers --panel, then poll-panel:, else refuses with available names", () => {
	assert.deepEqual(resolveAfPollPanel("default", "other", ["default", "cheap"]), { panel: "default" });
	assert.deepEqual(resolveAfPollPanel(undefined, "cheap", ["default", "cheap"]), { panel: "cheap" });
	assert.match(resolveAfPollPanel(undefined, undefined, ["default"]).error ?? "", /--panel is required/);
	assert.match(resolveAfPollPanel(undefined, undefined, ["default"]).error ?? "", /Available panels: default/);
	assert.match(resolveAfPollPanel("missing", undefined, ["default"]).error ?? "", /Unknown panel "missing"/);
});

test("formatAfPollDigest is a vertical block per voice with name, model, position, confidence", () => {
	const digest = formatAfPollDigest({
		panel: "default",
		directory: ".pi/agent-sessions/artifacts/polls/abcd/",
		voices: [
			{ name: "sol", model: "openai-codex/gpt-5.6-sol", ok: true, position: "Extract it.", confidence: "high" },
			{ name: "grok", model: "xai/grok-4.6", ok: true, position: "Leave it.", confidence: "medium" },
			{ name: "opus", model: "github-copilot/claude-opus-5", ok: false, reason: "timeout" },
		],
		integrator: "opus",
		recommendation: "Extract behind a facade.",
	});
	assert.match(digest, /^sol · openai-codex\/gpt-5\.6-sol\n  position: Extract it\.\n  confidence: high/);
	assert.match(digest, /grok · xai\/grok-4\.6\n  position: Leave it\.\n  confidence: medium/);
	assert.match(digest, /opus · github-copilot\/claude-opus-5\n  failed: timeout/);
	assert.match(digest, /merge · opus\n  recommendation: Extract behind a facade\./);
	assert.match(digest, /Full opinions: \.pi\/agent-sessions\/artifacts\/polls\/abcd\//);
	assert.doesNotMatch(digest, /would_change_my_mind|case":/);
});

test("formatAfPollStarted is a main-loop receipt with panel, question, and voices", () => {
	const started = formatAfPollStarted({
		panel: "default", persona: "researcher", question: "should we extract?",
		voices: [{ name: "sol", model: "p/sol" }, { name: "grok", model: "p/grok" }],
	});
	assert.match(started, /^POLL STARTED \(panel default, persona researcher\)/);
	assert.match(started, /Question: should we extract\?/);
	assert.match(started, /sol · p\/sol/);
	assert.match(formatAfPollVoiceProgress({ name: "sol", model: "p/sol", ok: true, position: "Yes.", confidence: "high" }), /POLL VOICE sol · p\/sol\n  position: Yes\./);
});

test("handleAfPoll emits onAccepted after charging and before execute", async () => {
	const order: string[] = [];
	await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		checkBudget: () => null,
		chargeBudget: () => { order.push("charge"); },
		onAccepted: () => { order.push("accepted"); },
		execute: async () => { order.push("execute"); throw new Error("stop"); },
	});
	assert.deepEqual(order, ["charge", "accepted", "execute"]);
});

test("handleAfPoll runs preflight before charging the turn budget", async () => {
	let charged = 0;
	const refused = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		preflight: () => "panel default has models not visible to a clean-room child",
		checkBudget: () => null,
		chargeBudget: () => { charged++; },
		execute: async () => { throw new Error("should not run"); },
	});
	assert.equal(refused.ok, false);
	assert.equal(charged, 0);
	assert.match(refused.message, /not visible/);
});

test("handleAfPoll charges the turn budget once even when execute fails", async () => {
	let charged = 0;
	const failed = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		pollPanelOverride: null,
		listPanels: () => ["default"],
		checkBudget: () => null,
		chargeBudget: () => { charged++; },
		execute: async () => { throw new Error("spawn failed"); },
	});
	assert.equal(failed.ok, false);
	assert.equal(charged, 1);
	assert.match(failed.message, /spawn failed/);

	const refused = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		checkBudget: () => "⚠ Turn budget exhausted",
		chargeBudget: () => { charged++; },
		execute: async () => { throw new Error("should not run"); },
	});
	assert.equal(refused.ok, false);
	assert.equal(charged, 1);
	assert.match(refused.message, /Turn budget exhausted/);
});

test("handleAfPoll returns digest plus dispatcher note without full opinions", async () => {
	const result = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		checkBudget: () => null,
		chargeBudget: () => {},
		execute: async ({ panel, persona, question }) => {
			assert.equal(panel, "default");
			assert.equal(persona, "researcher");
			assert.equal(question, "should we extract?");
			return {
				panel, directory: ".pi/agent-sessions/artifacts/polls/run1/",
				voices: [{ name: "sol", model: "p/sol", ok: true, position: "Yes.", confidence: "high" }],
				recommendation: "Yes.", integrator: "opus",
			};
		},
	});
	assert.equal(result.ok, true);
	assert.match(result.digest ?? "", /sol · p\/sol/);
	assert.match(result.dispatcherNote ?? "", /POLL RESULT \(panel default\)/);
	assert.match(result.dispatcherNote ?? "", /Do not paste full voice opinions/);
});
