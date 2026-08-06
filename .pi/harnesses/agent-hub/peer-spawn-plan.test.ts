import assert from "node:assert/strict";
import test from "node:test";

import {
	buildHubPeerSpawnPlan,
	launchHubPeerInPane,
	type HubPeerSpawnContext,
} from "./peer-spawn-plan.ts";

const PEERS_YAML = `
review:
  - name: code-reviewer
    runner: claude-code
web:
  - name: web-debugger
    persona: web-debugger
    model: openai-codex/gpt-5.6-terra
    extensions: chrome-devtools-mcp
    env_file: .env.peer
`;

function context(overrides: Partial<HubPeerSpawnContext> = {}): HubPeerSpawnContext {
	return {
		project: "af",
		peersYaml: PEERS_YAML,
		personaExists: (name) => ["builder", "web-debugger"].includes(name),
		worktreeTag: "wt2",
		...overrides,
	};
}

test("name-only Hub spawn has CLI parity for declared Claude and Pi peers", () => {
	const claude = buildHubPeerSpawnPlan({ name: "code-reviewer" }, context());
	assert.equal(claude.kind, "claude-peer");
	assert.equal(claude.project, "af");
	assert.deepEqual(claude.command, ["just", "_claude-peer", "code-reviewer", "", "", "af"]);

	const pi = buildHubPeerSpawnPlan({ name: "web-debugger" }, context());
	assert.equal(pi.kind, "persona-peer");
	assert.equal(pi.envFile, ".env.peer");
	assert.equal(pi.extensions, "chrome-devtools-mcp");
	assert.deepEqual(pi.command, [
		"just", "_peer-plus", "chrome-devtools-mcp", "web-debugger", "web-debugger",
		"openai-codex/gpt-5.6-terra", "", "af",
	]);
});

test("Hub spawn supports explicit persona, core, and Claude shapes while forcing its project", () => {
	const persona = buildHubPeerSpawnPlan(
		{ name: "build-1", runner: "pi", persona: "builder", model: "openai-codex/gpt-5.6-terra", extensions: "btw" },
		context(),
	);
	assert.equal(persona.kind, "persona-peer");
	assert.deepEqual(persona.command, [
		"just", "_peer-plus", "btw", "builder", "build-1", "openai-codex/gpt-5.6-terra", "", "af",
	]);

	const core = buildHubPeerSpawnPlan(
		{ name: "scratch", runner: "pi", no_persona: true, model: "openai-codex/gpt-5.6-luna", browser: true, all_extensions: true },
		context(),
	);
	assert.equal(core.kind, "core-peer");
	assert.deepEqual(core.command, [
		"just", "_fleet-peer", "scratch", "true", "true", "--model", "openai-codex/gpt-5.6-luna", "--project", "af",
	]);

	const claude = buildHubPeerSpawnPlan(
		{ name: "claude-1", runner: "claude-code", model: "opus", project: "other" } as never,
		context(),
	);
	assert.equal(claude.project, "af");
	assert.deepEqual(claude.command, ["just", "_claude-peer", "claude-1", "opus", "", "af"]);
});

test("Hub wrapper exposes no env path and rejects incompatible peer fields before pane creation", () => {
	const injected = buildHubPeerSpawnPlan(
		{ name: "builder", persona: "builder", env_file: "../../secrets" } as never,
		context({ peersYaml: "" }),
	);
	assert.equal(injected.envFile, undefined);

	assert.throws(
		() => buildHubPeerSpawnPlan({ name: "x", runner: "claude-code", persona: "builder" }, context()),
		/pi-only/,
	);
	assert.throws(
		() => buildHubPeerSpawnPlan({ name: "x", runner: "claude-code", extensions: "btw" }, context()),
		/pi-only/,
	);
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
	const plan = buildHubPeerSpawnPlan({ name: "code-reviewer", direction: "down" }, context());
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
		["split", { target_pane_id: "w1:p1", direction: "down", cwd: "/repo", env: { PEER_TOKEN: "secret" }, focus: false }],
		["rename", "w1:p2", "code-reviewer"],
		["read", "w1:p2", 5],
		["text", "w1:p2", "just _claude-peer code-reviewer '' '' af"],
		["keys", "w1:p2", ["enter"]],
		["wait", "code-reviewer"],
		["tail", "w1:p2"],
	]);
	assert.equal(result.paneId, "w1:p2");
	assert.equal(result.promptSeen, true);
	assert.equal(result.verdict.peer_ready, false);
	assert.equal(result.verdict.pane_tail, "fatal: bridge failed");
});
