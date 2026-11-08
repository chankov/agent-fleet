import assert from "node:assert/strict";
import test from "node:test";
import { configureArgv, configureDiffLines, cyclePreset, draftFeatureNames, draftFromSnapshot, parsePathList, planDigest, planPreviewLines, sameDraft, setupArgv, summarizeConfigurePreview, summarizePlan, summarizeResult, toggleFeature } from "./mutations.ts";

const snapshot: any = { setup: { preset: "default", schemaVersion: 1, features: [{ name: "voice", enabled: false }, { name: "system1", enabled: true }] }, inspect: { status: "ok", report: { desired: { catalogue: [{ name: "hermes" }, { name: "voice" }] } } } };
const plan = (overrides: Record<string, unknown> = {}) => ({
	publicSchemaVersion: 1, stage: "preview", verb: "setup", workspace: "/ws", writeDesired: false, firstMigration: false, migrationBlocked: false, migrationError: null,
	desired: { schemaVersion: 1, preset: "default", features: { voice: true, system1: false } },
	selection: { desired: { requestedFeatures: ["voice"], features: ["voice"] }, resolved: ["a", "b"] },
	actions: [
		{ kind: "keep", id: "skill:a", target: "skills/a", reason: null },
		{ kind: "create", id: "pi-extension:pi-voice-stt", target: ".pi/extensions/pi-voice-stt", reason: null, files: [{ path: ".pi/extensions/pi-voice-stt/index.ts", state: "absent" }] },
		{ kind: "skip", id: "companion:pi-extension-deps", reason: "runs a command — re-run with --allow-exec to include it" },
		{ kind: "operator", id: "hermes-plugin:x", reason: "operator step", operatorSteps: ["pair the device"] },
	],
	conflicts: [], notes: [{ type: "pinned", detail: "skill:b is kept — still required by skill:a" }],
	summary: { create: 1, keep: 1, skip: 1, operator: 1, changes: 1, total: 4 },
	stt: { write: false, preserved: true, provider: "azure-openai", warning: null }, taskTriage: null, overrides: { write: false },
	...overrides,
});

test("draft starts from the file, toggles and cycles deterministically, and maps to exact CLI arguments", () => {
	const draft = draftFromSnapshot(snapshot);
	assert.deepEqual(draft, { preset: "default", features: ["system1"] });
	assert.deepEqual(draftFeatureNames(snapshot, draft), ["hermes", "system1", "voice"]);
	const toggled = toggleFeature(toggleFeature(draft, "voice"), "system1");
	assert.deepEqual(toggled, { preset: "default", features: ["voice"] });
	assert.ok(!sameDraft(draft, toggled)); assert.ok(sameDraft(draft, draftFromSnapshot(snapshot)));
	assert.equal(cyclePreset(draft, ["default", "full", "minimal"]).preset, "full"); assert.equal(cyclePreset({ preset: "minimal", features: [] }, ["default", "full", "minimal"]).preset, "default");
	assert.deepEqual(setupArgv(toggled, { dryRun: true }), ["setup", "--json", "--preset", "default", "--features", "voice", "--save-desired", "--dry-run"]);
	assert.deepEqual(setupArgv({ preset: "full", features: [] }, { dryRun: false, taskTriageConsent: true, repairConfig: true }), ["setup", "--json", "--preset", "full", "--features", "none", "--save-desired", "--yes", "--task-triage-consent", "--repair-config"]);
	assert.deepEqual(setupArgv(toggled, { dryRun: true, taskTriageConsent: true, repairConfig: true }), ["setup", "--json", "--preset", "default", "--features", "voice", "--save-desired", "--dry-run"], "consent and repair flags only travel with --yes");
	assert.ok(!setupArgv(toggled, { dryRun: false }).includes("--allow-exec"));
	assert.deepEqual(configureArgv({ rules: [".ai/rules", "docs"], docs: [] }, { dryRun: true }), ["configure", "--rules", ".ai/rules,docs", "--dry-run"]);
	assert.deepEqual(configureArgv({ docs: ["docs"] }, { dryRun: false, expectedHash: "abc" }), ["configure", "--docs", "docs", "--yes", "--json", "--expect-hash", "abc"]);
});

test("plan summary keeps the CLI's words: kinds, non-keep actions, notes, conflicts, config repair and noop", () => {
	const preview = summarizePlan(plan());
	assert.equal(preview.stage, "plan");
	if (preview.stage !== "plan") return;
	assert.deepEqual(preview.byKind, [{ kind: "create", count: 1 }, { kind: "keep", count: 1 }, { kind: "operator", count: 1 }, { kind: "skip", count: 1 }]);
	assert.deepEqual(preview.actions.map(action => action.kind), ["create", "skip", "operator"]);
	assert.deepEqual(preview.actions[2].operatorSteps, ["pair the device"]);
	assert.deepEqual(preview.notes, ["skill:b is kept — still required by skill:a"]);
	assert.deepEqual(preview.desired, { preset: "default", features: ["voice"] }); assert.deepEqual(preview.requestedFeatures, ["voice"]); assert.equal(preview.resolvedItems, 2);
	assert.equal(preview.noop, false);
	const lines = planPreviewLines(preview, { preset: "default", features: ["voice"] });
	assert.match(lines[0], /^Desired state → preset default · features voice/); assert.ok(lines.some(line => /create   pi-extension:pi-voice-stt/.test(line))); assert.ok(lines.some(line => /operator: pair the device/.test(line)));
	const noop = summarizePlan(plan({ actions: [{ kind: "keep", id: "skill:a" }], summary: { keep: 1, changes: 0 } }));
	assert.equal(noop.stage === "plan" && noop.noop, true);
	assert.match(planPreviewLines(noop, null).join("\n"), /No changes: the workspace already matches/);
	const conflicts = summarizePlan(plan({ conflicts: [{ id: "skill:c", kind: "conflict", reason: "three-way conflict" }], actions: [{ kind: "conflict", id: "skill:c", reason: "three-way conflict" }] }));
	assert.equal(conflicts.stage === "plan" && conflicts.conflicts.length, 1);
	assert.match(planPreviewLines(conflicts, null).join("\n"), /CONFLICTS \(1\) — a human decision is required/);
	const repair = summarizePlan({ publicSchemaVersion: 1, stage: "config-repair-preview", configRepair: { path: ".ai/agent-fleet.json", removed: ["chatgpt-client"], requiresApproval: true, nextStep: "Run setup interactively, or setup --yes --repair-config. No mutation was applied." } });
	assert.deepEqual(repair, { stage: "config-repair", path: ".ai/agent-fleet.json", removed: ["chatgpt-client"], nextStep: "Run setup interactively, or setup --yes --repair-config. No mutation was applied." });
	assert.match(planPreviewLines(repair, null).join("\n"), /--repair-config --yes/);
	assert.equal(summarizePlan({ verb: "verify" }).stage, "unknown"); assert.equal(summarizePlan("x").stage, "unknown");
	const blocked = summarizePlan(plan({ migrationBlocked: true, migrationError: "first migration requires --migrate" }));
	assert.match(planPreviewLines(blocked, null).join("\n"), /BLOCKED: first migration requires --migrate/);
});

test("plan digest ignores order and timestamps but changes with any action, conflict, desired or side write", () => {
	const base = planDigest(plan());
	assert.equal(base, planDigest({ ...plan(), fingerprints: { at: "later" }, actions: [...plan().actions].reverse() }));
	assert.notEqual(base, planDigest(plan({ actions: [...plan().actions, { kind: "refresh", id: "skill:z", target: "skills/z" }] })));
	assert.notEqual(base, planDigest(plan({ conflicts: [{ id: "skill:c" }] })));
	assert.notEqual(base, planDigest(plan({ desired: { schemaVersion: 1, preset: "full", features: {} } })));
	assert.notEqual(base, planDigest(plan({ overrides: { write: true } })));
	assert.notEqual(base, planDigest(plan({ writeDesired: true })));
	assert.notEqual(planDigest({ configRepair: { removed: ["a"] } }), planDigest({ configRepair: { removed: ["b"] } }));
});

test("apply results and configure previews are projected without re-judging", () => {
	const ok = summarizeResult({ verb: "setup", exitCode: 0, results: [{ id: "skill:a", status: "applied", detail: null }, { id: "x", status: "skipped", detail: "operator step — printed, never performed" }], summary: { applied: 1, skipped: 1, failed: 0 } }, 0);
	assert.deepEqual([ok.ok, ok.summary.applied, ok.results[1].detail], [true, 1, "operator step — printed, never performed"]);
	const failed = summarizeResult({ verb: "setup", failure: { detail: "unresolved conflicts" }, summary: { applied: 0, failed: 1 } }, 3);
	assert.deepEqual([failed.ok, failed.failure], [false, "unresolved conflicts"]);
	assert.equal(summarizeResult(null, 0).ok, false);
	const preview = summarizeConfigurePreview({ verb: "configure", stage: "preview", path: ".ai/agent-fleet-overrides.md", expectedHash: "9fd7", write: true, before: "## agent-hub\nlanguage: Bulgarian\n\n", after: "## agent-hub\nlanguage: Bulgarian\nrules: docs\n" });
	assert.ok(preview); assert.equal(preview!.expectedHash, "9fd7");
	assert.deepEqual(configureDiffLines(preview!), ["  ## agent-hub", "  language: Bulgarian", "+ rules: docs", "  "]);
	assert.equal(summarizeConfigurePreview({ verb: "setup" }), null);
	assert.deepEqual(parsePathList(" docs, .ai/rules ,docs"), ["docs", ".ai/rules"]); assert.deepEqual(parsePathList(""), []);
	assert.equal(parsePathList("/abs"), null); assert.equal(parsePathList("a/../b"), null); assert.equal(parsePathList("a:b"), null);
});
