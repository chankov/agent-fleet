import assert from "node:assert/strict";
import test from "node:test";

import {
	buildHubPeerSpawnPlan,
	launchHubPeerInPane,
	type HubPeerSpawnContext,
} from "./peer-spawn-plan.ts";

function context(overrides: Partial<HubPeerSpawnContext> = {}): HubPeerSpawnContext {
	return {
		project: "af",
		personaExists: (name) => ["editor", "web-debugger"].includes(name),
		worktreeTag: "wt2",
		...overrides,
	};
}

test("Hub spawn takes the same flags as `just fleet peer` and forces its project", () => {
	const claude = buildHubPeerSpawnPlan({ name: "claude-reviewer", runner: "claude-code", read_only: true }, context());
	assert.equal(claude.kind, "claude-peer");
	assert.equal(claude.project, "af");
	assert.equal(claude.readOnly, true);
	assert.deepEqual(claude.command, ["just", "_claude-peer-read-only", "claude-reviewer", "", "af"]);

	// A same-named persona file still makes a name-only spawn a persona peer.
	const pi = buildHubPeerSpawnPlan({ name: "web-debugger", model: "openai-codex/gpt-6-luna" }, context());
	assert.equal(pi.kind, "persona-peer");
	assert.deepEqual(pi.command, ["just", "_peer", "web-debugger", "web-debugger", "openai-codex/gpt-6-luna", "af"]);

	const persona = buildHubPeerSpawnPlan({ name: "edit-1", runner: "pi", persona: "editor", read_only: true }, context());
	assert.deepEqual(persona.command, ["just", "_peer-read-only", "editor", "edit-1", "", "af"]);

	const core = buildHubPeerSpawnPlan({ name: "scratch", runner: "pi", no_persona: true, model: "openai-codex/gpt-6-luna" }, context());
	assert.equal(core.kind, "core-peer");
	assert.deepEqual(core.command, ["just", "_fleet-peer", "scratch", "--model", "openai-codex/gpt-6-luna", "--project", "af"]);

	const forced = buildHubPeerSpawnPlan(
		{ name: "claude-1", runner: "claude-code", model: "opus", project: "other" } as never,
		context(),
	);
	assert.equal(forced.project, "af");
	assert.deepEqual(forced.command, ["just", "_claude-peer", "claude-1", "opus", "af"]);
});

test("Hub wrapper exposes no env file, extension choice or raw argv, and rejects incompatible fields before pane creation", () => {
	const injected = buildHubPeerSpawnPlan(
		{ name: "editor", persona: "editor", env_file: "../../secrets", extensions: "btw", browser: true, all_extensions: true, piArgs: ["--x"] } as never,
		context(),
	);
	assert.equal(injected.envFile, undefined);
	assert.equal("extensions" in injected, false);
	assert.deepEqual(injected.command, ["just", "_peer", "editor", "editor", "", "af"]);

	assert.throws(
		() => buildHubPeerSpawnPlan({ name: "x", runner: "claude-code", persona: "editor" }, context()),
		/pi-only/,
	);
	assert.throws(() => buildHubPeerSpawnPlan({ name: "x", read_only: true }, context()), /read-only launches exist for persona peers/);
});

test("fake Herdr launch splits the Hub pane, applies cwd/env, types argv, renames, and returns failed tail", async () => {
	const calls: unknown[] = [];
	const client = {
		paneSplit: async (params: Record<string, unknown>) => {
			calls.push(["split", params]);
			return { pane: { pane_id: "w1:p2" } };
		},
		paneRename: async (paneId: string, label: string) => {
			calls.push(["rename", paneId, label]);
			return { pane: { pane_id: paneId } };
		},
		paneRead: async ({ pane_id, lines }: { pane_id: string; lines: number }) => {
			calls.push(["read", pane_id, lines]);
			return { read: { pane_id, text: "user@host:/repo$ " } };
		},
		paneSendText: async (paneId: string, text: string) => { calls.push(["text", paneId, text]); },
		paneSendKeys: async (paneId: string, keys: string[]) => { calls.push(["keys", paneId, keys]); },
	};
	const plan = buildHubPeerSpawnPlan({ name: "claude-reviewer", runner: "claude-code", direction: "down" }, context());
	const result = await launchHubPeerInPane(plan, {
		client,
		targetPaneId: "w1:p1",
		cwd: "/repo",
		env: { PEER_TOKEN: "secret" },
		waitForRegistration: async (name) => {
			calls.push(["wait", name]);
			return { found: false, waitedMs: 45_000 };
		},
		paneTail: async (paneId) => {
			calls.push(["tail", paneId]);
			return "fatal: bridge failed";
		},
	});

	assert.deepEqual(calls, [
		["split", { target_pane_id: "w1:p1", direction: "down", cwd: "/repo", env: { PEER_TOKEN: "secret", AGENT_FLEET_AGENTIC_CHILD: '1' }, focus: false }],
		["rename", "w1:p2", "claude-reviewer"],
		["read", "w1:p2", 5],
		["text", "w1:p2", "just _claude-peer claude-reviewer '' af"],
		["keys", "w1:p2", ["enter"]],
		["wait", "claude-reviewer"],
		["tail", "w1:p2"],
	]);
	assert.equal(result.paneId, "w1:p2");
	assert.equal(result.promptSeen, true);
	assert.equal(result.verdict.peer_ready, false);
	assert.equal(result.verdict.pane_tail, "fatal: bridge failed");
});
