import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { canonicalMkdtempSync } from "../../../../bin/test/helpers/test-temp.js";
import { resolveSessionRoots, sessionGitEnv, withSessionRoots } from "../../lib/workspace-context.ts";
import type { SpawnAgent } from "../../../agent-fleet/scripts/workflows/lib/agent-phase.ts";
import { ENVELOPE_EXAMPLES } from "../../../agent-fleet/scripts/workflows/lib/envelopes.ts";
import { AF_DEBATE_FAILED_MESSAGE, AF_DEBATE_MESSAGE, presentAfDebateCommand, runAfDebate, type AfDebateHandleInput, type AfDebateMessage } from "../debate-command.ts";
import { renderDebateBlock, type DebateBlock } from "../debate-progress.ts";
import { hubDebateWorkflowPorts } from "../debate-runtime.ts";
import { DEBATE_PANEL_DESCRIPTION, DEBATE_PANEL_ROUNDS, DEBATE_PANEL_SELECT, executeDebatePanel, type DebatePanelDeps } from "./debate-panel-core.ts";
import { FLEET_TOOLS, OPERATOR_DELEGATION_GUIDE } from "../work-mode.ts";

type Update = { content: { type: "text"; text: string }[]; details: { status: string; debate: DebateBlock } };

function registered(deps: DebatePanelDeps) {
	return { execute: (_id: string, params: any, _signal: unknown, onUpdate: any, ctx: any) => executeDebatePanel(deps, params, onUpdate, ctx) };
}

/** The tool as the Hub wires it: the shared runner with the tool's hints. */
function toolOver(input: AfDebateHandleInput) {
	return registered({ blocked: () => null, run: (params, _ctx, onProgress) => runAfDebate({ ...params, ...input, selectHint: DEBATE_PANEL_SELECT, roundsHint: DEBATE_PANEL_ROUNDS, onProgress }) });
}

test("debate_panel is a fleet tool for decisions, read-only and without a judge; the operator guide names when to use it", () => {
	assert.ok((FLEET_TOOLS as readonly string[]).includes("debate_panel"));
	assert.match(DEBATE_PANEL_DESCRIPTION, /2–5 rounds/);
	assert.match(DEBATE_PANEL_DESCRIPTION, /Read-only; no judge/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /`debate_panel` when a known objection could change it or a poll disagrees/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /Never poll or debate facts/);
});

test("debate_panel refuses before any work when blocked", async () => {
	let ran = false;
	const refused = await registered({ blocked: () => "declined", run: async () => { ran = true; return { ok: true, message: "" }; } })
		.execute("id", { question: "q" }, undefined, undefined, {});
	assert.equal(refused.details.status, "refused");
	assert.equal(refused.details.started, false);
	assert.equal(refused.details.debate.failure, "declined");
	assert.equal(ran, false);
});

// ---------------------------------------------------------------------------
// Rounds against temporary Git repositories with stub voices, both entry points.
// ---------------------------------------------------------------------------

const VOICES_YAML = "default:\n  - { name: sol, model: a/sol }\n  - { name: grok, model: b/grok }\n  - { name: opus, model: c/opus }\ncheap:\n  - { name: sol, model: a/sol }\n  - { name: opus, model: c/opus }\n";
const persona = (name: string) => `---\nname: ${name}\ndescription: fixture\nmodel: a/sol\ntools: read,grep,find,ls\nwrites: []\n---\nAnswer the question.\n`;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "-c", "commit.gpgsign=false", ...args], { env: sessionGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function repository(path: string, ignorePi = false): void {
	mkdirSync(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	writeFileSync(join(path, "README.md"), "fixture\n");
	if (ignorePi) writeFileSync(join(path, ".gitignore"), ".pi/\n");
	git(path, "add", ".");
	git(path, "commit", "-qm", "base");
}

function fleetConfig(workspace: string, overrides = ""): void {
	mkdirSync(join(workspace, ".pi", "agents", "personas"), { recursive: true });
	mkdirSync(join(workspace, ".ai"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "agents", "voices.yaml"), VOICES_YAML);
	writeFileSync(join(workspace, ".pi", "agents", "personas", "researcher.md"), persona("researcher"));
	writeFileSync(join(workspace, ".pi", "agents", "personas", "reviewer.md"), persona("reviewer"));
	if (overrides) writeFileSync(join(workspace, ".ai", "agent-fleet-overrides.md"), overrides);
}

interface VoiceRun { model: string; round: number; cwd: string; tools: string; prompt: string }

/**
 * Stub voices. sol moves in round 2 on opus's evidence; opus holds and still refutes sol at the end;
 * grok optionally fails from a round on, or writes into the checkout in round 1.
 */
function voices(options: { grokFailsFrom?: number; failAllButSolInRound1?: boolean; grokWrites?: boolean } = {}) {
	const runs: VoiceRun[] = [];
	const spawn: SpawnAgent = async opts => {
		const round = Number(/Debate round (\d+) of/.exec(opts.prompt)?.[1] ?? 0);
		runs.push({ model: opts.model, round, cwd: opts.cwd!, tools: opts.tools, prompt: opts.prompt });
		const fail = (opts.model === "b/grok" && options.grokFailsFrom !== undefined && round >= options.grokFailsFrom)
			|| (options.failAllButSolInRound1 && round === 1 && opts.model !== "a/sol");
		if (fail) return { output: "", exitCode: 1, stderr: "timeout", modelUsed: opts.model } as any;
		if (opts.model === "b/grok" && options.grokWrites && round === 1) {
			// After the other voices finished, so only this voice's run observes its own write.
			await new Promise(resolve => setTimeout(resolve, 80));
			writeFileSync(join(opts.cwd!, "mutation.txt"), "a read-only voice wrote this");
		}
		const base = { ...ENVELOPE_EXAMPLES.debate, aligned_with: [] as string[], refutes: [] as string[], evidence_that_moved_me: [] as string[], changed: false };
		const report = opts.model === "a/sol"
			? (round === 1 ? { ...base, position: "Extract now.", changed: true }
				: round === 2 ? { ...base, position: "Extract after the release.", changed: true, aligned_with: ["opus"], evidence_that_moved_me: ["opus: the release freeze in docs/release.md"] }
				: { ...base, position: "Extract after the release.", aligned_with: ["opus"] })
			: opts.model === "c/opus"
				? { ...base, position: "Extract after the release, behind a flag.", aligned_with: round > 1 ? ["sol"] : [], refutes: round > 1 ? ["sol's plan skips the flag"] : [] }
				: { ...base, position: "Rewrite the parser.", refutes: round > 1 ? ["both delay the fix"] : [] };
		return { output: JSON.stringify(report), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: opts.model } as any;
	};
	let visibility = 0;
	const checkVisibility = (models: string[]) => { visibility++; return { models: models.map(model => ({ model, ok: true, failed: [], reasons: [] })) }; };
	return { runs, spawn, checkVisibility, visibilityCalls: () => visibility };
}

function hubPorts(cwd: string, stub: ReturnType<typeof voices>, command: "/af-debate" | "debate_panel", configured: string | null = null) {
	let charged = 0;
	const input: AfDebateHandleInput = {
		cwd,
		configuredPanel: () => configured,
		...hubDebateWorkflowPorts({ command, spawn: stub.spawn, checkVisibility: stub.checkVisibility }),
		checkBudget: () => null,
		chargeBudget: () => { charged++; },
	};
	return { input, charged: () => charged };
}

function commandUi() {
	const shown: (DebateBlock | undefined)[] = [];
	const sent: AfDebateMessage[] = [];
	return { shown, sent, ui: { show: (block: DebateBlock | undefined) => { shown.push(block); }, send: (message: AfDebateMessage) => { sent.push(message); } } };
}

test("ordinary repository via debate_panel: read-only voices, labelled cross-examination, a changed position and an open disagreement", async () => {
	const repo = canonicalMkdtempSync(join(tmpdir(), "debate-repo-"));
	try {
		repository(repo, true);
		fleetConfig(repo);
		const stub = voices({ grokFailsFrom: 2 });
		const hub = hubPorts(repo, stub, "debate_panel");
		const updates: Update[] = [];
		const result = await toolOver(hub.input).execute("id", { question: "Extract the parser now?" }, undefined, (update: Update) => updates.push(update), {});
		assert.equal(result.details.status, "ok", result.content[0].text);
		assert.equal(hub.charged(), 1);

		// Worker permissions and the checkout: every voice is read-only and runs in the repository.
		assert.ok(stub.runs.every(run => run.cwd === repo && run.tools === "read,grep,find,ls"));
		// Round inputs: round 1 independent; round 2 carries the other successful voices' labelled positions, never the voice's own.
		assert.deepEqual(stub.runs.filter(run => run.round === 1).map(run => run.model).sort(), ["a/sol", "b/grok", "c/opus"]);
		for (const run of stub.runs.filter(run => run.round === 1)) assert.doesNotMatch(run.prompt, /Labeled positions from the previous round/);
		const solRound2 = stub.runs.find(run => run.round === 2 && run.model === "a/sol")!;
		assert.match(solRound2.prompt, /## grok \(b\/grok\)/);
		assert.match(solRound2.prompt, /## opus \(c\/opus\)/);
		assert.doesNotMatch(solRound2.prompt, /## sol \(a\/sol\)/);
		// grok failed in round 2, so round 3 is sol and opus only, each seeing just the other.
		assert.deepEqual(stub.runs.filter(run => run.round === 3).map(run => run.model).sort(), ["a/sol", "c/opus"]);
		const solRound3 = stub.runs.find(run => run.round === 3 && run.model === "a/sol")!;
		assert.doesNotMatch(solRound3.prompt, /## grok/);

		const debate = result.details.result!;
		assert.equal(debate.complete, true);
		assert.equal(debate.roundsRun, 3);
		const sol = debate.voices.find(voice => voice.name === "sol")!;
		assert.deepEqual(sol.changes, [{ round: 2, from: "Extract now.", evidence: ["opus: the release freeze in docs/release.md"] }], "round 1's changed flag is ignored");
		const grok = debate.voices.find(voice => voice.name === "grok")!;
		assert.equal(grok.failedRound, 2);
		assert.equal(grok.position, "Rewrite the parser.", "the last position it reached stays visible");
		assert.deepEqual(debate.disagreements, [{ voice: "opus", statement: "sol's plan skips the flag" }], "a dropped voice's refutations do not count");
		// Artifact references resolve from the checkout.
		assert.match(debate.directory, /^\.pi\/agent-sessions\/artifacts\/polls\/[^/]+\/debate\/$/);
		for (const round of debate.roundDetails) {
			for (const voice of round.voices) assert.ok(existsSync(join(repo, voice.path)), voice.path);
		}
		assert.match(readFileSync(join(repo, sol.path!), "utf8"), /Extract after the release\./);
		assert.match(result.content[0].text, /^DEBATE RESULT \(panel default, 3 of 3 rounds, complete\)/);
		assert.match(result.content[0].text, /changed: round 2 — moved by: opus: the release freeze/);
		assert.match(result.content[0].text, /- opus: sol's plan skips the flag/);

		// One block, updated in place: no panel before resolution, stable rows, the round of the total.
		assert.equal(updates[0].details.debate.status, "resolving");
		assert.equal(updates[0].details.debate.panel, undefined);
		for (const update of updates) assert.doesNotMatch(update.content[0].text, /\n/, "each update replaces, never accumulates");
		const live = updates.map(update => update.details.debate).filter(block => block.status === "running");
		for (const block of live) assert.deepEqual(block.voices.map(voice => voice.name), ["sol", "grok", "opus"]);
		assert.ok(live.some(block => /· round 2\/3 ·/.test(renderDebateBlock(block, { expanded: false })[0])));
		const collapsed = renderDebateBlock(result.details.debate, { expanded: false });
		assert.match(collapsed[0], /✓ Debate · panel default · 3\/3 rounds/);
		assert.equal(collapsed.length, 5, "headline, three voice rows, the outcome");
		assert.match(collapsed[1], /✓ sol · r3 · changed in r2 · Extract after the release\./);
		assert.match(collapsed[2], /✗ grok · failed in r2: /);
		assert.match(collapsed[4], /⚑ 1 open disagreement · opus: sol's plan skips the flag/);
		const expanded = renderDebateBlock(result.details.debate, { expanded: true }).join("\n");
		assert.match(expanded, /r2 was: Extract now\./);
		assert.match(expanded, /r2 moved by: opus: the release freeze in docs\/release\.md/);
		assert.match(expanded, /round 2: 2\/3 ok · \.pi\/agent-sessions\/artifacts\/polls\/[^/]+\/debate\/round-2\//);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test("explicit and configured panels, the reviewer persona and the round bounds reach the rounds", async () => {
	const repo = canonicalMkdtempSync(join(tmpdir(), "debate-select-"));
	try {
		repository(repo, true);
		fleetConfig(repo);
		const configured = voices();
		const viaConfig = await runAfDebate({ ...hubPorts(repo, configured, "debate_panel", "cheap").input, question: "q", rounds: 2, persona: "reviewer" });
		assert.equal(viaConfig.ok, true, viaConfig.message);
		assert.equal(viaConfig.block!.source, "configured");
		assert.deepEqual([...new Set(configured.runs.map(run => run.model))].sort(), ["a/sol", "c/opus"]);
		assert.equal(Math.max(...configured.runs.map(run => run.round)), 2);
		const explicit = voices();
		const viaFlag = await presentAfDebateCommand({ ...hubPorts(repo, explicit, "/af-debate", "cheap").input, args: "--panel default --rounds 5 q" }, commandUi().ui);
		assert.equal(viaFlag.block!.source, "explicit");
		assert.equal(viaFlag.result!.roundsRun, 5);
		assert.equal(new Set(explicit.runs.map(run => run.model)).size, 3);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a worker that writes is caught by the read-only controls and counts as a failed voice", async () => {
	const repo = canonicalMkdtempSync(join(tmpdir(), "debate-mutate-"));
	try {
		repository(repo, true);
		fleetConfig(repo);
		const result = await runAfDebate({ ...hubPorts(repo, voices({ grokWrites: true }), "debate_panel").input, question: "q", rounds: 2 });
		assert.equal(result.ok, true);
		const grok = result.result!.voices.find(voice => voice.name === "grok")!;
		assert.equal(grok.failedRound, 1);
		assert.match(grok.reason!, /PermissionBreach: unauthorized repository changes: mutation\.txt/);
		assert.equal(existsSync(join(repo, "mutation.txt")), false, "the mutation was rolled back");
		assert.equal(git(repo, "status", "--porcelain"), "");
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fewer than two voices in round 1 fails the debate with the round artifacts named; a later collapse stops it early", async () => {
	const repo = canonicalMkdtempSync(join(tmpdir(), "debate-fail-"));
	try {
		repository(repo, true);
		fleetConfig(repo);
		const { ui, sent } = commandUi();
		const failed = await presentAfDebateCommand({ ...hubPorts(repo, voices({ failAllButSolInRound1: true }), "/af-debate").input, args: "q" }, ui);
		assert.equal(failed.ok, false);
		assert.match(failed.message, /Debate failed: 1 of 3 voices succeeded in round 1/);
		assert.match(failed.message, /Round artifacts: \.pi\/agent-sessions\/artifacts\/polls\/[^/]+\/debate\/$/);
		assert.ok(existsSync(join(repo, failed.block!.directory!, "round-1", "grok.md")));
		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, AF_DEBATE_FAILED_MESSAGE);

		const cheapCollapse = voices({ grokFailsFrom: 2 });
		// Panel cheap has two voices; make opus fail from round 2 by reusing grok's switch on a renamed model.
		const stopped = await runAfDebate({
			...hubPorts(repo, { ...cheapCollapse, spawn: async opts => cheapCollapse.spawn({ ...opts, model: opts.model === "c/opus" ? "b/grok" : opts.model }) }, "debate_panel").input,
			question: "q", panel: "cheap", rounds: 3,
		});
		assert.equal(stopped.ok, true, stopped.message);
		assert.equal(stopped.result!.complete, false);
		assert.equal(stopped.result!.roundsRun, 2);
		assert.equal(stopped.result!.stopReason, "round 2 had 1 successful voice; a round needs at least 2");
		assert.match(stopped.dispatcherNote!, /^DEBATE RESULT \(panel cheap, 2 of 3 rounds, stopped: round 2 had 1 successful voice/);
		assert.match(renderDebateBlock(stopped.block!, { expanded: false })[0], /◐ Debate · panel cheap · 2\/3 rounds · stopped early/);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

/** A non-Git project parent holding the main checkout, its linked worktree (assigned) and a sibling repository. */
function parentFixture() {
	const root = canonicalMkdtempSync(join(tmpdir(), "debate-parent-"));
	const main = join(root, "repo"), linked = join(root, "repo.worktree"), sibling = join(root, "sibling");
	repository(main);
	git(main, "worktree", "add", "-q", "--detach", linked);
	repository(sibling);
	fleetConfig(root);
	const binding = resolveSessionRoots(root, { worktree: "repo.worktree" });
	return { root, main, linked, sibling, binding };
}

test("non-Git project parent: both entry points debate in the assigned linked worktree; roster and artifacts stay at the workspace", async () => {
	const { root, linked, sibling, main, binding } = parentFixture();
	try {
		await withSessionRoots(binding, async () => {
			const tool = voices();
			const viaTool = await toolOver(hubPorts(linked, tool, "debate_panel").input).execute("id", { question: "q", rounds: 2 }, undefined, undefined, {});
			assert.equal(viaTool.details.status, "ok", viaTool.content[0].text);
			assert.ok(tool.runs.every(run => run.cwd === linked));
			const debates = join(root, ".pi", "agent-sessions", "artifacts", "polls");
			assert.ok(viaTool.details.result!.directory.startsWith(debates + sep), "an absolute path the operator can open from the worktree");
			assert.ok(existsSync(join(viaTool.details.result!.directory, "round-2", "sol.md")));
			assert.equal(existsSync(join(linked, ".pi", "agent-sessions")), false, "nothing is written into the target");

			const command = voices();
			const { ui, sent } = commandUi();
			const result = await presentAfDebateCommand({ ...hubPorts(linked, command, "/af-debate").input, args: "--rounds 2 q" }, ui);
			assert.equal(result.ok, true);
			assert.ok(command.runs.every(run => run.cwd === linked));
			assert.equal(sent.length, 1);
			assert.equal(sent[0].customType, AF_DEBATE_MESSAGE);
			assert.equal(sent[0].details.debate.worktree, linked);
		});
		for (const checkout of [main, linked, sibling]) assert.equal(git(checkout, "status", "--porcelain"), "");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

async function refusedEverywhere(cwd: string, expected: RegExp, extra: { args?: string; params?: Record<string, unknown> } = {}) {
	for (const entry of ["debate_panel", "/af-debate"] as const) {
		const stub = voices();
		const hub = hubPorts(cwd, stub, entry);
		let message: string;
		if (entry === "debate_panel") {
			const result = await toolOver(hub.input).execute("id", { question: "A or B?", ...extra.params }, undefined, undefined, {});
			assert.equal(result.details.status, "failed");
			assert.equal(result.details.started, false);
			message = result.content[0].text;
			assert.equal(renderDebateBlock(result.details.debate, { expanded: false }).filter(line => expected.test(line)).length, 1, "one diagnostic in the block");
		} else {
			const { ui, sent } = commandUi();
			await presentAfDebateCommand({ ...hub.input, args: `${extra.args ?? ""} A or B?` }, ui);
			assert.equal(sent.length, 1, "one transcript entry");
			assert.equal(sent[0].customType, AF_DEBATE_FAILED_MESSAGE);
			message = sent[0].content;
		}
		assert.match(message, expected);
		assert.equal(stub.runs.length, 0, `${entry}: zero voice starts`);
		assert.equal(stub.visibilityCalls(), 0, `${entry}: refused before preflight`);
		assert.equal(hub.charged(), 0, `${entry}: no budget charged`);
	}
}

test("missing, ambiguous and out-of-scope targets, an unknown panel and invalid rounds refuse once with zero starts", async () => {
	const { root, linked, sibling, binding } = parentFixture();
	const empty = canonicalMkdtempSync(join(tmpdir(), "debate-empty-"));
	try {
		fleetConfig(empty);
		await refusedEverywhere(empty, /Debate refused before any voice started: the Fleet workspace .* is not a Git repository and this session has no assigned worktree/);
		await refusedEverywhere(root, /Debate never chooses among its repositories \(repo, repo\.worktree, sibling\)/);
		await withSessionRoots(binding, async () => {
			await refusedEverywhere(sibling, /the working directory .*sibling is outside this session's assigned worktree/);
			await refusedEverywhere(linked, /Unknown panel "typo"/, { args: "--panel typo", params: { panel: "typo" } });
		});
		await refusedEverywhere(root, /Debate rounds must be an integer from 2 to 5 \(got 9\)/, { args: "--rounds 9", params: { rounds: 9 } });
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(empty, { recursive: true, force: true });
	}
});
