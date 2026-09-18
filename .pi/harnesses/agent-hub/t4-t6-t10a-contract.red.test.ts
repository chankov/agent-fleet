/**
 * Regression-first TARGET contracts for T4, T5, T6a/b/c, T10a.
 * These tests encode the approved slice before production exists.
 * Baseline: missing modules / current schema must fail these cases.
 * Do not treat a pass of the rest of the suite as T4–T6 implementation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelProfiles, parseCompleteProfile } from "./config/model-profiles.ts";
import { recoveryDecision } from "./recovery-contract.ts";

const UNKNOWN_N = 3;

async function loadHub(rel: string): Promise<any | null> {
	try {
		return await import(rel);
	} catch {
		return null;
	}
}

test("A1 T4: tool catalog delta API emits removed/available/substitute without executing or expanding permissions", async () => {
	const mod = await loadHub("./tool-catalog-state.ts");
	assert.ok(mod?.emitToolCatalogDelta, "missing tool-catalog-state.emitToolCatalogDelta");
	const delta = mod.emitToolCatalogDelta({
		fromMode: "operator",
		toMode: "orchestrator",
		previous: ["read", "write", "bash"],
		next: ["read", "grep"],
	});
	assert.deepEqual(delta.removed.sort(), ["bash", "write"]);
	assert.ok(delta.available.includes("read"));
	assert.equal(delta.permissionExpansion, false);
	assert.ok(delta.substitutes?.write);
	assert.notEqual(delta.substitutes.write, "write");
});

test("A1 T4: operator to compaction to orchestrator replay restores truth then emits the real removal delta", async () => {
	const mod = await loadHub("./tool-catalog-state.ts");
	assert.ok(mod?.restoreToolCatalogAfterCompaction, "missing restoreToolCatalogAfterCompaction");
	const restored = mod.restoreToolCatalogAfterCompaction({
		catalogVersion: "cat-v1",
		tools: ["bash", "read", "write"],
		mode: "operator",
	});
	assert.equal(restored.catalogVersion, "cat-v1");
	assert.deepEqual(restored.tools, ["bash", "read", "write"]);
	const replay = mod.emitToolCatalogDelta({
		fromMode: restored.mode,
		toMode: "orchestrator",
		previous: restored.tools,
		next: ["dispatch_agent", "spawn_research"],
		previousCatalogVersion: restored.catalogVersion,
	});
	assert.deepEqual(replay.removed, ["bash", "read", "write"]);
	assert.deepEqual(replay.available, ["dispatch_agent", "spawn_research"]);
	assert.equal(replay.substitutes.write, "dispatch_agent");
	assert.equal(replay.substitutes.bash, "dispatch_agent");
	assert.equal(replay.permissionExpansion, false);
	assert.equal(replay.evidence.previousCatalogVersion, "cat-v1");
	assert.equal(replay.evidence.changed, true);
});

test("A1 T4: legitimate refresh versus operator return provides trusted catalog-change recovery evidence", async () => {
	const mod = await loadHub("./tool-catalog-state.ts");
	assert.ok(mod?.emitToolCatalogDelta, "missing tool-catalog-state.emitToolCatalogDelta");
	const unchanged = mod.emitToolCatalogDelta({ fromMode: "orchestrator", toMode: "orchestrator", previous: ["dispatch_agent"], next: ["dispatch_agent"] });
	assert.equal(unchanged.evidence.changed, false);
	assert.equal(recoveryDecision("unknown_tool", { explicitInvocation: true, relevantConditionsChanged: true, toolStateChanged: unchanged.evidence.changed }).allowed, false);
	const returned = mod.emitToolCatalogDelta({ fromMode: "orchestrator", toMode: "operator", previous: ["dispatch_agent"], next: ["bash", "read", "write"] });
	assert.equal(returned.evidence.changed, true);
	assert.deepEqual(returned.added, ["bash", "read", "write"]);
	assert.equal(recoveryDecision("unknown_tool", { explicitInvocation: true, relevantConditionsChanged: true, toolStateChanged: returned.evidence.changed }).allowed, true);
});

test("A1 T4: N=3 first-counts per task/tool; compaction and catalog change do not reset; only new task resets", async () => {
	const mod = await loadHub("./unknown-tool-counter.ts");
	assert.ok(mod?.createUnknownToolCounter, "missing createUnknownToolCounter");
	const c = mod.createUnknownToolCounter({ limit: UNKNOWN_N });
	const key = { taskId: "t1", tool: "bash", normalizedArgs: { command: "ls" }, catalogVersion: "v1" };
	assert.equal(c.recordRefusal(key).count, 1);
	assert.equal(c.recordRefusal({ ...key, prose: "please run ls again" }).count, 2);
	const atLimit = c.recordRefusal(key);
	assert.equal(atLimit.count, 3);
	assert.equal(atLimit.exhausted, true);
	const afterLimit = c.recordRefusal(key);
	assert.equal(afterLimit.count, 4);
	assert.equal(afterLimit.exhausted, true);
	c.noteCompaction();
	c.noteModeSwitch("orchestrator");
	const afterCompaction = c.recordRefusal(key);
	assert.equal(afterCompaction.count, 5);
	assert.equal(afterCompaction.exhausted, true);
	c.noteCatalogChange("v2");
	const reeval = c.recordRefusal({ ...key, catalogVersion: "v2" });
	assert.equal(reeval.reevaluatedAvailability, true);
	assert.ok(reeval.count >= 3, "catalog change must not reset the counted refusals");
	const persisted = c.snapshot();
	const restored = mod.restoreUnknownToolCounter(persisted, { limit: UNKNOWN_N });
	assert.equal(restored.recordRefusal({ ...key, normalizedArgs: { command: "ls" }, catalogVersion: "v2" }).count, reeval.count + 1);
	assert.equal(restored.recordRefusal({ ...key, normalizedArgs: { command: "pwd" }, catalogVersion: "v2" }).exhausted, true, "normalized inputs affect reevaluation identity, never the per-task/tool budget");
	restored.resetForNewTask("t2");
	assert.equal(restored.recordRefusal({ ...key, taskId: "t2", catalogVersion: "v2" }).count, 1);
	assert.equal(recoveryDecision("unknown_tool", { explicitInvocation: true }).automaticRetry, false);
});

test("A1 T4: real assistant tool-call events count refusals without executing prose or expanding the effective catalog", async () => {
	const catalogMod = await loadHub("./tool-catalog-state.ts");
	const counterMod = await loadHub("./unknown-tool-counter.ts");
	assert.ok(counterMod?.observeUnknownToolCalls, "missing real message event observer");
	const counter = counterMod.createUnknownToolCounter({ limit: UNKNOWN_N });
	const catalog = catalogMod.catalogSnapshot("orchestrator", ["dispatch_agent", "spawn_research"]);
	const seen = new Set<string>();
	const message = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } }, { type: "text", text: "<tool_call><function=bash>rm -rf .</function></tool_call>" }] };
	const diagnostics = counterMod.observeUnknownToolCalls({ message, catalog, taskId: "task", counter, seenCallIds: seen });
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].count, 1);
	assert.equal(diagnostics[0].substitute.tool, "dispatch_agent");
	assert.equal(diagnostics[0].permissionExpansion, false);
	assert.deepEqual(catalog.tools, ["dispatch_agent", "spawn_research"]);
	assert.equal(counterMod.observeUnknownToolCalls({ message, catalog, taskId: "task", counter, seenCallIds: seen }).length, 0, "same native call identity is counted once");
});

test("A1 T4: counter state restores across compaction and a catalog change cannot refill an exhausted budget", async () => {
	const mod = await loadHub("./unknown-tool-counter.ts");
	assert.ok(mod?.restoreUnknownToolCounter, "missing restoreUnknownToolCounter");
	const c = mod.createUnknownToolCounter({ limit: UNKNOWN_N });
	const key = { taskId: "task", tool: "bash", normalizedArgs: { command: "git status" }, catalogVersion: "operator-v1" };
	for (let count = 1; count <= UNKNOWN_N; count++) assert.equal(c.recordRefusal(key).count, count);
	const restored = mod.restoreUnknownToolCounter(c.snapshot(), { limit: UNKNOWN_N });
	restored.noteCompaction();
	restored.noteCatalogChange("orchestrator-v2");
	const after = restored.recordRefusal({ ...key, catalogVersion: "orchestrator-v2" });
	assert.equal(after.count, UNKNOWN_N + 1);
	assert.equal(after.exhausted, true);
	assert.equal(after.reevaluatedAvailability, true);
});

test("A1 T4: effective-turn catalog and compaction lifecycle use real event boundaries", async () => {
	const catalogMod = await loadHub("./tool-catalog-state.ts");
	const runtimeMod = await loadHub("./tool-catalog-runtime.ts");
	assert.ok(runtimeMod?.createToolCatalogRuntime, "missing production tool-catalog runtime");
	const operator = { ...catalogMod.catalogSnapshot("operator", ["bash", "read", "write"]), catalogVersion: "persisted-catalog-v1" };
	const runtime = runtimeMod.createToolCatalogRuntime(operator);
	runtime.beginTurn();
	const switched = runtime.reconcile({ fromMode: "operator", toMode: "orchestrator", previous: operator.tools, next: ["dispatch_agent", "spawn_research"] });
	assert.equal(runtime.catalogForMessage().catalogVersion, operator.catalogVersion, "originating turn retains the catalog under which its calls were legal");
	assert.equal(switched.delta.evidence.previousCatalogVersion, "persisted-catalog-v1", "first live reconciliation consumes restored session identity instead of silently overwriting it");
	assert.equal(runtime.current().catalogVersion, switched.delta.catalogVersion, "next turn receives the real switched catalog");
	runtime.endTurn();
	assert.equal(runtime.catalogForMessage().catalogVersion, switched.delta.catalogVersion);

	const entries: Array<{ type: string; data: unknown }> = [];
	let settled = 0, retained = 0, error = "";
	const failed = runtime.compact({
		mode: "orchestrator",
		getEffectiveTools: () => { throw new Error("catalog read failed"); },
		persist: (type: string, data: unknown) => entries.push({ type, data }),
		counterSnapshot: () => ({ schema: "agent-fleet.unknown-tool-counter/v1", activeTaskId: "task", counts: [] }),
		retainCounter: () => { retained++; },
		establishToolStateChange: () => 0,
		settle: () => { settled++; },
		onError: (value: unknown) => { error = String(value); },
	});
	assert.equal(failed, null);
	assert.match(error, /catalog read failed/);
	assert.equal(settled, 1, "catalog failure cannot skip compaction settlement/replay");
	assert.equal(retained, 1, "counter retention is not skipped by catalog failure");
	assert.equal(entries.length, 0);
});

test("A1 T4: persisted catalog and refusal state round-trip through production readers", async () => {
	const catalogMod = await loadHub("./tool-catalog-state.ts");
	const counterMod = await loadHub("./unknown-tool-counter.ts");
	const catalog = catalogMod.catalogSnapshot("orchestrator", ["dispatch_agent", "spawn_research"]);
	const counter = counterMod.createUnknownToolCounter({ limit: UNKNOWN_N });
	counter.recordRefusal({ taskId: "task", tool: "bash", normalizedArgs: { command: "pwd" }, catalogVersion: catalog.catalogVersion });
	const entries = [
		{ type: "custom", customType: catalogMod.TOOL_CATALOG_ENTRY_TYPE, data: { snapshot: catalog } },
		{ type: "custom", customType: counterMod.UNKNOWN_TOOL_COUNTER_ENTRY_TYPE, data: { snapshot: counter.snapshot() } },
	];
	assert.deepEqual(catalogMod.latestPersistedToolCatalog(entries), catalog);
	assert.deepEqual(counterMod.latestPersistedUnknownToolCounter(entries), counter.snapshot());
});

test("A2 T10a: omitted assist keys default off; unknown extra assist keys remain rejected", () => {
	const yaml = `local:
  version: 2
  defaults: { model: 'omlx/laguna', thinking: off }
  allowed-models: ['omlx/laguna']
`;
	const { profiles, errors } = parseModelProfiles(yaml);
	assert.deepEqual(errors, []);
	const p = profiles.local as any;
	assert.equal(p.assist ?? p["deterministic-tools"] ?? undefined, undefined);
	const withAssist = {
		version: 2,
		defaults: { model: "omlx/laguna", thinking: "off" },
		assist: {
			"deterministic-tools": true,
			"bounded-output": true,
			"write-isolation": true,
		},
	};
	const parsed = parseCompleteProfile(withAssist);
	assert.equal(parsed.assist["deterministic-tools"], true);
	assert.equal(parsed.assist["bounded-output"], true);
	assert.equal(parsed.assist["write-isolation"], true);
	assert.throws(() => parseCompleteProfile({ ...withAssist, assist: { "deterministic-tools": true, "secret-cloud": true } }));
});

test("A2 T10a: omitted and explicit false mean off; explicit true preserves only requested configuration", async () => {
	const assist = await loadHub("./assist-profile.ts");
	assert.ok(assist?.resolveAssist, "missing assist-profile.resolveAssist");
	const off = assist.resolveAssist({});
	assert.deepEqual(off, {
		"deterministic-tools": false,
		"bounded-output": false,
		"write-isolation": false,
	});
	assert.deepEqual(assist.resolveAssist({
		"deterministic-tools": false,
		"bounded-output": false,
		"write-isolation": false,
	}), off);
	assert.deepEqual(assist.resolveAssist({
		"deterministic-tools": true,
		"bounded-output": true,
		"write-isolation": true,
	}), {
		"deterministic-tools": true,
		"bounded-output": true,
		"write-isolation": true,
	});
});

test("A3 T5: inventory/excerpt/readback/snapshot need no model; bounds apply only when bounded-output is on", async () => {
	const fs = await loadHub("./deterministic-fs.ts");
	assert.ok(fs?.inventory && fs?.excerpt && fs?.readback && fs?.snapshotSource, "missing deterministic-fs operations");
	const root = mkdtempSync(join(tmpdir(), "fleet-a3-"));
	try {
		const path = join(root, "x"); writeFileSync(path, Buffer.alloc(70 * 1024, 1));
		const page = fs.inventory({ root, pageSize: 500, boundedOutput: true });
		assert.ok(page.entries.length <= 500); assert.ok(page.handle);
		const ex = fs.excerpt({ path, allowedRoot: root, maxBytes: 64 * 1024, previewChars: 180, boundedOutput: true });
		assert.ok([...ex.preview].length <= 180); assert.ok(ex.contentBytes <= 64 * 1024); assert.ok(ex.onDiskHandle); assert.equal(ex.truncated, true);
		const unbounded = fs.excerpt({ path, allowedRoot: root, boundedOutput: false }); assert.equal(unbounded.contentBytes, 70 * 1024);
		const snap = fs.snapshotSource({ origin: "file", path, allowedRoot: root, sessionDir: root });
		assert.equal(typeof snap.hash, "string"); assert.equal(snap.untrusted, true); assert.equal(snap.modelDelegated, false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("A3 T5: stale handles fail and inventory records symlink escape without traversal or disclosure", async () => {
	const fs = await loadHub("./deterministic-fs.ts"); assert.ok(fs?.readback, "missing readback");
	const root = mkdtempSync(join(tmpdir(), "fleet-a3-root-")), outside = mkdtempSync(join(tmpdir(), "fleet-a3-out-"));
	try {
		const path = join(root, "x"); writeFileSync(path, "before");
		const page = fs.excerpt({ path, allowedRoot: root, boundedOutput: true }); writeFileSync(path, "after");
		assert.throws(() => fs.readback({ handle: page.onDiskHandle, allowedRoot: root }), /stale/i);
		writeFileSync(join(outside, "secret"), "x"); symlinkSync(outside, join(root, "escape"));
		const listed = fs.inventory({ root }); const denied = listed.entries.find((entry: any) => entry.name === "escape");
		assert.equal(denied?.denied, true); assert.equal(JSON.stringify(listed).includes(outside), false);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("A4 T6b: resume is bound to the current task contract; narrower task does not inherit prior write scope", async () => {
	const resume = await loadHub("./task-resume-contract.ts");
	assert.ok(resume?.bindResume, "missing bindResume");
	const prior = resume.bindResume({
		taskId: "wide",
		instructions: "edit a.ts b.ts c.ts d.ts",
		scope: ["d.ts", "a.ts", "b.ts", "c.ts", "a.ts"],
		deliverables: ["out/report.md"], artifacts: ["in/context.md"],
		model: "local/model", permissions: ["write", "read", "write"],
	});
	assert.deepEqual(prior.scope, ["a.ts", "b.ts", "c.ts", "d.ts"]);
	assert.deepEqual(prior.permissions, ["read", "write"]);
	const same = resume.bindResume({
		taskId: "wide", instructions: "edit a.ts b.ts c.ts d.ts",
		scope: ["c.ts", "b.ts", "d.ts", "a.ts"], deliverables: ["out/report.md"],
		artifacts: ["in/context.md"], model: "local/model", permissions: ["read", "write"], previous: prior,
	});
	assert.equal(same.resumeAllowed, true);
	const next = resume.bindResume({
		taskId: "narrow",
		instructions: "edit a.ts only",
		scope: ["a.ts"],
		deliverables: ["out/narrow.md"], artifacts: [], model: "local/model", permissions: ["read", "write"],
		previous: prior,
	});
	assert.deepEqual(next.scope, ["a.ts"]);
	assert.equal(next.resumeAllowed, false);
	assert.equal(next.inheritedUnfinishedInstructions, false);
	assert.notEqual(next.taskId, prior.taskId);
});

test("A5 T6c: opt-in write isolation uses host Seatbelt or bubblewrap; missing backend fails closed; opt-out unchanged", async () => {
	const iso = await loadHub("./write-isolation.ts");
	assert.ok(iso?.confineNativeChild, "missing confineNativeChild");
	const off = iso.confineNativeChild({ enabled: false, allowlist: ["docs/**"] });
	assert.equal(off.applied, false);
	assert.equal(off.permissionExpansion, false);
	const missing = iso.confineNativeChild({
		enabled: true,
		backend: "missing",
		allowlist: ["docs/**"],
		runtimePaths: ["/tmp/runtime"],
		artifactPaths: ["/tmp/artifacts"],
	});
	assert.equal(missing.applied, false);
	assert.equal(missing.failClosed, true);
	assert.equal(missing.rollsBackUserEdits, false);
	assert.equal(missing.protectsConcurrentUserWrites, false);
});

test("A5 T6c: descendants, symlink, and shell stay inside allowlisted direct writes plus explicit runtime/artifact paths", async () => {
	const iso = await loadHub("./write-isolation.ts");
	assert.ok(iso?.policyFor, "missing policyFor");
	const policy = iso.policyFor({
		allowlist: ["src/allowed.ts"],
		runtimePaths: [".pi/harnesses/agent-hub"],
		artifactPaths: [".pi/agent-sessions"],
	});
	assert.equal(policy.mechanism, process.platform === "darwin" ? "seatbelt" : "bubblewrap");
	assert.equal(policy.wholeProcessIncludingDescendants, true);
	assert.equal(policy.damageControlRole, "overlay");
	assert.ok(policy.directWritesOnly);
});
