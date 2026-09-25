import "../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSystem1Service } from "../lib/system1/service.ts";
import type { JevTransport } from "../lib/system1/jev.ts";
import {
	ACTIVE_BLOCKED_LABEL,
	APPROVED_WATCHDOG_PROFILES,
	EXPERIMENTAL_SCOPE_PROFILE,
	createWatchdogSystem1Session,
	disposeWatchdogSystem1Session,
	readWatchdogSystem1Snapshot,
} from "./system1-runtime.ts";
import { createDriftMonitor } from "./drift-watchdog.js";
import { WATCHDOG_QUESTIONS, WATCHDOG_STATE_MAX_BYTES, buildWatchdogState } from "./drift-system1.ts";
import { decideSystem1, WATCHDOG_POLICY_VERSION, type AcceptedWatchdogProfile } from "./drift-system1-policy.ts";

const validConfig = {
	version: 1,
	mode: "auto",
	provider: "typesafe",
	model: "jev-1.13.0",
	apiKeyEnv: "TYPESAFE_API_KEY",
} as const;

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "watchdog-system1-"));
	mkdirSync(join(dir, ".ai"), { recursive: true });
	return dir;
}

function countingTransport(): { transport: JevTransport; calls: () => number; bodies: () => string[] } {
	const bodies: string[] = [];
	return {
		bodies: () => bodies,
		calls: () => bodies.length,
		transport: async (request) => {
			bodies.push(request.body.toString("utf8"));
			return { status: 401, headers: {}, body: "" };
		},
	};
}

function readyState() {
	const built = buildWatchdogState({
		task: "synthetic",
		scope: ["src/**"],
		elapsedMs: 1,
		observation: {
			events: [],
			counters: { tool_calls: 0, failures: 0, consecutive_failures: 0 },
			coverage: { events_seen: 0, unparsed_events: 0, dropped_by_window: 0, dropped_incomplete: 0 },
		},
	});
	if (!built.ok) throw new Error("ready state failed to build");
	return built.state;
}

const smallState = readyState();

test("off, missing feature, missing config, invalid config, disabled mode, missing key, and disarmed make zero transport calls", async () => {
	const fake = countingTransport();
	const ready = {
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		watchdogArmed: true,
		transport: fake.transport,
	};
	const cases = [
		createWatchdogSystem1Session({ ...ready, configuredMode: "off" }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", selected: false }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", config: undefined }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", config: { version: 1 } }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", config: { mode: "off" } }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", env: {} }),
		createWatchdogSystem1Session({ ...ready, configuredMode: "shadow", watchdogArmed: false }),
	];
	const results = [];
	for (const session of cases) {
		results.push(await session.evaluate({ armed: session.hubArmed, state: smallState }));
		session.dispose();
	}
	assert.deepEqual(results.map((result) => result.status === "skipped" || result.status === "unavailable" ? result.reason : result.status), [
		"consumer_off",
		"feature_unselected",
		"missing_config",
		"invalid_config",
		"disabled",
		"missing_key",
		"watchdog_disarmed",
	]);
	assert.equal(fake.calls(), 0);
});

test("explicit active opt-in uses the experimental scope profile without G2 approval", async () => {
	const fake = countingTransport();
	const session = createWatchdogSystem1Session({
		configuredMode: "active",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		transport: fake.transport,
	});
	assert.equal(session.configuredMode, "active");
	assert.equal(session.effectiveMode, "active");
	assert.equal(session.blockLabel, "experimental: scope only; G2 not validated");
	assert.deepEqual(session.approvedProfiles, [EXPERIMENTAL_SCOPE_PROFILE]);
	assert.deepEqual(session.approvedProfiles[0].rules, ["scope"]);
	assert.equal(APPROVED_WATCHDOG_PROFILES.length, 0);
	await session.evaluate({ armed: true, state: smallState });
	assert.equal(fake.calls(), 1);
	session.dispose();
});

test("experimental scope profile works for other workspaces only with explicit active opt-in", () => {
	const dir = workspace();
	try {
		writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
		writeFileSync(join(dir, ".ai", "system1.json"), JSON.stringify(validConfig));
		const open = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir, configuredMode: "active", watchdogSetting: "on", env: {},
		}));
		assert.equal(open.effectiveMode, "active");
		assert.equal(open.blockLabel, "experimental: scope only; G2 not validated");
		assert.deepEqual(open.approvedProfiles, [EXPERIMENTAL_SCOPE_PROFILE]);
		assert.deepEqual(open.approvedProfiles[0].rules, ["scope"]);
		assert.equal(open.approvedProfiles[0].minConfidence, 0.95);
		assert.equal(open.approvedProfiles[0].maxContradiction, 0.05);
		open.dispose();
		const closed = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir, configuredMode: "shadow", watchdogSetting: "on", env: {},
		}));
		assert.equal(closed.effectiveMode, "shadow");
		assert.equal(closed.blockLabel, null);
		assert.equal(closed.approvedProfiles.length, 0);
		closed.dispose();
		assert.equal(APPROVED_WATCHDOG_PROFILES.length, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("experimental profile never shortcuts a terminal rule even with a high-confidence answer", () => {
	const candidate = buildWatchdogState({ task: "synthetic", signal: { rule: "loop", terminal: true }, observation: {
		events: [], counters: { tool_calls: 1, failures: 0, consecutive_failures: 0, elapsed_ms: 1 },
		coverage: { events_seen: 0, dropped_by_window: 0, dropped_incomplete: 0, unparsed_events: 0, missing_tool_end: 0 },
	} });
	const answer = { status: "ok", evaluation: { metadata: { provider: "typesafe", requestedModel: "jev-1.13.0", returnedModel: "jev-1.13.0", questionSetVersion: "watchdog-questions/v1" },
		answers: [{ questionId: "status", type: "choice", value: "on_track", uncertainty: { provenance: "provider", confidence: 1, distribution: { on_track: 1, drifting: 0, stuck: 0, insufficient_evidence: 0 } } },
			...["repeating", "outside_task", "trail_carries_instructions"].map(questionId => ({ questionId, type: "predicate", probabilityTrue: 0, uncertainty: { provenance: "provider" } }))] } };
	assert.equal(decideSystem1(answer, { live: true, rule: "loop", state: candidate, requestedModel: "jev-1.13.0" }, EXPERIMENTAL_SCOPE_PROFILE).action, "llm");
});

test("G2 needs a matching provider/model/version and an actual Layer 1 rule, not just any injected profile", () => {
	const profile: AcceptedWatchdogProfile = {
		policyVersion: WATCHDOG_POLICY_VERSION,
		stateVersion: "watchdog-state/v1",
		questionsVersion: "watchdog-questions/v1",
		provider: "typesafe",
		model: "jev-1.13.0",
		rules: ["loop"],
		minConfidence: 0.8,
		maxContradiction: 0.1,
	};
	const session = (config: unknown, profiles: readonly AcceptedWatchdogProfile[]) => createWatchdogSystem1Session({
		configuredMode: "active", watchdogArmed: true, selected: true, config,
		env: {}, approvedProfilesForTest: profiles,
	});
	const unrelated = [
		session({ ...validConfig, model: "other" }, [profile]),
		session({ ...validConfig, provider: "other" }, [profile]),
		session(validConfig, [{ ...profile, rules: ["unknown"] }]),
		session(validConfig, [{ ...profile, stateVersion: "watchdog-state/v2" } as unknown as AcceptedWatchdogProfile]),
		session(validConfig, [{ ...profile, minConfidence: Number.NaN }]),
	];
	for (const entry of unrelated) {
		assert.equal(entry.effectiveMode, "shadow");
		assert.equal(entry.blockLabel, ACTIVE_BLOCKED_LABEL);
		assert.deepEqual(entry.approvedProfiles, []);
		entry.dispose();
	}
	const accepted = session(validConfig, [profile]);
	assert.equal(accepted.effectiveMode, "active");
	assert.equal(accepted.blockLabel, null);
	assert.equal(accepted.approvedProfiles.length, 1);
	accepted.dispose();
});

test("proactive receives only the existing watchdog-session service with its auth latch", async () => {
 const fake = countingTransport();
 const session = createWatchdogSystem1Session({ configuredMode: "off", watchdogArmed: false, selected: true,
  config: validConfig, env: { TYPESAFE_API_KEY: "test-key" }, transport: fake.transport });
 const shared = session.sharedService;
 assert.ok(shared);
 const request = { state: { probe: "shared" }, questions: [{ id: "known", type: "choice", instructions: "fixture", options: { yes: "yes", no: "no" } }], questionSetVersion: "fixture/v1", timeoutMs: 1000, requiredCapabilities: ["choice"] } as const;
 assert.equal((await shared.evaluate(request)).status, "unavailable");
 assert.equal((await shared.evaluate(request)).status, "unavailable");
 assert.equal(fake.calls(), 1);
 assert.strictEqual(session.sharedService, shared);
 session.dispose(); assert.equal(session.sharedService, undefined);
});
test("one session keeps the 401 latch; a restarted snapshot does not", async () => {
	const first = countingTransport();
	const session = createWatchdogSystem1Session({
		configuredMode: "shadow",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		transport: first.transport,
	});
	assert.deepEqual(await session.evaluate({ armed: true, state: smallState }), { status: "unavailable", reason: "auth" });
	assert.deepEqual(await session.evaluate({ armed: true, state: smallState }), { status: "unavailable", reason: "auth" });
	assert.equal(first.calls(), 1);
	const wire = JSON.parse(first.bodies()[0]);
	assert.equal(wire.questions.repeating.type, "noul");
	assert.equal(JSON.stringify(WATCHDOG_QUESTIONS).includes("noul"), false);
	assert.equal(JSON.stringify(wire).includes("\"ok\":false"), false);
	assert.equal(JSON.stringify(wire).includes("needs_external"), false);
	session.dispose();
	assert.equal((await session.evaluate({ armed: true, state: smallState })).reason, "disposed");
	assert.equal(first.calls(), 1);

	const restarted = countingTransport();
	const next = createWatchdogSystem1Session({
		configuredMode: "shadow",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		transport: restarted.transport,
	});
	await next.evaluate({ armed: true, state: smallState });
	assert.equal(restarted.calls(), 1);
	next.dispose();
});

test("missing capabilities return unsupported without a transport call", async () => {
	let calls = 0;
	const service = createSystem1Service({
		availability: { status: "ready" },
		provider: {
			name: "fake",
			model: "fake-1",
			capabilities: ["choice", "predicate"],
			evaluate: async () => {
				calls += 1;
				throw new Error("transport must not run");
			},
		},
	});
	const session = createWatchdogSystem1Session({
		configuredMode: "shadow",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: {},
		service,
	});
	assert.deepEqual(await session.evaluate({ armed: true, state: smallState }), {
		status: "unsupported",
		missingCapabilities: ["distribution", "probability_true"],
	});
	assert.equal(calls, 0);
});

test("snapshot reads feature and config as data, ignores dotenv, and does not hot-reload", async () => {
	const dir = workspace();
	const sentinel = "dotenv-sentinel-not-a-process-key";
	try {
		writeFileSync(join(dir, ".env"), `TYPESAFE_API_KEY=${sentinel}\n`);
		writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
		writeFileSync(join(dir, ".ai", "system1.json"), JSON.stringify(validConfig));
		const fake = countingTransport();
		const first = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir,
			configuredMode: "shadow",
			watchdogSetting: "auto",
			env: {},
			transport: fake.transport,
		}));
		assert.equal(first.readiness.status, "skipped");
		assert.equal(JSON.stringify(first).includes(sentinel), false);
		assert.equal((await first.evaluate({ armed: true, state: smallState })).reason, "missing_key");
		assert.equal(fake.calls(), 0);

		const env = { TYPESAFE_API_KEY: "snapshot-key" };
		const live = countingTransport();
		const snap = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir,
			configuredMode: "shadow",
			watchdogSetting: "off",
			env,
			transport: live.transport,
		}));
		writeFileSync(join(dir, ".ai", "system1.json"), JSON.stringify({ ...validConfig, mode: "off" }));
		delete env.TYPESAFE_API_KEY;
		assert.equal((await snap.evaluate({ armed: false, state: smallState })).reason, "watchdog_disarmed");
		assert.equal(live.calls(), 0);
		await snap.evaluate({ armed: true, state: smallState });
		assert.equal(live.calls(), 1);
		const reread = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir,
			configuredMode: "shadow",
			watchdogSetting: "auto",
			env: { TYPESAFE_API_KEY: "snapshot-key" },
			transport: live.transport,
		}));
		assert.deepEqual(reread.readiness, { status: "skipped", reason: "disabled" });
		assert.equal((await reread.evaluate({ armed: true, state: smallState })).reason, "disabled");
		assert.equal(live.calls(), 1);
		disposeWatchdogSystem1Session(snap);
		disposeWatchdogSystem1Session(reread);
		writeFileSync(join(dir, ".ai", "agent-fleet.json"), "{not json");
		writeFileSync(join(dir, ".ai", "system1.json"), "{not json");
		const malformed = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir,
			configuredMode: "shadow",
			watchdogSetting: "auto",
			env: { TYPESAFE_API_KEY: "snapshot-key" },
			transport: live.transport,
		}));
		assert.equal((await malformed.evaluate({ armed: true, state: smallState })).reason, "feature_unselected");
		writeFileSync(join(dir, ".ai", "agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
		const badConfig = createWatchdogSystem1Session(readWatchdogSystem1Snapshot({
			cwd: dir,
			configuredMode: "shadow",
			watchdogSetting: "auto",
			env: { TYPESAFE_API_KEY: "snapshot-key" },
			transport: live.transport,
		}));
		assert.equal((await badConfig.evaluate({ armed: true, state: smallState })).reason, "invalid_config");
		assert.equal(live.calls(), 1);
		malformed.dispose();
		badConfig.dispose();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("oversized state skips before transport and warnings stay on the session snapshot", async () => {
	const fake = countingTransport();
	const session = createWatchdogSystem1Session({
		configuredMode: "shadow",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		transport: fake.transport,
		warnings: ["watchdog-system1 \"sideways\" is not one of off|shadow|active — using off"],
	});
	const raw = {
		raw_command: "rm -rf PROBE_COMMAND",
		absolute: "/home/user/.ssh/id_rsa",
		api_key: "sk-abcdefghijklmnopqrstuvwxyz",
	};
	assert.equal((await session.evaluate({ armed: true, state: raw })).reason, "invalid_state");
	assert.equal((await session.evaluate({ armed: true, state: { ok: true, bytes: 10, state: undefined } })).reason, "invalid_state");
	assert.equal((await session.evaluate({ armed: true, state: { schema: "watchdog-state/v1", task: "synthetic", raw_command: "rm -rf PROBE_COMMAND" } })).reason, "invalid_state");
	assert.equal((await session.evaluate({ armed: true, state: { ok: false, reason: "state_too_large", bytes: WATCHDOG_STATE_MAX_BYTES + 1 } })).reason, "state_too_large");
	assert.equal(fake.calls(), 0);
	assert.equal(session.warnings.length, 1);
	await session.evaluate({ armed: true, state: smallState });
	assert.equal(session.warnings.length, 1);
	session.dispose();
	session.dispose();
});

test("a non-conforming state makes zero transport calls and a built state is what the transport sees", async () => {
	const fake = countingTransport();
	const session = createWatchdogSystem1Session({
		configuredMode: "shadow",
		watchdogArmed: true,
		selected: true,
		config: validConfig,
		env: { TYPESAFE_API_KEY: "test-key" },
		transport: fake.transport,
	});
	const command = "rm -rf SECRET_COMMAND_DO_NOT_SEND";
	const body = "SECRET_WRITE_BODY_DO_NOT_SEND";
	const secret = "sk-abcdefghijklmnopqrstuvwxyz";
	assert.equal((await session.evaluate({
		armed: true,
		state: { raw_command: command, absolute: "/home/user/.ssh/id_rsa", api_key: secret },
	})).reason, "invalid_state");
	assert.equal(fake.calls(), 0);

	const monitor = createDriftMonitor({ maxRepeats: 100, maxToolCalls: 1000 });
	monitor.onToolStart("bash", JSON.stringify({ command }), "bash-1");
	monitor.onToolEnd("bash", false, "bash-1");
	monitor.onToolStart("write", JSON.stringify({ path: "/repo/.pi/agent-sessions/artifacts/plans/x.md", content: body }), "write-1");
	monitor.onToolEnd("write", false, "write-1");
	const built = buildWatchdogState({
		task: `Fix login ${secret}`,
		scope: ["src/**"],
		hubOwnedPaths: [".pi/agent-sessions/artifacts/**"],
		root: "/repo",
		elapsedMs: 1000,
		signal: { rule: "loop", terminal: true, detail: `edit touched /etc/passwd ${secret}` },
		observation: monitor.structuredObservation(),
	});
	assert.equal(built.ok, true);
	if (!built.ok) return;
	await session.evaluate({ armed: true, state: built });
	assert.equal(fake.calls(), 1);
	const wire = JSON.parse(fake.bodies()[0]);
	assert.equal(wire.state.schema, "watchdog-state/v1");
	assert.equal(wire.state.tool_events[1].path, ".pi/agent-sessions/artifacts/plans/x.md");
	assert.equal(wire.state.tool_events[1].protocol_owned, true);
	assert.equal(wire.state.coverage.shortcut_blocked, true);
	assert.equal(wire.questions.repeating.type, "noul");
	assert.equal(JSON.stringify(wire.state).includes("noul"), false);
	const serialized = JSON.stringify(wire);
	for (const sentinel of [command, body, secret, "/etc/passwd", "/home/user/.ssh/id_rsa", "/repo", "needs_external", '"ok":false']) {
		assert.equal(serialized.includes(sentinel), false, sentinel);
	}
	session.dispose();
});

test("index wires a session singleton and does not evaluate or touch the fence", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /createWatchdogSystem1Session\(readWatchdogSystem1Snapshot\(/);
	assert.match(source, /watchdogSystem1 = disposeWatchdogSystem1Session\(watchdogSystem1\)/);
	assert.equal(source.includes("watchdogSystem1.evaluate"), false);
	assert.match(source, /fenceOperatorCancel\(st\)/);
	assert.equal(source.includes("disposeAll"), false);
});
