import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectFleetConfigSnapshot, parseOverrideSections, problemCount, sourceDigests, SOURCE_IDS } from "./snapshot.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const workspace = () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-config-"));
	mkdirSync(join(root, ".ai"), { recursive: true });
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	return root;
};
const write = (root: string, rel: string, text: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), text); };
const env = { PATH: "/usr/bin" } as NodeJS.ProcessEnv;

test("every source missing yields a complete, problem-free snapshot", () => {
	const root = workspace();
	try {
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env, now: 10 });
		for (const id of SOURCE_IDS) assert.equal(snapshot.sources[id].status, "missing", id);
		assert.equal(problemCount(snapshot), 0);
		assert.equal(snapshot.overview.installationStatus, "missing");
		assert.equal(snapshot.setup, null); assert.equal(snapshot.state, null); assert.equal(snapshot.overrides, null); assert.equal(snapshot.aiState, null);
		assert.equal(snapshot.system1?.status, "missing"); assert.equal(snapshot.system1?.readiness.status, "skipped");
		assert.equal(snapshot.stt, null); assert.deepEqual(snapshot.fleet.teams, []); assert.equal(snapshot.fleet.dispatch, null);
		assert.equal(snapshot.safety.autoPolicy.status, "disabled"); assert.equal(snapshot.safety.rules, null);
		assert.equal(snapshot.runtime, null); assert.deepEqual(snapshot.changedSinceStart, []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid JSON and non-object documents are reported as invalid, never thrown", () => {
	const root = workspace();
	try {
		write(root, ".ai/agent-fleet.json", "{ not json");
		write(root, ".ai/agent-fleet-ai-state.json", JSON.stringify({ schemaVersion: 1, entries: [] }));
		write(root, ".ai/stt.json", "[]");
		write(root, ".pi/agents/teams.yaml", "- just\n- a list\n");
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env });
		assert.equal(snapshot.sources.desired.status, "invalid");
		assert.equal(snapshot.overview.installationStatus, "invalid"); assert.equal(snapshot.overview.installationReason, "invalid_desired");
		assert.equal(snapshot.sources.aiState.status, "invalid"); assert.match(snapshot.sources.aiState.problems.join(), /entries/);
		assert.equal(snapshot.sources.stt.status, "invalid"); assert.equal(snapshot.stt, null);
		assert.equal(snapshot.sources.teams.status, "invalid"); assert.deepEqual(snapshot.fleet.teams, []);
		assert.ok(problemCount(snapshot) >= 4);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("symbolic links under .ai are refused and the target is never read", () => {
	const root = workspace();
	try {
		write(root, "outside.json", JSON.stringify({ schemaVersion: 1, preset: "default", features: { browser: true } }));
		symlinkSync(join(root, "outside.json"), join(root, ".ai", "agent-fleet.json"));
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env });
		assert.equal(snapshot.sources.desired.status, "refused");
		assert.match(snapshot.sources.desired.problems.join(), /symbolic link/);
		assert.equal(snapshot.setup, null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("desired, state and AI state render file facts: hashes compared, features listed as written", () => {
	const root = workspace();
	try {
		write(root, ".ai/agent-fleet.json", JSON.stringify({ schemaVersion: 1, preset: "full", features: { voice: true, "codex-remote": false } }));
		write(root, "skills/a/SKILL.md", "same");
		write(root, "skills/b/SKILL.md", "edited");
		write(root, ".ai/agent-fleet-state.json", JSON.stringify({
			schemaVersion: 2, agent: "pi", method: "copy", packageVersion: "2.0.14", sourceRoot: join(root, "nowhere"), installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
			items: {
				"skill:a": { kind: "skill", version: "2.0.14", method: "copy", files: [{ path: "skills/a/SKILL.md", sha256: sha("same") }] },
				"skill:b": { kind: "skill", version: "2.0.14", method: "copy", files: [{ path: "skills/b/SKILL.md", sha256: sha("original") }, { path: "skills/b/gone.md", sha256: sha("x") }] },
				"persona:p": { kind: "persona", files: [] },
			},
		}));
		write(root, ".ai/agent-fleet-transaction.json", "{}");
		write(root, ".ai/rules/one.md", "rule");
		write(root, ".ai/agent-fleet-ai-state.json", JSON.stringify({ schemaVersion: 1, entries: {
			".ai/rules/one.md": { origin: "template", templateId: "t", sourceVersion: "2.0.14", sourceHash: sha("t"), appliedHash: sha("rule"), evidence: ["e1", "e2"], acceptedDecision: "accept" },
			".ai/rules/two.md": { origin: "repo-derived", appliedHash: sha("zz"), evidence: [], acceptedDecision: "accept" },
		} }));
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env });
		assert.deepEqual(snapshot.setup, { preset: "full", schemaVersion: 1, features: [{ name: "codex-remote", enabled: false }, { name: "voice", enabled: true }] });
		assert.equal(snapshot.overview.recordedVersion, "2.0.14"); assert.equal(snapshot.overview.sourceRootPresent, false); assert.equal(snapshot.overview.transactionPending, true);
		assert.deepEqual(snapshot.state?.files, { total: 3, unchanged: 1, modified: 1, missing: 1, other: 0 });
		assert.deepEqual(snapshot.state?.byKind, [{ kind: "persona", count: 1 }, { kind: "skill", count: 2 }]);
		assert.deepEqual(snapshot.state?.items.map(item => item.id), ["persona:p", "skill:a", "skill:b"]);
		assert.deepEqual(snapshot.state?.items[2].files.map(file => file.check), ["modified", "missing"]);
		assert.deepEqual(snapshot.aiState?.entries.map(entry => [entry.path, entry.local, entry.evidenceCount]), [[".ai/rules/one.md", "unchanged", 2], [".ai/rules/two.md", "deleted", 0]]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("overrides: sections and keys are listed, the agent-team alias is marked, the hub parser is injected and start digests detect edits", () => {
	const root = workspace();
	try {
		write(root, ".ai/agent-fleet-overrides.md", "# Title\n\n## agent-team\nlanguage: Bulgarian\nmode: fast\nmodel.builder: anthropic/x\n\n## env\nAZURE_SPEECH_KEY: speech\n");
		const calls: string[] = [];
		const hub = { language: "Bulgarian", personaModels: { builder: "anthropic/x" }, personaModelLists: {}, personaThinking: {}, personaDelegateDepth: {}, rulesDirs: [], docsPaths: [], reconSearchTimeoutMs: 120_000, budgetOverrides: {}, watchdogSetting: "auto", watchdogJudgeModel: null, runHistoryKeep: 5, pollPanel: null, warnings: ["mode is ignored"] };
		const first = collectFleetConfigSnapshot({ cwd: root, env, readHubOverrides: cwd => { calls.push(cwd); return hub; } });
		assert.deepEqual(first.overrides?.sections.map(section => [section.name, section.canonical, section.alias, section.keys.length]), [["agent-team", "agent-hub", true, 3], ["env", "env", false, 1]]);
		assert.deepEqual(first.overrides?.sections[0].keys[2], { key: "model.builder", value: "anthropic/x", line: 6 });
		assert.equal(first.overrides?.hub?.warnings[0], "mode is ignored");
		assert.equal(calls.length, 1);
		const baseline = sourceDigests(first);
		write(root, ".ai/agent-fleet-overrides.md", "## agent-hub\nlanguage: English\n");
		const second = collectFleetConfigSnapshot({ cwd: root, env, startDigests: baseline });
		assert.deepEqual(second.changedSinceStart, ["overrides"]);
		assert.equal(second.overrides?.hub, null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("parseOverrideSections ignores text before the first heading and keeps raw values", () => {
	assert.deepEqual(parseOverrideSections("key: before\n## spec-driven-development\nspecs: docs/specs, specs\n"), [{ name: "spec-driven-development", canonical: "spec-driven-development", alias: false, keys: [{ key: "specs", value: "docs/specs, specs", line: 3 }] }]);
});

test("System 1 and STT expose env variable names and presence, never values", () => {
	const root = workspace();
	try {
		write(root, ".ai/agent-fleet.json", JSON.stringify({ schemaVersion: 1, preset: "default", features: { system1: true } }));
		write(root, ".ai/system1.json", JSON.stringify({ version: 2, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY", consumers: { watchdog: { mode: "active" } } }));
		write(root, ".ai/stt.json", JSON.stringify({ language: "bg-BG", provider: { type: "azure-openai", endpoint: "https://example.invalid", deployment: "d", apiVersion: "v", apiKeyEnv: "AZURE_SPEECH_KEY" } }));
		const secret = "sk-SECRET-VALUE-0000";
		const withKey = collectFleetConfigSnapshot({ cwd: root, env: { TYPESAFE_API_KEY: secret, AZURE_SPEECH_KEY: " " } as NodeJS.ProcessEnv });
		assert.equal(withKey.system1?.selected, true); assert.equal(withKey.system1?.apiKeyEnv, "TYPESAFE_API_KEY"); assert.equal(withKey.system1?.apiKeyPresent, true);
		assert.equal(withKey.system1?.readiness.status, "ready");
		assert.ok(withKey.system1?.consumers.some(consumer => consumer.name === "watchdog" && consumer.mode === "active"));
		assert.deepEqual(withKey.stt, { providerType: "azure-openai", language: "bg-BG", envNames: [{ name: "AZURE_SPEECH_KEY", present: false }] });
		assert.ok(!JSON.stringify(withKey).includes(secret), "secret value must not appear anywhere in the snapshot");
		const without = collectFleetConfigSnapshot({ cwd: root, env });
		assert.deepEqual(without.system1?.readiness, { status: "skipped", reason: "missing_key" }); assert.equal(without.system1?.apiKeyPresent, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet YAML: peers with runner/env_file presence, LIVE marks from the injected registry, dispatch substitutions and voices", () => {
	const root = workspace();
	try {
		write(root, ".pi/agents/teams.yaml", "default:\n  - builder\n  - code-reviewer\nplan:\n  - planner\n");
		write(root, ".pi/agents/peers.yaml", "review:\n  - name: claude-main\n    runner: claude-code\n    model: opus\n    env_file: .env.peer\n  - persona: code-reviewer\n    extensions: chrome-devtools-mcp\n");
		write(root, ".pi/agents/dispatch-policy.yaml", "default: native\ngrace_s: 30\nsubstitutions:\n  code-reviewer:\n    prefer: coms\n    fallback: none\n    timeout_s: 600\n  documenter: {}\n");
		write(root, ".pi/agents/voices.yaml", "default:\n  - name: sol\n    model: openai/x\n    thinking: medium\n  - name: opus\n    model: anthropic/y\n    integrator: true\n");
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env, livePeerNames: () => ["code-reviewer"] });
		assert.deepEqual(snapshot.fleet.teams, [{ name: "default", members: ["builder", "code-reviewer"] }, { name: "plan", members: ["planner"] }]);
		assert.deepEqual(snapshot.fleet.peers, [
			{ team: "review", name: "claude-main", persona: null, runner: "claude-code", model: "opus", extensions: null, envFile: ".env.peer", envFilePresent: false, live: false },
			{ team: "review", name: "code-reviewer", persona: "code-reviewer", runner: "pi", model: null, extensions: "chrome-devtools-mcp", envFile: null, envFilePresent: null, live: true },
		]);
		assert.deepEqual(snapshot.fleet.dispatch, { default: "native", graceS: 30, substitutions: [
			{ member: "code-reviewer", prefer: "coms", fallback: "none", timeoutS: 600, live: true },
			{ member: "documenter", prefer: "coms", fallback: "native", timeoutS: null, live: false },
		] });
		assert.deepEqual(snapshot.fleet.voices, [{ panel: "default", voices: [{ name: "sol", model: "openai/x", thinking: "medium", integrator: false }, { name: "opus", model: "anthropic/y", thinking: null, integrator: true }] }]);
		const failing = collectFleetConfigSnapshot({ cwd: root, env, livePeerNames: () => { throw new Error("registry down"); } });
		assert.ok(failing.fleet.peers.every(peer => !peer.live));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("safety: damage rule categories are counted and the auto-policy loader result is passed through", () => {
	const root = workspace();
	try {
		write(root, ".pi/damage-control-rules.yaml", "bashToolPatterns:\n  - pattern: a\n  - pattern: b\nzeroAccessPaths:\n  - .env\n");
		const snapshot = collectFleetConfigSnapshot({ cwd: root, env, now: Date.parse("2026-11-07T00:00:00.000Z") });
		assert.deepEqual(snapshot.safety.rules, [{ category: "bashToolPatterns", count: 2 }, { category: "zeroAccessPaths", count: 1 }]);
		assert.equal(snapshot.safety.autoPolicy.status, "disabled"); assert.equal(snapshot.safety.autoPolicy.rules, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime rows come only from the injected provider and a throwing provider degrades to null", () => {
	const root = workspace();
	try {
		assert.deepEqual(collectFleetConfigSnapshot({ cwd: root, env, runtimeRows: () => [{ label: "Work mode", detail: "operator" }] }).runtime, [{ label: "Work mode", detail: "operator" }]);
		assert.equal(collectFleetConfigSnapshot({ cwd: root, env, runtimeRows: () => { throw new Error("x"); } }).runtime, null);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
