import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import scoutDataBoundary, { SCOUT_DATA_ROOT_ENV, validateScoutDataPath } from "./scout-data-boundary.ts";

test("T13 scout filesystem DATA reads are limited to snapshot paths and deny traversal/symlinks", () => {
	const holder = mkdtempSync(join(tmpdir(), "af-scout-data-")), snapshot = join(holder, "snapshot"), original = join(holder, "original");
	try {
		mkdirSync(snapshot); mkdirSync(original); writeFileSync(join(snapshot, "ok.txt"), "ok"); writeFileSync(join(original, ".env"), "secret"); symlinkSync(join(original, ".env"), join(snapshot, "escape"));
		assert.equal(validateScoutDataPath(snapshot, snapshot, "ok.txt"), null);
		assert.match(validateScoutDataPath(snapshot, snapshot, join(original, ".env"))!, /limited/);
		assert.match(validateScoutDataPath(snapshot, snapshot, "../original/.env")!, /traversal/);
		assert.match(validateScoutDataPath(snapshot, snapshot, "escape")!, /symlink/);
	} finally { rmSync(holder, { recursive: true, force: true }); }
});

test("T13 scout boundary covers exactly read grep find ls while damage-control remains a separate extension", () => {
	const root = mkdtempSync(join(tmpdir(), "af-scout-data-")); const handlers: any[] = [];
	const previous = process.env[SCOUT_DATA_ROOT_ENV]; process.env[SCOUT_DATA_ROOT_ENV] = root;
	try {
		scoutDataBoundary({ on(name: string, handler: any) { if (name === "tool_call") handlers.push(handler); } } as any);
		assert.equal(handlers.length, 1);
		for (const toolName of ["read", "grep", "find", "ls"]) assert.equal(handlers[0]({ toolName, input: { path: "." } }, { cwd: root }).block, false);
		assert.equal(handlers[0]({ toolName: "read", input: { path: "/etc/passwd" } }, { cwd: root }).block, true);
		assert.equal(handlers[0]({ toolName: "grep", input: { path: ".", glob: "../*.env" } }, { cwd: root }).block, true);
		assert.equal(handlers[0]({ toolName: "write", input: { path: "x" } }, { cwd: root }), undefined);
	} finally { if (previous === undefined) delete process.env[SCOUT_DATA_ROOT_ENV]; else process.env[SCOUT_DATA_ROOT_ENV] = previous; rmSync(root, { recursive: true, force: true }); }
});
