import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_KIND, briefFileName, extractOperatorNotes, NOTES_MARKER, refreshTaskBrief, renderTaskBrief, type BriefInput } from "./task-brief.ts";

const input = (overrides: Partial<BriefInput> = {}): BriefInput => ({
	taskId: "task-1", tier: "feature", risk: "high", scope: "wide",
	requirements: [{ id: "A1", status: "open", text: "Parser keeps comments", source: "PLAN.md#parser" }],
	delegations: [{ agent: "builder", kind: "specialist", status: "running", task: "Implement the parser change", scope: ["src/parser.ts"] }],
	...overrides,
});

test("brief renders task state, requirements with sources, delegations with scope, and a notes marker", () => {
	const text = renderTaskBrief(input());
	assert.match(text, /^# Task brief — task-1/);
	assert.match(text, /tier: feature; risk: high; scope: wide/);
	assert.match(text, /- A1 \[open\] Parser keeps comments \(source: PLAN\.md#parser\)/);
	assert.match(text, /- builder \(specialist, running\) scope: src\/parser\.ts — Implement the parser change/);
	assert.match(text, /Only the operator edits this file/);
	assert.ok(text.includes(NOTES_MARKER));
	assert.equal(extractOperatorNotes(text), null, "the placeholder is not a note");
});

test("long requirement and task text is clipped so the brief stays small", () => {
	const text = renderTaskBrief(input({ requirements: [{ id: "A1", status: "open", text: "x".repeat(5000) }] }));
	assert.ok(text.length < 2000);
	assert.match(text, /x…/);
});

test("refresh preserves operator notes, writes atomically and removes earlier tasks' briefs", t => {
	const root = mkdtempSync(join(tmpdir(), "af-brief-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const first = refreshTaskBrief(root, input());
	assert.equal(first, join(root, BRIEF_KIND, briefFileName("task-1")));
	writeFileSync(first, readFileSync(first, "utf-8").replace(/_\(none yet[^\n]*\n/, "Decision: keep the facade.\n"));
	refreshTaskBrief(root, input({ tier: "project" }));
	const refreshed = readFileSync(first, "utf-8");
	assert.match(refreshed, /tier: project/);
	assert.equal(extractOperatorNotes(refreshed), "Decision: keep the facade.");

	const next = refreshTaskBrief(root, input({ taskId: "task-2" }));
	assert.equal(existsSync(first), false, "a new task's brief replaces the previous task's");
	assert.deepEqual(readdirSync(join(root, BRIEF_KIND)), [briefFileName("task-2")]);
	assert.equal(extractOperatorNotes(readFileSync(next, "utf-8")), null, "notes do not leak into a new task");
});

test("brief file names are filesystem-safe", () => {
	assert.equal(briefFileName("a/b c"), "task-a-b-c.md");
	assert.equal(briefFileName(""), "task-task.md");
});
