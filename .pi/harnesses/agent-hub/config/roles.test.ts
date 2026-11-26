import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRACTICE_IDS, PRACTICES, resolveSkill } from "./practices.ts";
import {
	applyRoleCeiling,
	assignmentLabel,
	assignmentSkillPaths,
	formatAssignmentBlock,
	RETIRED_PERSONAS,
	resolveAssignment,
	retiredPersonaDiagnostic,
	roleOf,
	ROLE_NAMES,
	selectRoleDefinitions,
} from "./roles.ts";
import { loadAgentConfiguration, scanAgentDirs } from "./agents.ts";
import type { AgentDef } from "../types.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function def(name: string, extra: Partial<AgentDef> = {}): AgentDef {
	return { name, description: "", tools: "read,grep,find,ls", systemPrompt: "", file: `/x/${name}.md`, ...extra } as AgentDef;
}

function fixture(): { root: string; put(path: string, text: string): void; done(): void } {
	const root = mkdtempSync(join(tmpdir(), "fleet-roles-"));
	return {
		root,
		put(path, text) { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); },
		done() { rmSync(root, { recursive: true, force: true }); },
	};
}

test("the catalog has eleven practices and every skill resolves native-first in this repository", () => {
	assert.equal(PRACTICE_IDS.length, 11);
	for (const id of PRACTICE_IDS) {
		const practice = PRACTICES[id];
		assert.equal(practice.id, id);
		assert.ok(practice.skills.length > 0, `${id} names skills`);
		assert.ok(practice.roles.length > 0, `${id} names roles`);
		for (const skill of practice.skills) {
			const found = resolveSkill(skill, [repoRoot]);
			assert.ok(found.path, `${id}: ${skill} resolves`);
			const native = resolve(repoRoot, "skills", skill, "SKILL.md");
			const vendored = resolve(repoRoot, "vendor/agent-skills-upstream/skills", skill, "SKILL.md");
			assert.ok(found.path === native || found.path === vendored, `${skill} resolves from skills/ or vendor/`);
			if (found.path === vendored) assert.equal(existsSync(native), false, `${skill}: a native copy would win`);
		}
	}
	// A native copy shadows its vendored twin.
	assert.equal(resolveSkill("incremental-implementation", [repoRoot]).path, resolve(repoRoot, "skills/incremental-implementation/SKILL.md"));
	assert.equal(resolveSkill("test-driven-development", [repoRoot]).path, resolve(repoRoot, "vendor/agent-skills-upstream/skills/test-driven-development/SKILL.md"));
});

test("skill lookup order is workspace skills/, then installed .pi/skills/, then the vendored copy", () => {
	const fx = fixture();
	try {
		fx.put("vendor/agent-skills-upstream/skills/alpha/SKILL.md", "vendor");
		assert.match(resolveSkill("alpha", [fx.root]).path ?? "", /vendor\/agent-skills-upstream\/skills\/alpha\/SKILL\.md$/);
		fx.put(".pi/skills/alpha/SKILL.md", "installed");
		assert.match(resolveSkill("alpha", [fx.root]).path ?? "", /\.pi\/skills\/alpha\/SKILL\.md$/);
		fx.put("skills/alpha/SKILL.md", "native");
		assert.equal(resolveSkill("alpha", [fx.root]).path, join(fx.root, "skills/alpha/SKILL.md"));
		assert.equal(resolveSkill("missing", [fx.root]).path, null);
	} finally { fx.done(); }
});

test("a single practice resolves to its role, skills and expected result", () => {
	const resolved = resolveAssignment({ agent: "Reviewer", practices: ["independent-review"] }, [repoRoot]);
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.role, "reviewer");
	assert.equal(resolved.defaulted, false);
	assert.deepEqual(resolved.practices.map(entry => entry.practice.id), ["independent-review"]);
	assert.deepEqual(resolved.missingSkills, []);
	assert.deepEqual(assignmentSkillPaths(resolved), [
		resolve(repoRoot, "skills/code-review-and-quality/SKILL.md"),
		resolve(repoRoot, "skills/orchestration-verification/SKILL.md"),
	]);
	assert.deepEqual(resolved.expectedResult, [PRACTICES["independent-review"].result]);
});

test("a combined assignment keeps practice order, deduplicates and labels a parallel instance by its role", () => {
	const resolved = resolveAssignment({ agent: "editor--p2", practices: ["planning", "Implementation", "testing", "planning"] }, [repoRoot]);
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.role, "editor");
	assert.equal(assignmentLabel(resolved), "editor--p2[planning,implementation,testing]");
	const block = formatAssignmentBlock(resolved);
	assert.match(block, /^## Assignment\nRole: editor/);
	assert.match(block, /Practices: Planning, Implementation, Testing\./);
	assert.match(block, /PLAN_FILE: <repo-relative path>/, "planning keeps the plan return convention");
	assert.match(block, /Read before starting: .*planning-and-task-breakdown\/SKILL\.md/);
	assert.match(block, /never adds authority/);
});

test("an empty practice list takes the role default and says so", () => {
	for (const [agent, practice] of [["researcher", "research"], ["reviewer", "independent-review"], ["editor", "implementation"]] as const) {
		const resolved = resolveAssignment({ agent }, [repoRoot]);
		assert.equal(resolved.ok, true);
		if (!resolved.ok) continue;
		assert.equal(resolved.defaulted, true);
		assert.deepEqual(resolved.practices.map(entry => entry.practice.id), [practice]);
		assert.match(formatAssignmentBlock(resolved), /\(role default\)/);
	}
});

test("unknown roles, unknown practices and practices outside a role are refused with actionable diagnostics", () => {
	const unknownRole = resolveAssignment({ agent: "auditor", practices: ["security"] }, [repoRoot]);
	assert.deepEqual([unknownRole.ok, !unknownRole.ok && unknownRole.reason], [false, "unknown_role"]);
	assert.match(!unknownRole.ok ? unknownRole.message : "", /Dispatch one of: researcher, reviewer, editor/);
	const unknownPractice = resolveAssignment({ agent: "editor", practices: ["implementation", "vibes"] }, [repoRoot]);
	assert.deepEqual([unknownPractice.ok, !unknownPractice.ok && unknownPractice.reason], [false, "unknown_practice"]);
	assert.match(!unknownPractice.ok ? unknownPractice.message : "", /Unknown practice "vibes"\. Known practices: research, architecture/);
	const incompatible = resolveAssignment({ agent: "researcher", practices: ["implementation"] }, [repoRoot]);
	assert.deepEqual([incompatible.ok, !incompatible.ok && incompatible.reason], [false, "incompatible_practice"]);
	assert.match(!incompatible.ok ? incompatible.message : "", /"implementation" needs editor/);
	const editorReview = resolveAssignment({ agent: "editor", practices: ["independent-review"] }, [repoRoot]);
	assert.match(!editorReview.ok ? editorReview.message : "", /"independent-review" needs reviewer/);
});

test("every retired persona is refused with its role and practice mapping", () => {
	assert.deepEqual(Object.keys(RETIRED_PERSONAS).sort(), [
		"architect", "bowser", "builder", "code-reviewer", "deep-researcher", "documenter", "plan-reviewer",
		"planner", "releaser", "security-auditor", "test-engineer", "web-debugger", "web-performance-auditor",
	]);
	for (const [name, assignments] of Object.entries(RETIRED_PERSONAS)) {
		const refused = resolveAssignment({ agent: name }, [repoRoot]);
		assert.equal(refused.ok, false, name);
		if (refused.ok) continue;
		assert.equal(refused.reason, "retired_persona");
		for (const entry of assignments) {
			assert.ok(refused.message.includes(`agent "${entry.role}"`), `${name} names ${entry.role}`);
			// Every mapped assignment must itself resolve.
			assert.equal(resolveAssignment({ agent: entry.role, practices: entry.practices }, [repoRoot]).ok, true, `${name} → ${entry.role}`);
		}
	}
	assert.match(retiredPersonaDiagnostic("builder--p3") ?? "", /"builder" is a retired persona.*agent "editor" with practices \["implementation"\]/);
	assert.match(retiredPersonaDiagnostic("planner") ?? "", /agent "editor" .*"planning".* a saved plan; or agent "researcher" .*"planning".* advice/);
	assert.equal(retiredPersonaDiagnostic("researcher"), null, "researcher is a role, not retired");
	assert.equal(roleOf("reviewer--p4"), "reviewer");
	assert.equal(roleOf("code-reviewer"), null);
});

test("the role ceiling replaces declared authority while prompt and model survive", () => {
	const reviewer = applyRoleCeiling(def("reviewer", { tools: "read,write,edit,bash,grep", toolsExplicit: true, model: "a/b", systemPrompt: "custom" }));
	assert.equal(reviewer.tools, "read,bash,grep");
	assert.equal(reviewer.readOnly, true);
	assert.equal(reviewer.model, "a/b");
	assert.equal(reviewer.systemPrompt, "custom");
	const researcher = applyRoleCeiling(def("researcher", { tools: "read,bash,write", toolsExplicit: true, kind: "orchestrator" }));
	assert.equal(researcher.tools, "read");
	assert.equal(researcher.readOnly, true);
	assert.equal(researcher.kind, "research");
	const narrowed = applyRoleCeiling(def("researcher", { tools: "write", toolsExplicit: true }));
	assert.equal(narrowed.tools, "read,grep,find,ls", "an empty intersection falls back to the role default, never to nothing");
	const editor = applyRoleCeiling(def("editor", { readOnly: true, kind: "research" }));
	assert.equal(editor.tools, "read,write,edit,bash,grep,find,ls", "an implicit tool list takes the role default");
	assert.equal(editor.readOnly, undefined);
	assert.equal(editor.kind, undefined);
});

test("only the first role definition per name is kept; every other definition is reported", () => {
	const selection = selectRoleDefinitions([
		def("editor", { file: "/w/agents/editor.md", systemPrompt: "user" }),
		def("builder", { file: "/w/agents/builder.md" }),
		def("editor", { file: "/w/.pi/agents/personas/editor.md", systemPrompt: "installed" }),
		def("my-auditor", { file: "/w/agents/my-auditor.md" }),
		def("Reviewer", { file: "/w/.pi/agents/personas/reviewer.md" }),
	]);
	assert.deepEqual(selection.roles.map(role => [role.name, role.file]), [["editor", "/w/agents/editor.md"], ["reviewer", "/w/.pi/agents/personas/reviewer.md"]]);
	assert.deepEqual(selection.missing, ["researcher"]);
	assert.deepEqual(selection.ignored.map(entry => entry.name), ["builder", "editor", "my-auditor"]);
	assert.match(selection.ignored[0].reason, /retired persona/);
	assert.match(selection.ignored[2].reason, /only the roles researcher, reviewer, editor are dispatched/);
});

test("the configuration loader hands the Hub the three roles under their ceilings and reports the rest", () => {
	const fx = fixture();
	try {
		fx.put("agents/editor.md", "---\nname: editor\ndescription: user editor\nmodel: user/model\n---\nUser editor prompt.\n");
		fx.put(".pi/agents/personas/editor.md", "---\nname: editor\ndescription: installed\ntools: read,write,edit,bash,grep,find,ls\n---\nInstalled.\n");
		fx.put(".pi/agents/personas/reviewer.md", "---\nname: reviewer\ndescription: r\ntools: read,write,bash,grep,find,ls\n---\nReview.\n");
		fx.put(".pi/agents/personas/researcher.md", "---\nname: researcher\ndescription: r\ntools: read,grep,find,ls,bash\n---\nResearch.\n");
		fx.put(".pi/agents/personas/builder.md", "---\nname: builder\ndescription: old\ntools: read,write\n---\nOld.\n");
		const got: any = {};
		loadAgentConfiguration(fx.root, {
			setSessionDir(value) { got.session = value; }, getSessionDir() { return got.session; }, archivePreviousRun() {}, ensureArtifactsLayout() {}, resetAssertions() {},
			setAgentDefs(value) { got.defs = value; }, setTeams(value) { got.teams = value; }, setModelProfiles() {}, setDispatchPolicy() {}, setDispatchPolicyWarnings() {},
			setIgnoredDefinitions(ignored, missing) { got.ignored = ignored; got.missing = missing; },
		});
		const byName = Object.fromEntries(got.defs.map((entry: AgentDef) => [entry.name, entry]));
		assert.deepEqual(Object.keys(byName).sort(), [...ROLE_NAMES].sort());
		assert.equal(byName.editor.systemPrompt, "User editor prompt.", "the user's same-name file replaces the prompt");
		assert.equal(byName.editor.model, "user/model");
		assert.equal(byName.editor.tools, "read,write,edit,bash,grep,find,ls");
		assert.equal(byName.reviewer.tools, "read,bash,grep,find,ls");
		assert.equal(byName.reviewer.readOnly, true);
		assert.equal(byName.researcher.tools, "read,grep,find,ls");
		assert.equal(byName.researcher.kind, "research");
		assert.deepEqual(got.missing, []);
		// The shadowed installed editor never reaches selection: the scan keeps the first file per name.
		assert.deepEqual(got.ignored.map((entry: any) => entry.name), ["builder"]);
		assert.deepEqual([...got.teams.all].sort(), ["editor", "researcher", "reviewer"]);
		// The raw scan still sees every file; only the Hub's dispatchable set is narrowed.
		assert.ok(scanAgentDirs(fx.root).some(entry => entry.name === "builder"));
	} finally { fx.done(); }
});
