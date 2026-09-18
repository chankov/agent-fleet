import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import {
	listT0aFixtures,
	T0A_FIXTURE_IDS,
	T0A_SYNTHETIC_FIXTURES,
	type T0aFixture,
} from "./fixtures/t0a-synthetic/catalog.ts";

const REQUIRED = [
	"id",
	"kind",
	"title",
	"followOnTask",
	"check",
	"initialState",
	"event",
	"observedBaseline",
	"expectedPostFix",
	"requiresUnimplementedSlice",
	"notes",
] as const;

function assertComplete(fixture: T0aFixture) {
	for (const field of REQUIRED) {
		const value = fixture[field];
		if (field === "requiresUnimplementedSlice") {
			assert.ok(value === null || value === "T4" || value === "T6" || value === "T9b", `${fixture.id}.${field}`);
			continue;
		}
		assert.equal(typeof value, "string", `${fixture.id}.${field} must be a non-empty string`);
		assert.ok(String(value).trim().length > 0, `${fixture.id}.${field} empty`);
	}
	assert.equal(fixture.kind, "synthetic");
	assert.notEqual(fixture.observedBaseline, fixture.expectedPostFix);
	assert.match(fixture.notes, /[Ss]ynthetic/);
	assert.doesNotMatch(fixture.notes, /\bcounts as a new (historical )?incident\b/i);
}

test("T0a catalog covers exactly the nine requested synthetic scenarios", () => {
	assert.deepEqual([...T0A_FIXTURE_IDS], [
		"narrowed-research-retry",
		"effective-model-change",
		"busy-agent",
		"pseudo-tool-call",
		"missing-deliverable",
		"mode-switch",
		"bg-en-verification",
		"unsupported-completion",
		"missing-worktree-installation",
	]);
	const listed = listT0aFixtures();
	assert.equal(listed.length, 9);
	for (const id of T0A_FIXTURE_IDS) {
		assert.equal(T0A_SYNTHETIC_FIXTURES[id].id, id);
		assertComplete(T0A_SYNTHETIC_FIXTURES[id]);
	}
});

test("T0a marks implemented T4 separately while T6/T9b remain contract-only", () => {
	assert.equal(T0A_SYNTHETIC_FIXTURES["mode-switch"].requiresUnimplementedSlice, null);
	assert.equal(T0A_SYNTHETIC_FIXTURES["busy-agent"].requiresUnimplementedSlice, "T6");
	assert.equal(T0A_SYNTHETIC_FIXTURES["missing-worktree-installation"].requiresUnimplementedSlice, "T9b");
	for (const id of T0A_FIXTURE_IDS) {
		if (T0A_SYNTHETIC_FIXTURES[id].requiresUnimplementedSlice) {
			assert.match(
				T0A_SYNTHETIC_FIXTURES[id].observedBaseline + T0A_SYNTHETIC_FIXTURES[id].notes,
				/not implement|not required|Contract-only/i,
			);
		}
	}
});

test("narrowed research retry remains a baseline-as-baseline record", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["narrowed-research-retry"];
	assert.match(fixture.observedBaseline, /ignores structured read-scope|not yet a first-class input/i);
	assert.match(fixture.expectedPostFix, /structured read scope/i);
	assert.notEqual(fixture.observedBaseline, fixture.expectedPostFix);
});

test("effective model gap remains a baseline-as-baseline record", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["effective-model-change"];
	assert.match(fixture.observedBaseline, /omits model/i);
	assert.match(fixture.expectedPostFix, /effective model/i);
	assert.notEqual(fixture.observedBaseline, fixture.expectedPostFix);
});

test("busy-agent baseline remains recorded separately from its post-fix contract", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["busy-agent"];
	assert.match(fixture.observedBaseline, /not a structured busy category/i);
	assert.match(fixture.expectedPostFix, /structured busy|busy refusal/i);
	assert.match(fixture.expectedPostFix, /no automatic retry or waiting/i);
	assert.notEqual(fixture.observedBaseline, fixture.expectedPostFix);
});

test("pseudo-tool fixture is synthetic and does not execute XML", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["pseudo-tool-call"];
	const pseudo = "<tool_call><function=write>docs/out.md</function></tool_call>";
	assert.match(fixture.initialState, /No tool event/);
	assert.match(fixture.expectedPostFix, /Never auto-execute/);
	assert.equal(pseudo.includes("write"), true);
	assert.match(fixture.observedBaseline, /do not currently classify/);
});

test("missing deliverable is not acceptance", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["missing-deliverable"];
	const baselineSaysNotFullAcceptance = /not a full T2|deliverable_failed|needs_verification/i.test(fixture.observedBaseline);
	assert.equal(baselineSaysNotFullAcceptance, true);
	assert.match(fixture.expectedPostFix, /not acceptance/);
});

test("mode-switch baseline now maps to the implemented T4 contract", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["mode-switch"];
	assert.equal(fixture.requiresUnimplementedSlice, null);
	assert.match(fixture.expectedPostFix, /tool-state delta/);
	assert.match(fixture.check, /implemented T4 contract/);
	assert.match(fixture.observedBaseline, /now emits|implemented/i);
	assert.doesNotMatch(fixture.observedBaseline, /There is no runtime tool-state delta|does not implement T4/i);
});

test("BG and EN fixtures share one contract id pair", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["bg-en-verification"];
	assert.match(fixture.initialState, /English/);
	assert.match(fixture.initialState, /Bulgarian|българ/i);
	assert.match(fixture.expectedPostFix, /operation kind and task contract/);
});

test("unsupported completion remains unverified", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["unsupported-completion"];
	assert.match(fixture.observedBaseline, /null evidence|evidence-less/);
	assert.match(fixture.expectedPostFix, /unverified, never success|never success/);
});

test("missing-install fixture is environment failure, not model failure", () => {
	const fixture = T0A_SYNTHETIC_FIXTURES["missing-worktree-installation"];
	assert.equal(fixture.requiresUnimplementedSlice, "T9b");
	assert.match(fixture.expectedPostFix, /environment/);
	assert.match(fixture.observedBaseline, /not be scored as model/i);
});

test("fixture-to-task-to-check mapping is complete and non-inflating", () => {
	const tasks = new Set(listT0aFixtures().map((f) => f.followOnTask));
	assert.ok([...tasks].some((t) => t.startsWith("T1")));
	assert.ok([...tasks].some((t) => t.startsWith("T2")));
	assert.ok([...tasks].some((t) => t.startsWith("T3")));
	assert.ok([...tasks].some((t) => t.startsWith("T7")));
	for (const fixture of listT0aFixtures()) {
		assert.match(fixture.check, /t0a-synthetic-fixtures\.test\.ts/);
		assert.equal(fixture.kind, "synthetic");
	}
});

 test("every fixture maps to an actually registered check, not only a test filename", () => {
 const source = readFileSync(new URL("./t0a-synthetic-fixtures.test.ts", import.meta.url), "utf8");
 const registered = new Set([...source.matchAll(/test\("([^"\n]+)"/g)].map(match => match[1]));
 for (const fixture of listT0aFixtures()) assert.ok(registered.has(fixture.check.split(" / ")[1]), fixture.check);
 });
