import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { acquireCompletionSeriesLock, completionSeriesLockPath, createCompletionSeriesState, fenceCompletionSeries, migrateCompletionSeriesBudget, readCompletionSeriesState, releaseCrashedCompletionSeriesLock, releaseOwnedCompletionSeriesLock, reserveCompletionRequest, sharedCompletionSeriesBudgetPath, T12_SERIES_LIMITS, writeCompletionSeriesState } from "./diagnostic-series-budget.ts";
function fixture() { return mkdtempSync(join(tmpdir(), "af-series-test-")); }

test("reusable completion-series budget is shared above individual sessions and fences later requests", () => {
	const dir = fixture(), session = join(dir, "sessions", "session-a"), path = join(dir, "budget.json");
	assert.equal(sharedCompletionSeriesBudgetPath(session, "series"), join(dir, "series", "series-budget.json"));
	try {
		writeCompletionSeriesState(path, createCompletionSeriesState("series"));
		const lockPath = completionSeriesLockPath(path), lock = acquireCompletionSeriesLock(lockPath);
		assert.equal(reserveCompletionRequest(path, 0, lockPath, lock.ownerId, "diagnostic").stages.diagnostic.requestsStarted, 1);
		assert.equal(fenceCompletionSeries(path, lockPath, lock.ownerId).cancelled, true);
		assert.throws(() => reserveCompletionRequest(path, 0, lockPath, lock.ownerId, "diagnostic"), /fenced/);
		releaseOwnedCompletionSeriesLock(lockPath, lock.ownerId);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T12 v2 migration preserves explicit reservation history and refuses ambiguous consumed v1 state byte-for-byte", () => {
	const dir = fixture(), clear = join(dir, "clear.json"), explicit = join(dir, "explicit.json"), ambiguous = join(dir, "ambiguous.json");
	try {
		writeFileSync(clear, JSON.stringify({ schema: "agent-fleet.completion-series-budget/v1", seriesId: "clear", seriesRequestsStarted: 0, stageRequestsStarted: 0, cancelled: false, limits: {} }));
		const migratedClear = migrateCompletionSeriesBudget(clear); assert.equal(migratedClear.schema, "agent-fleet.completion-series-budget/v2"); assert.equal(migratedClear.reservationHistory.length, 0);
		const history = [{ stage: "diagnostic", startedAt: "2026-01-01T00:00:00.000Z" }, { stage: "benchmark", startedAt: "2026-01-01T00:00:01.000Z" }];
		writeFileSync(explicit, JSON.stringify({ schema: "agent-fleet.completion-series-budget/v1", seriesId: "explicit", seriesRequestsStarted: 2, stageRequestsStarted: 2, cancelled: true, reservationHistory: history, limits: {} }));
		const migrated = migrateCompletionSeriesBudget(explicit); assert.equal(migrated.cancelled, true); assert.deepEqual(migrated.reservationHistory.map(item => item.stage), ["diagnostic", "benchmark"]); assert.deepEqual(migrated.stages, { diagnostic: { requestsStarted: 1 }, benchmark: { requestsStarted: 1 } });
		writeFileSync(ambiguous, JSON.stringify({ schema: "agent-fleet.completion-series-budget/v1", seriesId: "ambiguous", seriesRequestsStarted: 2, stageRequestsStarted: 2, cancelled: false, limits: {} }));
		const before = readFileSync(ambiguous); assert.throws(() => migrateCompletionSeriesBudget(ambiguous), /ambiguous v1/); assert.deepEqual(readFileSync(ambiguous), before);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("T12 shared v2 ledger enforces diagnostic 12, benchmark 48, per-unit 2/4, and whole-series 60", () => {
	const dir = fixture(), budget = join(dir, "budget.json"), lockPath = completionSeriesLockPath(budget); writeCompletionSeriesState(budget, createCompletionSeriesState("series")); const lock = acquireCompletionSeriesLock(lockPath);
	try {
		for (let unit = 0; unit < 6; unit++) for (let request = 0; request < 2; request++) reserveCompletionRequest(budget, request, lockPath, lock.ownerId, "diagnostic");
		assert.throws(() => reserveCompletionRequest(budget, 0, lockPath, lock.ownerId, "diagnostic"), /diagnostic-stage/);
		for (let unit = 0; unit < 12; unit++) for (let request = 0; request < 4; request++) reserveCompletionRequest(budget, request, lockPath, lock.ownerId, "benchmark");
		const state = readCompletionSeriesState(budget); assert.equal(state.seriesRequestsStarted, 60); assert.equal(state.stages.diagnostic.requestsStarted, 12); assert.equal(state.stages.benchmark.requestsStarted, 48); assert.equal(state.reservationHistory.length, 60);
		assert.throws(() => reserveCompletionRequest(budget, 0, lockPath, lock.ownerId, "benchmark"), /whole-series/);
		assert.deepEqual(state.limits, T12_SERIES_LIMITS);
	} finally { releaseOwnedCompletionSeriesLock(lockPath, lock.ownerId); rmSync(dir, { recursive: true, force: true }); }
});

test("completion-series lock refuses a concurrent process immediately and requires explicit dead-owner release", () => {
	const dir = fixture(), budget = join(dir, "budget.json"), lockPath = completionSeriesLockPath(budget);
	writeCompletionSeriesState(budget, createCompletionSeriesState("series"));
	const lock = acquireCompletionSeriesLock(lockPath);
	try {
		const moduleUrl = pathToFileURL(new URL("./diagnostic-series-budget.ts", import.meta.url).pathname).href;
		const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `import {acquireCompletionSeriesLock} from ${JSON.stringify(moduleUrl)}; try{acquireCompletionSeriesLock(${JSON.stringify(lockPath)});process.exit(0)}catch{process.exit(75)}`]);
		assert.equal(child.status, 75);
		assert.throws(() => releaseCrashedCompletionSeriesLock(lockPath), /live pid/);
	} finally { releaseOwnedCompletionSeriesLock(lockPath, lock.ownerId); }
	writeFileSync(lockPath, JSON.stringify({ schema: "agent-fleet.completion-series-lock/v1", ownerId: "crashed", pid: 99999999, acquiredAt: new Date().toISOString() }));
	assert.equal(releaseCrashedCompletionSeriesLock(lockPath), "released");
	rmSync(dir, { recursive: true, force: true });
});


test("unit limits and ownership refusals preserve charged accounting byte-for-byte", () => {
 const dir = fixture(), budget = join(dir, "budget.json"), lockPath = completionSeriesLockPath(budget);
 writeCompletionSeriesState(budget, createCompletionSeriesState("series"));
 const lock = acquireCompletionSeriesLock(lockPath);
 try {
  for (const stage of ["diagnostic", "benchmark"] as const) {
   const limit = T12_SERIES_LIMITS.maxRequestsPerUnit[stage];
   for (let n = 0; n < limit; n++) reserveCompletionRequest(budget, n, lockPath, lock.ownerId, stage);
   const before = readFileSync(budget);
   assert.throws(() => reserveCompletionRequest(budget, limit, lockPath, lock.ownerId, stage), /unit provider request budget exhausted/);
   assert.throws(() => reserveCompletionRequest(budget, 0, lockPath, "not-owner", stage), /not owned/);
   assert.deepEqual(readFileSync(budget), before);
  }
 } finally { releaseOwnedCompletionSeriesLock(lockPath, lock.ownerId); rmSync(dir, { recursive: true, force: true }); }
});

test("shared conservative input preflight rejects oversized or unserializable payloads", async () => {
 const { conservativeTextInputPreflight } = await import("./diagnostic-series-budget.ts");
 const payload = { messages: [{ role: "user", content: "малък текст" }] };
 const result = conservativeTextInputPreflight(payload, 16384);
 assert.equal(result.count, Buffer.byteLength(JSON.stringify(payload), "utf8") * 2 + 1024);
 assert.equal(result.method, "serialized-provider-payload-utf8-bytes-times-2-plus-1024/v1");
 assert.throws(() => conservativeTextInputPreflight({ text: "x".repeat(9000) }, 16384), /exceeds/);
 assert.throws(() => conservativeTextInputPreflight(undefined, 16384), /cannot be serialized/);
});
