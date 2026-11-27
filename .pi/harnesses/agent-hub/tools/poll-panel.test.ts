import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { canonicalMkdtempSync } from "../../../../bin/test/helpers/test-temp.js";
import { resolveSessionRoots, sessionGitEnv, withSessionRoots } from "../../lib/workspace-context.ts";
import type { SpawnAgent } from "../../../agent-fleet/scripts/workflows/lib/agent-phase.ts";
import { ENVELOPE_EXAMPLES } from "../../../agent-fleet/scripts/workflows/lib/envelopes.ts";
import { AF_POLL_FAILED_MESSAGE, AF_POLL_MESSAGE, presentAfPollCommand, runAfPoll, type AfPollHandleInput, type AfPollMessage } from "../poll-command.ts";
import { renderPollBlock, type PollBlock } from "../poll-progress.ts";
import { hubPollWorkflowPorts } from "../poll-runtime.ts";
import { executePollPanel, POLL_PANEL_DESCRIPTION, POLL_PANEL_PARAM_HELP, POLL_PANEL_SELECT, type PollPanelDeps } from "./poll-panel-core.ts";
import { FLEET_TOOLS, OPERATOR_DELEGATION_GUIDE } from "../work-mode.ts";

function ports(overrides: Partial<Omit<AfPollHandleInput, "args">> = {}) {
	const calls: string[] = [];
	const input: Omit<AfPollHandleInput, "args"> = {
		cwd: "/repo",
		configuredPanel: () => null,
		listPanels: () => ["default"],
		panelVoices: () => [{ name: "sol", model: "a/sol" }, { name: "grok", model: "b/grok" }, { name: "opus", model: "c/opus" }],
		preflight: () => { calls.push("preflight"); return null; },
		checkBudget: () => { calls.push("budget"); return null; },
		chargeBudget: () => { calls.push("charge"); },
		execute: async ({ panel, persona, question, emit }) => {
			calls.push(`execute:${panel}:${persona}:${question}`);
			emit({ type: "voice", voice: { name: "opus", model: "c/opus", ok: true, position: "Keep the facade", confidence: "medium" } });
			emit({ type: "voice", voice: { name: "grok", model: "b/grok", ok: false, reason: "timeout" } });
			emit({ type: "voice", voice: { name: "sol", model: "a/sol", ok: true, position: "Keep the facade", confidence: "high" } });
			emit({ type: "synthesis", integrator: { name: "opus", model: "c/opus" } });
			return {
				panel, directory: ".pi/flow-sessions/poll/",
				voices: [
					{ name: "sol", model: "a/sol", ok: true, position: "Keep the facade", confidence: "high" },
					{ name: "grok", model: "b/grok", ok: false, reason: "timeout" },
					{ name: "opus", model: "c/opus", ok: true, position: "Keep the facade", confidence: "medium" },
				],
				recommendation: "Keep the facade and extract later", integrator: "opus",
			};
		},
		...overrides,
	};
	return { input, calls };
}

test("runAfPoll takes typed inputs: default panel, default persona, one charge, failed voices stay visible", async () => {
	const { input, calls } = ports();
	const result = await runAfPoll({ ...input, question: "Keep the facade?", panel: "default" });
	assert.equal(result.ok, true);
	assert.deepEqual(calls, ["preflight", "budget", "charge", "execute:default:researcher:Keep the facade?"]);
	assert.match(result.digest!, /grok · b\/grok\n  failed: timeout/);
	assert.match(result.digest!, /recommendation: Keep the facade and extract later/);
	assert.match(result.dispatcherNote!, /Do not paste full voice opinions/);
});

test("runAfPoll refuses an empty question and an unknown panel before any charge", async () => {
	const empty = ports();
	assert.equal((await runAfPoll({ ...empty.input, question: "  " })).ok, false);
	assert.deepEqual(empty.calls, []);
	const unknown = ports();
	const result = await runAfPoll({ ...unknown.input, question: "q", panel: "missing" });
	assert.equal(result.ok, false);
	assert.match(result.message, /Unknown panel "missing"/);
	assert.deepEqual(unknown.calls, []);
});

test("runAfPoll reports a failed poll as a failure, never as a decision", async () => {
	const { input } = ports({ execute: async () => { throw new Error("Poll failed: 1 of 3 voices succeeded"); } });
	const result = await runAfPoll({ ...input, question: "q", panel: "default" });
	assert.equal(result.ok, false);
	assert.match(result.message, /1 of 3 voices succeeded/);
});

function registered(deps: PollPanelDeps) {
	return { execute: (_id: string, params: any, _signal: unknown, onUpdate: any, ctx: any) => executePollPanel(deps, params, onUpdate, ctx) };
}

/** The tool as the Hub wires it: the shared runner with the tool's selection hint. */
function toolOver(input: Omit<AfPollHandleInput, "args">) {
	return registered({ blocked: () => null, run: (params, _ctx, onProgress) => runAfPoll({ ...params, ...input, selectHint: POLL_PANEL_SELECT, onProgress }) });
}

type Update = { content: { type: "text"; text: string }[]; details: { status: string; poll: PollBlock } };

test("poll_panel is a fleet tool described for decisions, not facts, with the panel precedence in its help", () => {
	assert.ok((FLEET_TOOLS as readonly string[]).includes("poll_panel"));
	assert.match(POLL_PANEL_DESCRIPTION, /Decisions, not facts/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /poll_panel/);
	assert.match(OPERATOR_DELEGATION_GUIDE, /Never poll or debate facts/);
	assert.match(POLL_PANEL_PARAM_HELP, /configured poll-panel, else the panel named default\. Unknown names fail/);
});

test("poll_panel updates one block in place: no panel before resolution, stable rows, synthesis, recommendation", async () => {
	const updates: Update[] = [];
	const { input } = ports({ configuredPanel: () => "cheap", listPanels: () => ["default", "cheap"] });
	const final = await toolOver(input).execute("id", { question: "Which cache?" }, undefined, (update: Update) => updates.push(update), {});
	assert.equal(updates[0].details.poll.status, "resolving");
	assert.equal(updates[0].details.poll.panel, undefined);
	assert.doesNotMatch(renderPollBlock(updates[0].details.poll, { expanded: false }).join("\n"), /cheap|default/);
	for (const update of updates) {
		assert.equal(update.content.length, 1);
		assert.doesNotMatch(update.content[0].text, /\n/, "each update replaces, never accumulates");
	}
	const live = updates.map(update => update.details.poll).filter(block => block.status === "running" || block.status === "synthesizing");
	for (const block of live) {
		assert.deepEqual(block.voices.map(voice => voice.name), ["sol", "grok", "opus"]);
		assert.equal(renderPollBlock(block, { expanded: false }).length, block.synthesis ? 5 : 4);
	}
	const outOfOrder = live.find(block => block.voices[2].state === "ok" && block.voices[0].state === "running");
	assert.ok(outOfOrder, "opus finished before sol");
	assert.match(renderPollBlock(live.find(block => block.status === "synthesizing")!, { expanded: false }).join("\n"), /● synthesis · opus · integrating opinions…/);

	assert.equal(final.details.status, "ok");
	assert.match(final.content[0].text, /^POLL RESULT \(panel cheap\)/, "the model receives the compact digest");
	const block = final.details.poll!;
	assert.equal(block.panel, "cheap");
	const collapsed = renderPollBlock(block, { expanded: false });
	assert.match(collapsed[0], /✓ Poll · panel cheap · 3\/3 voices/);
	assert.match(collapsed.at(-1)!, /→ Keep the facade and extract later/);
	const expanded = renderPollBlock(block, { expanded: true });
	assert.ok(expanded.length > collapsed.length);
	assert.match(expanded.join("\n"), /grok · b\/grok\n      failed: timeout/);
	assert.match(expanded.join("\n"), /✓ synthesis · opus/);
});

test("poll_panel refuses before any work when blocked, and a panel failure appears once in the block", async () => {
	let ran = false;
	const blockedTool = registered({ blocked: () => "declined", run: async () => { ran = true; return { ok: true, message: "" }; } });
	const refused = await blockedTool.execute("id", { question: "q" }, undefined, undefined, {});
	assert.equal(refused.details.status, "refused");
	assert.equal(refused.details.started, false);
	assert.equal(refused.details.poll!.failure, "declined");
	assert.equal(ran, false);

	const { input, calls } = ports({ configuredPanel: () => "gone", listPanels: () => ["cheap"] });
	const updates: Update[] = [];
	const failed = await toolOver(input).execute("id", { question: "q" }, undefined, (update: Update) => updates.push(update), {});
	assert.deepEqual(calls, [], "zero voice starts on a selection failure");
	assert.equal(failed.details.status, "failed");
	assert.equal(failed.details.started, false);
	assert.match(failed.content[0].text, /^POLL FAILED — no decision was produced\.\n\nThe configured Poll panel "gone".*Available panels: cheap\. Correct poll-panel: or select a panel with panel: "NAME"\./);
	const lines = renderPollBlock(failed.details.poll!, { expanded: false });
	assert.equal(lines.filter(line => /configured Poll panel "gone"/.test(line)).length, 1);
	assert.deepEqual(renderPollBlock(failed.details.poll!, { expanded: true }), lines);

	const runFailed = await registered({ blocked: () => null, run: async () => ({ ok: false, message: "Poll failed: 1 of 3" }) })
		.execute("id", { question: "q" }, undefined, undefined, {});
	assert.equal(runFailed.details.status, "failed");
	assert.match(runFailed.content[0].text, /no decision was produced/);
});

// ---------------------------------------------------------------------------
// Git work context: temporary repositories, stub workers, both entry points.
// ---------------------------------------------------------------------------

const VOICES_YAML = "default:\n  - { name: sol, model: a/sol }\n  - { name: grok, model: b/grok }\n  - { name: opus, model: c/opus, integrator: true }\n";
const PERSONA = "---\nname: researcher\ndescription: fixture\nmodel: a/sol\ntools: read,grep,find,ls\nwrites: []\n---\nAnswer the question.\n";

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

function fleetConfig(workspace: string): void {
	mkdirSync(join(workspace, ".pi", "agents", "personas"), { recursive: true });
	writeFileSync(join(workspace, ".pi", "agents", "voices.yaml"), VOICES_YAML);
	writeFileSync(join(workspace, ".pi", "agents", "personas", "researcher.md"), PERSONA);
}

/** Stub workers: record the checkout each one runs in; `grok` optionally mutates it after a delay. */
function workers(options: { mutate?: boolean } = {}) {
	const runs: { role: "voice" | "synthesis"; model: string; cwd: string }[] = [];
	const spawn: SpawnAgent = async opts => {
		const synthesis = opts.prompt.startsWith("Merge the independent poll opinions");
		runs.push({ role: synthesis ? "synthesis" : "voice", model: opts.model, cwd: opts.cwd! });
		if (!synthesis && opts.model === "b/grok" && options.mutate) {
			await new Promise(resolve => setTimeout(resolve, 80));
			writeFileSync(join(opts.cwd!, "mutation.txt"), "a read-only voice wrote this");
		}
		const report = synthesis ? { ...ENVELOPE_EXAMPLES.merge, recommendation: "Adopt A." } : { ...ENVELOPE_EXAMPLES.poll, position: `from ${opts.model}` };
		return { output: JSON.stringify(report), exitCode: 0, stderr: "", toolCallsStarted: 0, modelUsed: opts.model } as any;
	};
	let visibility = 0;
	const checkVisibility = (models: string[]) => { visibility++; return { models: models.map(model => ({ model, ok: true, failed: [], reasons: [] })) }; };
	return { runs, spawn, checkVisibility, visibilityCalls: () => visibility };
}

function hubPorts(cwd: string, stub: ReturnType<typeof workers>, command: "/af-poll" | "poll_panel") {
	let charged = 0;
	const input: Omit<AfPollHandleInput, "args"> = {
		cwd,
		configuredPanel: () => null,
		...hubPollWorkflowPorts({ command, spawn: stub.spawn, checkVisibility: stub.checkVisibility }),
		checkBudget: () => null,
		chargeBudget: () => { charged++; },
	};
	return { input, charged: () => charged };
}

function commandUi() {
	const shown: (PollBlock | undefined)[] = [];
	const sent: AfPollMessage[] = [];
	return { shown, sent, ui: { show: (block: PollBlock | undefined) => { shown.push(block); }, send: (message: AfPollMessage) => { sent.push(message); } } };
}

test("ordinary repository: Git checks, voices and synthesis run in the checkout; a worker mutation is caught", async () => {
	const repo = canonicalMkdtempSync(join(tmpdir(), "poll-repo-"));
	try {
		repository(repo, true);
		fleetConfig(repo);
		const tool = workers();
		const viaTool = await toolOver(hubPorts(repo, tool, "poll_panel").input).execute("id", { question: "A or B?" }, undefined, undefined, {});
		assert.equal(viaTool.details.status, "ok");
		assert.deepEqual(tool.runs.map(run => run.cwd), Array(4).fill(repo));
		assert.equal(tool.runs.filter(run => run.role === "synthesis").length, 1);
		const block = viaTool.details.poll!;
		assert.equal(block.worktree, repo);
		assert.match(block.directory!, /^\.pi\/agent-sessions\/artifacts\/polls\/[^/]+\/$/);
		assert.ok(existsSync(join(repo, block.directory!, "sol.md")));
		assert.ok(existsSync(join(repo, block.directory!, "merged.md")));

		const command = workers({ mutate: true });
		const { ui, sent } = commandUi();
		const result = await presentAfPollCommand({ ...hubPorts(repo, command, "/af-poll").input, args: "A or B?" }, ui);
		assert.equal(result.ok, true, "two voices still succeed");
		const grok = result.block!.voices.find(voice => voice.name === "grok")!;
		assert.equal(grok.state, "failed");
		assert.match(grok.reason!, /PermissionBreach: unauthorized repository changes: mutation\.txt/);
		assert.equal(existsSync(join(repo, "mutation.txt")), false, "the mutation was rolled back");
		assert.equal(git(repo, "status", "--porcelain"), "");
		assert.equal(sent.length, 1);
		assert.equal(sent[0].customType, AF_POLL_MESSAGE);
	} finally { rmSync(repo, { recursive: true, force: true }); }
});

/** A non-Git project parent holding the main checkout, its linked worktree (assigned) and a sibling repository. */
function parentFixture() {
	const root = canonicalMkdtempSync(join(tmpdir(), "poll-parent-"));
	const main = join(root, "repo"), linked = join(root, "repo.worktree"), sibling = join(root, "sibling");
	repository(main);
	// A roster committed inside the target must never replace the workspace's.
	mkdirSync(join(main, ".pi", "agents"), { recursive: true });
	writeFileSync(join(main, ".pi", "agents", "voices.yaml"), "poison:\n  - { name: x, model: p/x }\n  - { name: y, model: p/y }\n");
	git(main, "add", ".");
	git(main, "commit", "-qm", "target roster");
	git(main, "worktree", "add", "-q", "--detach", linked);
	repository(sibling);
	fleetConfig(root);
	const binding = resolveSessionRoots(root, { worktree: "repo.worktree" });
	assert.equal(binding.executionRoot, linked);
	const untouched = () => {
		assert.equal(git(sibling, "status", "--porcelain"), "", "the sibling repository is untouched");
		assert.equal(git(main, "status", "--porcelain"), "");
		assert.equal(git(linked, "status", "--porcelain"), "", "the assigned worktree is left clean");
	};
	return { root, main, linked, sibling, binding, untouched };
}

test("non-Git project parent via poll_panel: the assigned linked worktree is the only target; roster and opinions stay at the workspace", async () => {
	const { root, linked, binding, untouched } = parentFixture();
	try {
		await withSessionRoots(binding, async () => {
			const tool = workers();
			const viaTool = await toolOver(hubPorts(linked, tool, "poll_panel").input).execute("id", { question: "A or B?" }, undefined, undefined, {});
			assert.equal(viaTool.details.status, "ok", viaTool.content[0].text);
			assert.deepEqual(tool.runs.map(run => run.cwd), Array(4).fill(linked), "Git checks, voices and synthesis use the assigned worktree");
			const block = viaTool.details.poll!;
			assert.equal(block.panel, "default", "the workspace roster supplied the panel");
			assert.deepEqual(block.voices.map(voice => voice.name), ["sol", "grok", "opus"]);
			const polls = join(root, ".pi", "agent-sessions", "artifacts", "polls");
			assert.ok(block.directory!.startsWith(polls + sep), "an absolute path the operator can open from the worktree");
			assert.ok(existsSync(join(block.directory!, "sol.md")));
			assert.ok(existsSync(join(block.directory!, "merged.md")));
			assert.match(viaTool.content[0].text, new RegExp(`Full opinions: ${block.directory!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
			assert.equal(existsSync(join(linked, ".pi", "agent-sessions")), false, "nothing is written into the target");
			assert.equal(readdirSync(join(root, ".pi", "flow-sessions", "targets")).length, 1, "run records stay at the workspace");
		});
		untouched();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("non-Git project parent via /af-poll: read-only protection still catches a worker mutation in the assigned worktree", async () => {
	const { root, linked, binding, untouched } = parentFixture();
	try {
		await withSessionRoots(binding, async () => {
			const command = workers({ mutate: true });
			const { ui, sent } = commandUi();
			const result = await presentAfPollCommand({ ...hubPorts(linked, command, "/af-poll").input, args: "A or B?" }, ui);
			assert.equal(result.ok, true);
			assert.deepEqual(command.runs.map(run => run.cwd), Array(4).fill(linked));
			assert.match(result.block!.voices.find(voice => voice.name === "grok")!.reason!, /PermissionBreach: unauthorized repository changes: mutation\.txt/);
			assert.equal(existsSync(join(linked, "mutation.txt")), false, "the mutation was rolled back");
			assert.equal(sent.length, 1);
			assert.equal(sent[0].customType, AF_POLL_MESSAGE);
			assert.ok(sent[0].details.poll.directory!.startsWith(join(root, ".pi", "agent-sessions", "artifacts", "polls") + sep));
			assert.match(sent[0].content, /^POLL RESULT \(panel default\)/);
		});
		untouched();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

async function refusedEverywhere(cwd: string, expected: RegExp) {
	for (const entry of ["poll_panel", "/af-poll"] as const) {
		const stub = workers();
		const hub = hubPorts(cwd, stub, entry);
		let message: string;
		if (entry === "poll_panel") {
			const updates: Update[] = [];
			const result = await toolOver(hub.input).execute("id", { question: "A or B?" }, undefined, (update: Update) => updates.push(update), {});
			assert.equal(result.details.status, "failed");
			assert.equal(result.details.started, false);
			message = result.content[0].text;
			assert.equal(renderPollBlock(result.details.poll!, { expanded: false }).filter(line => expected.test(line)).length, 1, "one diagnostic in the block");
		} else {
			const { ui, sent } = commandUi();
			await presentAfPollCommand({ ...hub.input, args: "A or B?" }, ui);
			assert.equal(sent.length, 1, "one transcript entry");
			assert.equal(sent[0].customType, AF_POLL_FAILED_MESSAGE);
			message = sent[0].content;
		}
		assert.match(message, expected);
		assert.equal(stub.runs.length, 0, `${entry}: zero voice or synthesis starts`);
		assert.equal(stub.visibilityCalls(), 0, `${entry}: refused before preflight`);
		assert.equal(hub.charged(), 0, `${entry}: no budget charged`);
	}
}

test("missing, ambiguous, out-of-scope or stale targets refuse once with zero voice and synthesis starts", async () => {
	const root = canonicalMkdtempSync(join(tmpdir(), "poll-refuse-"));
	const empty = canonicalMkdtempSync(join(tmpdir(), "poll-empty-"));
	try {
		const main = join(root, "repo"), linked = join(root, "repo.worktree"), sibling = join(root, "sibling");
		repository(main);
		git(main, "worktree", "add", "-q", "--detach", linked);
		repository(sibling);
		fleetConfig(root);
		fleetConfig(empty);
		await refusedEverywhere(empty, /Poll refused before any voice started: the Fleet workspace .* is not a Git repository and this session has no assigned worktree\. Start a new Hub session .*just fleet --worktree <path>/);
		await refusedEverywhere(root, /Poll never chooses among its repositories \(repo, repo\.worktree, sibling\)/);
		const binding = resolveSessionRoots(root, { worktree: "repo.worktree" });
		await withSessionRoots(binding, async () => {
			await refusedEverywhere(sibling, /the working directory .*sibling is outside this session's assigned worktree .*repo\.worktree/);
			git(main, "worktree", "remove", "--force", linked);
			await refusedEverywhere(linked, /this session's assigned worktree no longer validates/);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(empty, { recursive: true, force: true });
	}
});
