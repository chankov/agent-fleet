import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	artifactPreviewFromText,
	formatInputArtifactsSection,
	resolveArtifactPath,
	resolveArtifactPaths,
} from "./artifacts.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agent-hub-artifacts-"));
	const repoDir = join(root, "repo");
	const sessionDir = join(repoDir, ".pi", "agent-sessions");
	const artifactRoot = join(sessionDir, "artifacts");
	mkdirSync(join(artifactRoot, "plans"), { recursive: true });
	mkdirSync(join(repoDir, "docs"), { recursive: true });
	writeFileSync(join(artifactRoot, "plans", "plan.md"), "# Plan Title\n\nSecret body that must not be injected.\n", "utf-8");
	writeFileSync(join(repoDir, "docs", "note.md"), "One-line repo note\nSecond line body\n", "utf-8");
	return { repoDir, sessionDir, artifactRoot };
}

test("resolveArtifactPath accepts artifact-root relative paths", () => {
	const fx = fixture();
	const resolved = resolveArtifactPath("plans/plan.md", { ...fx, exists: existsSync });

	assert.equal(resolved.path, join(fx.artifactRoot, "plans", "plan.md"));
	assert.equal(resolved.displayPath, "artifacts/plans/plan.md");
});

test("resolveArtifactPath accepts repo-relative paths", () => {
	const fx = fixture();
	const resolved = resolveArtifactPath("docs/note.md", { ...fx, exists: existsSync });

	assert.equal(resolved.path, join(fx.repoDir, "docs", "note.md"));
	assert.equal(resolved.displayPath, "docs/note.md");
});

test("resolveArtifactPath rejects paths outside repo/session roots", () => {
	const fx = fixture();
	assert.throws(
		() => resolveArtifactPath("../../etc/passwd", { ...fx, exists: existsSync }),
		/Refusing artifact path outside repo\/session/,
	);
	assert.throws(
		() => resolveArtifactPath("/etc/passwd", { ...fx, exists: existsSync }),
		/Refusing artifact path outside repo\/session/,
	);
});

test("resolveArtifactPaths handles explicit artifacts/ session-relative paths", () => {
	const fx = fixture();
	const [resolved] = resolveArtifactPaths(["artifacts/plans/plan.md"], { ...fx, exists: existsSync });

	assert.equal(resolved.path, join(fx.artifactRoot, "plans", "plan.md"));
	assert.equal(resolved.displayPath, "artifacts/plans/plan.md");
});

test("absolute session artifact paths display as artifact-relative handoff paths", () => {
	const fx = fixture();
	const resolved = resolveArtifactPath(join(fx.artifactRoot, "plans", "plan.md"), { ...fx, exists: existsSync });

	assert.equal(resolved.path, join(fx.artifactRoot, "plans", "plan.md"));
	assert.equal(resolved.displayPath, "artifacts/plans/plan.md");
});

test("repo-root artifacts directory does not satisfy a session artifact handoff", () => {
	const fx = fixture();
	mkdirSync(join(fx.repoDir, "artifacts", "plans"), { recursive: true });
	writeFileSync(join(fx.repoDir, "artifacts", "plans", "repo-only.md"), "# Wrong Plan\n", "utf-8");
	const resolved = resolveArtifactPath("./artifacts/plans/repo-only.md", { ...fx, exists: existsSync });

	assert.equal(resolved.path, join(fx.artifactRoot, "plans", "repo-only.md"));
	assert.equal(resolved.displayPath, "artifacts/plans/repo-only.md");
});

test("artifact previews expose only heading or first line", () => {
	assert.equal(artifactPreviewFromText("# Plan Title\n\nSecret body"), "Plan Title");
	assert.equal(artifactPreviewFromText("First line\nSecond line body"), "First line");
});

test("input artifact section injects path plus one-line preview, not file bodies", () => {
	const section = formatInputArtifactsSection([
		{ displayPath: "artifacts/plans/plan.md", preview: "Plan Title" },
	]);

	assert.match(section, /artifacts\/plans\/plan\.md — Plan Title/);
	assert.doesNotMatch(section, /Secret body/);
	assert.match(section, /file bodies are intentionally not inlined/);
});

test("dispatch_agent and spawn_research tool schemas expose optional artifacts", () => {
	const index = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
	assert.match(index, /name: "dispatch_agent"[\s\S]*artifacts: Type\.Optional\(Type\.Array\(Type\.String/);
	assert.match(index, /name: "spawn_research"[\s\S]*artifacts: Type\.Optional\(Type\.Array\(Type\.String/);
});

test("handoff appendix is guarded by a matching handoff token", () => {
	const index = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
	assert.match(index, /handoff_token: Type\.Optional/);
	assert.match(index, /pendingHandoff\.target === target\.name[\s\S]*params\.handoff_token === pendingHandoff\.token/);
	assert.match(index, /if \(handoffAppendAuthorized\) pendingHandoff = null/);
	assert.match(index, /## Verification ledger \(verbatim, machine-appended\)/);
	assert.match(index, /## Artifact index/);
});
