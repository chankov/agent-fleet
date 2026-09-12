import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChangeSet } from "./lib/changes.ts";
import { ENVELOPE_EXAMPLES } from "./lib/envelopes.ts";
import type { PersonaDefinition } from "./lib/personas.ts";
import type { PermissionSnapshot } from "./lib/permissions.ts";
import { Run } from "./lib/run.ts";
import { documentWorkflow, type DocumentReport } from "./wf-document.ts";

const persona: PersonaDefinition = { name: "documenter", description: "docs", tools: "read,write,edit", writes: ["docs/", "**/*.md"], model: "stub/model", models: [], thinking: "low", systemPrompt: "", file: "agents/documenter.md" };

test("document follows changes to policy-bound documenter to one commit and traces HEAD~1 fallback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-document-"));
	try {
		const run = new Run({ cwd, runId: "document" }); let commits = 0, task = "";
		const baseline: PermissionSnapshot = { cwd, paths: new Map() };
		const changes: ChangeSet = { base: { ref: "main", diffBase: "HEAD~1", reason: "clean tree — falling back to the last commit (HEAD~1)", scenario: "fallback" }, changedFiles: ["src/x.ts"], untrackedFiles: [], diff: "diff --git x", hiddenLines: 0 };
		const result = await documentWorkflow(run, { args: [], dryRun: false, cwd }, {
			persona, baseline, capture: activeRun => { activeRun.trace.write("log", { phase: "changes", message: changes.base.reason }); return changes; },
			agent: async options => { task = options.task; assert.deepEqual(options.persona.writes, ["docs/", "**/*.md"]); return { ...ENVELOPE_EXAMPLES.document, commit_message: "docs: x" } as DocumentReport; },
			commit: () => { commits++; return "def"; },
		});
		assert.equal(result.exitCode, 0); assert.equal(commits, 1); assert.match(task, /HEAD~1/);
		assert.ok(run.trace.events().some(event => String(event.message).includes("HEAD~1")));
		assert.deepEqual(run.trace.events().filter(event => event.type === "phase_start").map(event => event.phase), ["changes", "document", "commit"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("document accepts already-accurate docs without attempting an empty commit", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-document-noop-"));
	try {
		const run = new Run({ cwd, runId: "document-noop" });
		const baseline: PermissionSnapshot = { cwd, paths: new Map() };
		const changes: ChangeSet = { base: { ref: "main", diffBase: "HEAD~1", reason: "clean tree — falling back to the last commit (HEAD~1)", scenario: "fallback" }, changedFiles: ["src/x.ts"], untrackedFiles: [], diff: "diff --git x", hiddenLines: 0 };
		let commits = 0;
		const result = await documentWorkflow(run, { args: [], dryRun: false, cwd }, {
			persona, baseline, capture: () => changes,
			agent: async () => ({ ...ENVELOPE_EXAMPLES.document, summary: "Documentation was already accurate" }) as DocumentReport,
			commit: () => { commits++; return null; },
		});
		assert.equal(result.exitCode, 0);
		assert.equal(commits, 1, "commit boundary is consulted once");
		assert.ok(run.trace.events().some(event => String(event.message).includes("no documentation changes to commit")));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
