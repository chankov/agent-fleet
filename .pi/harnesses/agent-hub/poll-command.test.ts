import assert from "node:assert/strict";
import test from "node:test";
import {
	AF_POLL_FAILED_MESSAGE,
	AF_POLL_MESSAGE,
	formatAfPollDigest,
	handleAfPoll,
	HUB_POLL_DEFAULT_PERSONA,
	parseAfPollArgs,
	presentAfPollCommand,
	resolvePollPanel,
	resolveVoicePersona,
	type AfPollHandleInput,
	type AfPollMessage,
} from "./poll-command.ts";
import { renderPollBlock, type PollBlock } from "./poll-progress.ts";

test("parseAfPollArgs reads --panel, optional --persona, and the rest as the question", () => {
	const parsed = parseAfPollArgs(`--panel default --persona builder should we extract this module?`);
	assert.deepEqual(parsed, {
		panel: "default",
		persona: "builder",
		question: "should we extract this module?",
	});
	assert.equal(parseAfPollArgs(`--panel default "keep the facade?"`).question, "keep the facade?");
	assert.equal(parseAfPollArgs("just the question").persona, HUB_POLL_DEFAULT_PERSONA);
	assert.equal(HUB_POLL_DEFAULT_PERSONA, "researcher");
});

test("parseAfPollArgs refuses a missing question and a dangling flag", () => {
	assert.match(parseAfPollArgs("--panel default").error ?? "", /Usage: \/af-poll/);
	assert.match(parseAfPollArgs("--panel").error ?? "", /--panel requires a panel name/);
	assert.match(parseAfPollArgs("--panel --persona builder q").error ?? "", /--panel requires a panel name/);
	assert.match(parseAfPollArgs("").error ?? "", /Usage: \/af-poll/);
});

test("resolvePollPanel: explicit beats configured, configured beats default, default fills in alone", () => {
	const roster = ["default", "cheap", "deep"];
	assert.deepEqual(resolvePollPanel({ explicit: "deep", configured: "cheap", available: roster }), { panel: "deep", source: "explicit" });
	assert.deepEqual(resolvePollPanel({ configured: "cheap", available: roster }), { panel: "cheap", source: "configured" });
	assert.deepEqual(resolvePollPanel({ configured: "  ", available: roster }), { panel: "default", source: "default" });
	assert.deepEqual(resolvePollPanel({ available: ["default"] }), { panel: "default", source: "default" });
});

test("resolvePollPanel refuses unknown, missing and empty selections with the roster and how to select", () => {
	const unknown = resolvePollPanel({ explicit: "typo", configured: "cheap", available: ["default", "cheap"], select: "--panel NAME" });
	assert.ok("error" in unknown);
	assert.match(unknown.error, /Unknown panel "typo"\. Available panels: default, cheap\. Select one with --panel NAME\./);

	const missingConfigured = resolvePollPanel({ configured: "gone", available: ["default", "cheap"], select: 'panel: "NAME"' });
	assert.ok("error" in missingConfigured);
	assert.match(missingConfigured.error, /configured Poll panel "gone".*not in the roster\. Available panels: default, cheap\./);
	assert.match(missingConfigured.error, /select a panel with panel: "NAME"/);

	const noDefault = resolvePollPanel({ available: ["cheap", "deep"] });
	assert.ok("error" in noDefault);
	assert.match(noDefault.error, /none is named "default"\. Available panels: cheap, deep\. Select one with --panel NAME, or set poll-panel: NAME/);

	const empty = resolvePollPanel({ available: [] });
	assert.ok("error" in empty);
	assert.match(empty.error, /roster is empty: \.pi\/agents\/voices\.yaml in the Fleet workspace defines no panels/);
	assert.match(empty.error, /Add a panel named "default"/);
	const emptyExplicit = resolvePollPanel({ explicit: "default", available: [] });
	assert.ok("error" in emptyExplicit);
	assert.match(emptyExplicit.error, /Unknown panel "default"\. The roster is empty/);
});

test("formatAfPollDigest is a vertical block per voice with name, model, position, confidence", () => {
	const digest = formatAfPollDigest({
		panel: "default",
		directory: ".pi/agent-sessions/artifacts/polls/abcd/",
		voices: [
			{ name: "sol", model: "openai-codex/gpt-6.2-sol", ok: true, position: "Extract it.", confidence: "high" },
			{ name: "grok", model: "xai/grok-4.7", ok: true, position: "Leave it.", confidence: "medium" },
			{ name: "opus", model: "anthropic/claude-opus-5-5", ok: false, reason: "timeout" },
		],
		integrator: "opus",
		recommendation: "Extract behind a facade.",
	});
	assert.match(digest, /^sol · openai-codex\/gpt-6.2-sol\n  position: Extract it\.\n  confidence: high/);
	assert.match(digest, /grok · xai\/grok-4\.7\n  position: Leave it\.\n  confidence: medium/);
	assert.match(digest, /opus · anthropic\/claude-opus-5-5\n  failed: timeout/);
	assert.match(digest, /merge · opus\n  recommendation: Extract behind a facade\./);
	assert.match(digest, /Full opinions: \.pi\/agent-sessions\/artifacts\/polls\/abcd\//);
	assert.doesNotMatch(digest, /would_change_my_mind|case":/);
});

/** Fixture ports: voices report out of panel order, then synthesis runs. */
function scripted(overrides: Partial<Omit<AfPollHandleInput, "args">> = {}) {
	const calls: string[] = [];
	const input: Omit<AfPollHandleInput, "args"> = {
		cwd: "/repo",
		configuredPanel: () => "cheap",
		listPanels: () => ["default", "cheap"],
		panelVoices: () => [{ name: "sol", model: "a/sol" }, { name: "grok", model: "b/grok" }, { name: "opus", model: "c/opus" }],
		preflight: ({ panel }) => { calls.push(`preflight:${panel}`); return null; },
		checkBudget: () => null,
		chargeBudget: () => { calls.push("charge"); },
		execute: async ({ panel, emit }) => {
			calls.push(`execute:${panel}`);
			emit({ type: "voice", voice: { name: "grok", model: "b/grok", ok: false, reason: "timeout" } });
			emit({ type: "voice", voice: { name: "opus", model: "c/opus", ok: true, position: "Keep the facade", confidence: "medium" } });
			emit({ type: "voice", voice: { name: "sol", model: "a/sol", ok: true, position: "Keep the facade", confidence: "high" } });
			emit({ type: "synthesis", integrator: { name: "opus", model: "c/opus" } });
			return {
				panel, directory: ".pi/agent-sessions/artifacts/polls/run1/",
				voices: [
					{ name: "sol", model: "a/sol", ok: true, position: "Keep the facade", confidence: "high" },
					{ name: "grok", model: "b/grok", ok: false, reason: "timeout" },
					{ name: "opus", model: "c/opus", ok: true, position: "Keep the facade", confidence: "medium" },
				],
				recommendation: "Keep the facade and extract later", integrator: "opus",
			};
		},
		...overrides,
	};
	const shown: (PollBlock | undefined)[] = [];
	const sent: { message: AfPollMessage; options: { deliverAs: "followUp"; triggerTurn: boolean } }[] = [];
	const ui = { show: (block: PollBlock | undefined) => { shown.push(block); }, send: (message: AfPollMessage, options: { deliverAs: "followUp"; triggerTurn: boolean }) => { sent.push({ message, options }); } };
	return { input, calls, shown, sent, ui };
}

const collapsed = (block: PollBlock) => renderPollBlock(block, { expanded: false });

test("/af-poll redraws one live block in place and leaves exactly one transcript entry with the dispatcher handoff", async () => {
	const { input, calls, shown, sent, ui } = scripted();
	const result = await presentAfPollCommand({ ...input, args: "should we keep the facade?" }, ui);
	assert.equal(result.ok, true);
	assert.deepEqual(calls, ["preflight:cheap", "charge", "execute:cheap"]);

	const blocks = shown.filter((block): block is PollBlock => block !== undefined);
	assert.equal(shown.at(-1), undefined, "the live block is cleared before the outcome entry");
	assert.equal(blocks[0].status, "resolving");
	assert.equal(blocks[0].panel, undefined);
	assert.doesNotMatch(collapsed(blocks[0]).join("\n"), /cheap|default/, "no panel is named before resolution");
	assert.match(collapsed(blocks[0])[0], /resolving panel/);

	const running = blocks.filter(block => block.status === "running" || block.status === "synthesizing");
	assert.ok(running.length >= 4);
	for (const block of running) {
		assert.deepEqual(block.voices.map(voice => voice.name), ["sol", "grok", "opus"], "rows keep panel order");
		assert.equal(collapsed(block).length, block.synthesis ? 5 : 4, "one stable row per voice");
	}
	const afterGrok = running.find(block => block.voices[1].state === "failed")!;
	assert.equal(afterGrok.voices[0].state, "running");
	assert.match(collapsed(afterGrok)[2], /✗ grok · failed: timeout/);
	const synthesizing = blocks.find(block => block.status === "synthesizing")!;
	assert.match(collapsed(synthesizing).join("\n"), /synthesis · opus · integrating opinions/);
	assert.match(collapsed(synthesizing)[0], /panel cheap · 3\/3 voices · synthesizing/);

	assert.equal(sent.length, 1, "one outcome, no repeated entries");
	const [{ message, options }] = sent;
	assert.equal(message.customType, AF_POLL_MESSAGE);
	assert.equal(options.triggerTurn, true, "the dispatcher handoff is preserved");
	assert.equal(message.content, result.dispatcherNote);
	assert.match(message.content, /^POLL RESULT \(panel cheap\)/);
	assert.match(message.content, /Do not paste full voice opinions/);
	const final = message.details.poll;
	assert.equal(final.status, "succeeded");
	assert.equal(final.panel, "cheap");
	assert.equal(final.source, "configured");
	const lines = collapsed(final);
	assert.match(lines[0], /✓ Poll · panel cheap · 3\/3 voices/);
	assert.match(lines.at(-1)!, /→ Keep the facade and extract later/);
	const expanded = renderPollBlock(final, { expanded: true });
	assert.ok(expanded.length > lines.length, "voice and synthesis details expand");
	assert.match(expanded.join("\n"), /full opinions: \.pi\/agent-sessions\/artifacts\/polls\/run1\//);
	assert.match(expanded.join("\n"), /panel cheap \(configured\)/);
});

test("/af-poll shows a panel-resolution failure once, before any voice starts, without a turn", async () => {
	const { input, calls, sent, ui, shown } = scripted({ configuredPanel: () => null, listPanels: () => ["cheap", "deep"] });
	const result = await presentAfPollCommand({ ...input, args: "--panel typo q?" }, ui);
	assert.equal(result.ok, false);
	assert.deepEqual(calls, [], "no preflight, charge or execute");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, AF_POLL_FAILED_MESSAGE);
	assert.equal(sent[0].options.triggerTurn, false);
	assert.match(sent[0].message.content, /^POLL FAILED\n\nUnknown panel "typo"\. Available panels: cheap, deep\. Select one with --panel NAME\./);
	const block = sent[0].message.details.poll;
	assert.equal(block.status, "failed");
	assert.equal(block.panel, undefined);
	assert.deepEqual(renderPollBlock(block, { expanded: true }), renderPollBlock(block, { expanded: false }), "nothing to expand");
	assert.equal(shown.filter(Boolean).every(item => item!.voices.length === 0), true);

	const usage = scripted();
	await presentAfPollCommand({ ...usage.input, args: "" }, usage.ui);
	assert.equal(usage.sent.length, 1);
	assert.match(usage.sent[0].message.content, /Usage: \/af-poll/);
	assert.deepEqual(usage.calls, []);
});

test("/af-poll falls back to the default panel and a failed run finishes the same block with its reason", async () => {
	const { input, calls, sent, ui } = scripted({
		configuredPanel: () => null,
		execute: async ({ panel, emit }) => {
			calls.push(`execute:${panel}`);
			emit({ type: "voice", voice: { name: "opus", model: "c/opus", ok: false, reason: "spawn failed" } });
			emit({ type: "voice", voice: { name: "grok", model: "b/grok", ok: false, reason: "timeout" } });
			emit({ type: "voice", voice: { name: "sol", model: "a/sol", ok: true, position: "Yes", confidence: "low" } });
			throw new Error("Poll failed: 1 of 3 voices succeeded");
		},
	});
	const result = await presentAfPollCommand({ ...input, args: "q?" }, ui);
	assert.equal(result.ok, false);
	assert.deepEqual(calls, ["preflight:default", "charge", "execute:default"]);
	assert.equal(sent.length, 1);
	assert.equal(sent[0].message.customType, AF_POLL_FAILED_MESSAGE);
	const block = sent[0].message.details.poll;
	assert.equal(block.panel, "default");
	assert.equal(block.source, "default");
	const lines = collapsed(block);
	assert.match(lines[0], /✗ Poll failed · panel default/);
	assert.equal(lines.length, 5, "headline, three voice rows, reason");
	assert.match(lines.at(-1)!, /Poll failed: 1 of 3 voices succeeded/);
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
	assert.equal(refused.block?.status, "failed");
});

test("handleAfPoll charges the turn budget once even when execute fails", async () => {
	let charged = 0;
	const failed = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
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

test("handleAfPoll emits onAccepted after charging and before execute, with the resolved name everywhere", async () => {
	const order: string[] = [];
	const result = await handleAfPoll({
		args: "--panel default should we extract?",
		cwd: "/tmp",
		listPanels: () => ["default"],
		checkBudget: () => null,
		chargeBudget: () => { order.push("charge"); },
		onAccepted: ({ panel, source }) => { order.push(`accepted:${panel}:${source}`); },
		execute: async ({ panel, persona, question, cwd, target }) => {
			order.push("execute");
			assert.equal(persona, "researcher");
			assert.equal(question, "should we extract?");
			assert.equal(cwd, "/tmp");
			assert.deepEqual(target, { mode: "legacy", workspaceRoot: "/tmp", executionRoot: "/tmp" });
			return { panel: "stale-name", directory: "d/", voices: [{ name: "sol", model: "p/sol", ok: true, position: "Yes.", confidence: "high" }], recommendation: "Yes.", integrator: "opus" };
		},
	});
	assert.deepEqual(order, ["charge", "accepted:default:explicit", "execute"]);
	assert.equal(result.ok, true);
	assert.match(result.dispatcherNote ?? "", /POLL RESULT \(panel default\)/, "the digest names the panel actually used");
	assert.equal(result.block?.panel, "default");
});

test("runAfPoll refuses a target failure as one diagnostic before roster, preflight or charge", async () => {
	const calls: string[] = [];
	const { input } = scripted({
		resolveTarget: () => ({ error: "Poll refused before any voice started: no assigned worktree" }),
		listPanels: () => { calls.push("list"); return ["default"]; },
		preflight: () => { calls.push("preflight"); return null; },
		chargeBudget: () => { calls.push("charge"); },
	});
	const { shown, sent, ui } = scripted();
	const result = await presentAfPollCommand({ ...input, args: "q?" }, ui);
	assert.equal(result.ok, false);
	assert.deepEqual(calls, []);
	assert.equal(sent.length, 1);
	assert.match(sent[0].message.content, /no assigned worktree/);
	assert.equal(shown.filter(Boolean).length >= 1, true);
});

test("voice persona (D25): only the read-only roles speak; a retired name shows its mapping", () => {
	assert.deepEqual(resolveVoicePersona(undefined), { persona: "researcher" });
	assert.deepEqual(resolveVoicePersona(" REVIEWER "), { persona: "reviewer" });
	assert.match((resolveVoicePersona("code-reviewer") as { error: string }).error, /"code-reviewer" is a retired persona \(now agent "reviewer" with practices \["independent-review"\]/);
	assert.match((resolveVoicePersona("editor") as { error: string }).error, /cannot be a panel voice/);
	assert.match((resolveVoicePersona("x") as { error: string }).error, /Unknown persona "x"\. A panel voice is read-only: use persona "researcher" \(default\) or "reviewer"\./);
});

test("/af-poll refuses a retired or editor persona before anything runs", async () => {
	for (const persona of ["builder", "editor"]) {
		const calls: string[] = [];
		const result = await handleAfPoll({
			args: `--persona ${persona} which cache?`, cwd: "/repo", listPanels: () => { calls.push("list"); return ["default"]; },
			checkBudget: () => null, chargeBudget: () => { calls.push("charge"); },
			execute: async () => { calls.push("execute"); throw new Error("unreachable"); },
		});
		assert.equal(result.ok, false);
		assert.match(result.message, /panel voice is read-only/);
		assert.deepEqual(calls, []);
	}
});
