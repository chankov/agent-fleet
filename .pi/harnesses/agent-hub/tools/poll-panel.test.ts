import assert from "node:assert/strict";
import test from "node:test";
import { runAfPoll, type AfPollHandleInput } from "../poll-command.ts";
import { executePollPanel, POLL_PANEL_DESCRIPTION, type PollPanelDeps } from "./poll-panel-core.ts";
import { FLEET_TOOLS, OPERATOR_DELEGATION_GUIDE } from "../work-mode.ts";

function ports(overrides: Partial<Omit<AfPollHandleInput, "args">> = {}) {
	const calls: string[] = [];
	const input: Omit<AfPollHandleInput, "args"> = {
		cwd: "/repo",
		pollPanelOverride: null,
		listPanels: () => ["default"],
		preflight: () => { calls.push("preflight"); return null; },
		checkBudget: () => { calls.push("budget"); return null; },
		chargeBudget: () => { calls.push("charge"); },
		execute: async ({ panel, persona, question }) => {
			calls.push(`execute:${panel}:${persona}:${question}`);
			return {
				panel, directory: ".pi/flow-sessions/poll/",
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
	return { input, calls };
}

test("runAfPoll takes typed inputs: default panel, default persona, one charge, failed voices stay visible", async () => {
	const { input, calls } = ports();
	const result = await runAfPoll({ ...input, question: "Keep the facade?" , panel: "default" });
	assert.equal(result.ok, true);
	assert.deepEqual(calls, ["preflight", "budget", "charge", "execute:default:researcher:Keep the facade?"]);
	assert.match(result.digest!, /grok · b\/grok\n  failed: timeout/);
	assert.match(result.digest!, /recommendation: Keep the facade and extract later/);
	assert.match(result.dispatcherNote!, /Do not paste full voice opinions/);
});

test("runAfPoll refuses an empty question and an unknown panel before any charge", async () => {
	const empty = ports();
	assert.equal((await runAfPoll({ ...empty.input, question: "  " })).ok, false);
	assert.deepEqual(empty.calls, []);
	const unknown = ports();
	const result = await runAfPoll({ ...unknown.input, question: "q", panel: "missing" });
	assert.equal(result.ok, false);
	assert.match(result.message, /Unknown panel "missing"/);
	assert.deepEqual(unknown.calls, []);
});

test("runAfPoll reports a failed poll as a failure, never as a decision", async () => {
	const { input } = ports({ execute: async () => { throw new Error("Poll failed: 1 of 3 voices succeeded"); } });
	const result = await runAfPoll({ ...input, question: "q", panel: "default" });
	assert.equal(result.ok, false);
	assert.match(result.message, /1 of 3 voices succeeded/);
});

function registered(deps: PollPanelDeps) {
	return { execute: (_id: string, params: any, _signal: unknown, onUpdate: any, ctx: any) => executePollPanel(deps, params, onUpdate, ctx) };
}

test("poll_panel is a fleet tool described for decisions, not facts", () => {
	assert.ok((FLEET_TOOLS as readonly string[]).includes("poll_panel"));
	assert.match(POLL_PANEL_DESCRIPTION, /decisions, not facts/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /poll_panel/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /Facts are never polled/);
});

test("poll_panel refuses before any work when blocked, and streams progress while running", async () => {
	let ran = false;
	const blockedTool = registered({ blocked: () => "declined", run: async () => { ran = true; return { ok: true, message: "" }; } });
	const refused = await blockedTool.execute("id", { question: "q" }, undefined, undefined, {});
	assert.equal(refused.details.status, "refused");
	assert.equal(ran, false);

	const updates: string[] = [];
	const tool = registered({
		blocked: () => null,
		run: async (params, _ctx, onProgress) => {
			onProgress(`POLL STARTED ${params.question}`);
			onProgress("POLL VOICE sol");
			return { ok: true, message: "digest", digest: "digest", dispatcherNote: "POLL RESULT (panel default)" };
		},
	});
	const ok = await tool.execute("id", { question: "Which cache?" }, undefined, (update: any) => updates.push(update.content[0].text), {});
	assert.equal(ok.details.status, "ok");
	assert.equal(ok.content[0].text, "POLL RESULT (panel default)");
	assert.equal(updates.at(-1), "POLL STARTED Which cache?\n\nPOLL VOICE sol");

	const failed = await registered({ blocked: () => null, run: async () => ({ ok: false, message: "Poll failed: 1 of 3" }) })
		.execute("id", { question: "q" }, undefined, undefined, {});
	assert.equal(failed.details.status, "failed");
	assert.match(failed.content[0].text, /no decision was produced/);
});
