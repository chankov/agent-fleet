import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
	ARTIFACT_KINDS,
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

test("resolveArtifactPath falls back across artifact kinds for a unique name", () => {
	const fx = fixture();
	mkdirSync(join(fx.artifactRoot, "returns"), { recursive: true });
	writeFileSync(join(fx.artifactRoot, "returns", "code-reviewer-run1.md"), "# Review\n", "utf-8");

	// The real miss: the hub writes auto-returns to returns/, the dispatcher asks
	// for reviews/ because the protocol says documents live under artifacts/<kind>/.
	const resolved = resolveArtifactPath("reviews/code-reviewer-run1.md", { ...fx, exists: existsSync });
	assert.equal(resolved.path, join(fx.artifactRoot, "returns", "code-reviewer-run1.md"));
	assert.equal(resolved.displayPath, "artifacts/returns/code-reviewer-run1.md");
	assert.equal(resolved.resolvedFromKind, "returns");

	// Same via the explicit artifacts/ prefix.
	const prefixed = resolveArtifactPath("artifacts/reviews/code-reviewer-run1.md", { ...fx, exists: existsSync });
	assert.equal(prefixed.resolvedFromKind, "returns");
});

test("failures is an addressable artifact kind, separate from returns", () => {
	// A delivery failure is not a specialist result: a 142-byte coms error stub
	// stored as returns/code-reviewer-run4.md cost a full dispatch investigating
	// a review that had actually succeeded.
	assert.ok(ARTIFACT_KINDS.includes("failures"));
	assert.ok(ARTIFACT_KINDS.includes("returns"));

	const fx = fixture();
	mkdirSync(join(fx.artifactRoot, "failures"), { recursive: true });
	writeFileSync(join(fx.artifactRoot, "failures", "code-reviewer-run4.md"), "coms error: no reply\n", "utf-8");

	const direct = resolveArtifactPath("failures/code-reviewer-run4.md", { ...fx, exists: existsSync });
	assert.equal(direct.path, join(fx.artifactRoot, "failures", "code-reviewer-run4.md"));
	assert.equal(direct.displayPath, "artifacts/failures/code-reviewer-run4.md");
	assert.equal(direct.resolvedFromKind, null);

	// Asking for the return finds the failure and SAYS it came from failures/,
	// so the caller learns the run never delivered instead of reading a stub as
	// a result.
	const crossed = resolveArtifactPath("returns/code-reviewer-run4.md", { ...fx, exists: existsSync });
	assert.equal(crossed.path, join(fx.artifactRoot, "failures", "code-reviewer-run4.md"));
	assert.equal(crossed.resolvedFromKind, "failures");
});

test("resolveArtifactPath prefers the requested kind when it exists", () => {
	const fx = fixture();
	const resolved = resolveArtifactPath("plans/plan.md", { ...fx, exists: existsSync });
	assert.equal(resolved.path, join(fx.artifactRoot, "plans", "plan.md"));
	assert.equal(resolved.resolvedFromKind, null);
});

test("resolveArtifactPath refuses to guess between two kinds", () => {
	const fx = fixture();
	for (const kind of ["returns", "evidence"]) {
		mkdirSync(join(fx.artifactRoot, kind), { recursive: true });
		writeFileSync(join(fx.artifactRoot, kind, "dup.md"), `# ${kind}\n`, "utf-8");
	}
	assert.throws(
		() => resolveArtifactPath("reviews/dup.md", { ...fx, exists: existsSync }),
		/Ambiguous artifact reviews\/dup\.md/,
	);
});

test("resolveArtifactPath leaves a genuinely missing artifact unresolved", () => {
	const fx = fixture();
	const resolved = resolveArtifactPath("reviews/absent.md", { ...fx, exists: existsSync });
	assert.equal(resolved.resolvedFromKind, null);
	assert.equal(existsSync(resolved.path), false);
});

test("resolveArtifactPath never cross-kinds an absolute path", () => {
	const fx = fixture();
	mkdirSync(join(fx.artifactRoot, "returns"), { recursive: true });
	writeFileSync(join(fx.artifactRoot, "returns", "abs.md"), "# r\n", "utf-8");
	const resolved = resolveArtifactPath(join(fx.artifactRoot, "reviews", "abs.md"), { ...fx, exists: existsSync });
	assert.equal(resolved.resolvedFromKind, null);
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
