import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChangeSet } from "./lib/changes.ts";
import { ENVELOPE_EXAMPLES } from "./lib/envelopes.ts";
import { resolveRole, type PersonaDefinition } from "./lib/personas.ts";
import type { PermissionSnapshot } from "./lib/permissions.ts";
import { Run } from "./lib/run.ts";
import { DOCUMENT_ASSIGNMENT, DOCUMENT_PERMISSION_POLICY, documentWorkflow, type DocumentReport } from "./wf-document.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const persona: PersonaDefinition & { assignment: string } = { name: "editor", description: "edit", tools: "read,write,edit,grep,find,ls", model: "stub/model", models: [], thinking: "low", systemPrompt: "", file: "agents/editor.md", assignment: "## Assignment\nRole: editor" };

test("the document phase is an editor with the documentation practice, without a shell and with its practice model", () => {
	const editor = resolveRole(DOCUMENT_ASSIGNMENT.role, DOCUMENT_ASSIGNMENT.practices, REPO, { tools: DOCUMENT_ASSIGNMENT.tools });
	assert.deepEqual(editor.practices, ["documentation"]);
	assert.deepEqual(editor.tools.split(","), ["read", "write", "edit", "grep", "find", "ls"], "the flow narrows the editor ceiling; bash is gone");
	assert.equal(editor.modelSource, "practice:documentation:role-file");
	assert.equal(editor.thinking, "minimal", "the documentation practice model of the role file (D9)");
	assert.equal(editor.writes, undefined, "the role file declares no write policy; the flow owns it");
	assert.deepEqual(resolveRole("editor", ["documentation"], REPO, { tools: "read,write,publish" }).tools, "read,write", "a flow can narrow the ceiling, never widen it");
});

test("the document phase records its role, practices and model source in the trace", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-document-trace-"));
	try {
		const run = new Run({ cwd, runId: "document-trace" });
		const editor = resolveRole(DOCUMENT_ASSIGNMENT.role, DOCUMENT_ASSIGNMENT.practices, REPO, { tools: DOCUMENT_ASSIGNMENT.tools });
		await documentWorkflow(run, { args: [], dryRun: true, cwd }, { persona: editor, baseline: { cwd, paths: new Map() } });
		const entry = run.trace.events().find(event => String(event.message).startsWith("assignment editor[documentation]"));
		assert.ok(entry, "the assignment is traced");
		assert.equal((entry as any).modelSource, "practice:documentation:role-file");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("document follows changes to a policy-bound editor to one commit and traces HEAD~1 fallback", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "wf-document-"));
	try {
		const run = new Run({ cwd, runId: "document" }); let commits = 0, task = ""; let committedPolicy: unknown;
		const baseline: PermissionSnapshot = { cwd, paths: new Map() };
		const changes: ChangeSet = { base: { ref: "main", diffBase: "HEAD~1", reason: "clean tree — falling back to the last commit (HEAD~1)", scenario: "fallback" }, changedFiles: ["src/x.ts"], untrackedFiles: [], diff: "diff --git x", hiddenLines: 0 };
		const result = await documentWorkflow(run, { args: [], dryRun: false, cwd }, {
			persona, baseline, capture: activeRun => { activeRun.trace.write("log", { phase: "changes", message: changes.base.reason }); return changes; },
			agent: async options => { task = options.task; assert.deepEqual(options.permissionPolicy, { writes: ["docs/", "**/*.md"] }); return { ...ENVELOPE_EXAMPLES.document, commit_message: "docs: x" } as DocumentReport; },
			commit: (_message, _cwd, _baseline, policy) => { commits++; committedPolicy = policy; return "def"; },
		});
		assert.equal(result.exitCode, 0); assert.equal(commits, 1); assert.match(task, /HEAD~1/);
		assert.match(task, /\n\n## Assignment\nRole: editor$/);
		assert.deepEqual(committedPolicy, DOCUMENT_PERMISSION_POLICY, "the commit boundary is the flow's documentation policy");
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
