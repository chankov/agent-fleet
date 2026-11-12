import {canonicalMkdtempSync as mkdtempSync} from '../../../../bin/test/helpers/test-temp.js';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {existsSync, readFileSync, rmSync, writeFileSync, mkdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {resolveSessionRoots,withSessionRoots,sessionRootsFromEnv} from '../../lib/workspace-context.ts';
import {loadSystem1Snapshot,readSystem1Document} from '../../lib/system1/config-loader.js';
import {approveWorktreeScope} from '../../lib/system1/worktree-scopes.ts';
import { registerRunFlow } from "./run-flow.ts";

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "af-run-flow-repo-")); mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "README.md"), "baseline\n");
	writeFileSync(join(root, "agents", "researcher.md"), "---\nname: researcher\ndescription: read only\ntools: read,grep,find,ls\nmodel: test/model\n---\nScout.\n");
	execFileSync("git", ["init", "-q"], { cwd: root }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }); execFileSync("git", ["config", "user.name", "Test"], { cwd: root }); execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root }); return root;
}
function harness(deps: any) { let definition: any; const shutdown: any[] = []; registerRunFlow({ registerTool(value: any) { definition = value; }, on(name: string, handler: any) { if (name === "session_shutdown") shutdown.push(handler); } } as any, deps); return { definition, shutdown }; }
const report = { status: "success", summary: "Scout complete", artifacts: [], notes_for_next_agent: "", findings: ["README.md"] } as any;

test('selected-target scout snapshots real dirty target bytes, keeps af resources and does not inherit source-export approval',async()=>{
 const root=repo(),af=mkdtempSync(join(tmpdir(),'af-target-config-')),parent=mkdtempSync(join(tmpdir(),'af-target-source-')),target=join(parent,'worktree');let charges=0,childRoot='',snapshotTargetId='';
 try{
  execFileSync('git',['worktree','add','--detach',target],{cwd:root,stdio:'pipe'});writeFileSync(join(target,'README.md'),'TARGET SCOUT\n');mkdirSync(join(af,'.pi/agents/personas'),{recursive:true});mkdirSync(join(af,'.ai'));
  writeFileSync(join(af,'.pi/damage-control-rules.yaml'),JSON.stringify({bashToolPatterns:[],zeroAccessPaths:[],readOnlyPaths:[],noDeletePaths:[]}));
  writeFileSync(join(af,'.pi/agents/personas/researcher.md'),readFileSync(join(root,'agents/researcher.md')));writeFileSync(join(af,'.ai/system1.json'),JSON.stringify({version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{watchdog:{mode:'shadow'}}}));
  const binding=resolveSessionRoots(af,{worktree:target});
  const {definition}=harness({sessionDir:()=>join(af,'.pi/agent-sessions/targets',binding.targetId,'sessions/hub'),taskId:()=> 'target-task',processObligations:()=>({open:['acceptance']}),reserveBudget:async()=>{charges++;return {charged:true,operation:'research',owner:'hub'};},effectiveScoutConfig:()=>({model:'test/model',profile:null,tools:['read'],fallback:null,allowlisted:true}),scoutAgent:async(options:any)=>{
   childRoot=options.cwd;const roots=sessionRootsFromEnv()!;snapshotTargetId=roots.targetId;assert.equal(roots.workspaceRoot,af);assert.equal(roots.executionRoot,options.cwd);assert.notEqual(roots.targetId,binding.targetId);assert.equal(options.dataReadRoot,options.cwd);assert.equal(readFileSync(join(options.cwd,'README.md'),'utf8'),'TARGET SCOUT\n');assert.equal(loadSystem1Snapshot(options.cwd).consumers.watchdog.reason,'needs_worktree_consent');assert.ok(options.run.trace.directory.startsWith(af+'/'));return report;
  }});
  await withSessionRoots(binding,async()=>{
   assert.equal((await approveWorktreeScope({consumer:'watchdog',readDocument:()=>readSystem1Document(target),ask:async()=>true})).status,'approved');
   const params={procedure:'scout',request:'Read selected README',invocation_id:'target-scout-1'};const result=await definition.execute('target',params,new AbortController().signal,()=>{},{cwd:target});
   assert.equal(result.details.flowAcceptance.accepted,true,JSON.stringify(result));assert.equal(result.details.parentAcceptance.accepted,false);assert.equal(result.details.snapshot.sourceTargetId,binding.targetId);assert.equal(result.details.snapshot.snapshotTargetId,snapshotTargetId);assert.equal(existsSync(childRoot),false);assert.equal(charges,1);assert.equal(readFileSync(join(root,'README.md'),'utf8'),'baseline\n');assert.equal(readFileSync(join(target,'README.md'),'utf8'),'TARGET SCOUT\n');
   const other=resolveSessionRoots(af,{worktree:root});await withSessionRoots(other,async()=>{const duplicate=await definition.execute('other',params,new AbortController().signal,()=>{},{cwd:root});assert.equal(duplicate.details.status,'stale-duplicate');assert.equal(charges,1);});
  });assert.doesNotMatch(execFileSync('git',['branch','--list'],{cwd:root,encoding:'utf8'}),/flow\//);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(af,{recursive:true,force:true});rmSync(parent,{recursive:true,force:true});}
});

test("T13 run_flow uses exported dispatcher on isolated no-branch snapshot and preserves concurrent source edits", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-")); let charges = 0, childCwd = "", release!: () => void;
	const originalBranch = execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim();
	const gate = new Promise<void>(resolve => { release = resolve; });
	try {
		const { definition } = harness({ sessionDir: () => session, taskId: () => "task-1", processObligations: () => ({ acceptance: "unsupported", open: ["risk"] }), reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; }, effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read", "grep", "find", "ls"], fallback: null, allowlisted: true }), scoutAgent: async (options: any) => { childCwd = options.cwd; assert.equal(options.dataReadRoot, options.cwd); writeFileSync(join(root, "README.md"), "concurrent user edit\n"); await gate; return report; } });
		const signal = new AbortController().signal, ctx = { cwd: root } as any;
		const first = definition.execute("one", { procedure: "scout", request: "Locate README", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		while (!childCwd) await new Promise(resolve => setTimeout(resolve, 5));
		const duplicate = definition.execute("two", { procedure: "scout", request: "Locate README", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		const stale = await definition.execute("stale", { procedure: "scout", request: "Different input", invocation_id: "same-run-1" }, signal, () => {}, ctx);
		assert.equal(stale.details.status, "stale-duplicate"); assert.equal(stale.details.budgetCharged, false);
		release(); const [a, b] = await Promise.all([first, duplicate]);
		assert.equal(a.details.snapshotCleanup.status, "removed"); assert.equal(existsSync(childCwd), false);
		assert.equal(charges, 1); assert.deepEqual(a, b); assert.notEqual(childCwd, root); assert.match(childCwd, /agent-fleet-scout-snapshot-/);
		assert.equal(readFileSync(join(root, "README.md"), "utf8"), "concurrent user edit\n");
		assert.equal(a.details.flowAcceptance.accepted, true); assert.equal(a.details.parentAcceptance.accepted, false); assert.deepEqual(a.details.parentAcceptance.assertionsProven, []);
		assert.equal(a.details.runtimeResult.acceptance.status, "not_accepted"); assert.equal(a.details.runtimeResult.task.id, "task-1"); assert.equal(a.details.runtimeResult.task.current, false); assert.equal(a.details.snapshot.originalRevisionUnchanged, false);
		assert.ok(existsSync(a.details.tracePath)); assert.ok(existsSync(a.details.snapshot.manifestPath));
		assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(), originalBranch);
		assert.doesNotMatch(execFileSync("git", ["branch", "--list"], { cwd: root, encoding: "utf8" }), /flow\//);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});

test("T13 setup/result exceptions settle as structured failures, release ownership, and never reject derivatively", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-"));
	const base = { sessionDir: () => session, taskId: () => "task-failure", processObligations: () => ({}), reserveBudget: async () => ({ charged: true, operation: "research", owner: "hub" }), effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), scoutAgent: async () => report };
	const cases = [
		{ name: "session", override: { sessionDir: () => { throw new Error("session boom"); } }, charged: false, started: false },
		{ name: "revision", override: { worktreeRevision: () => { throw new Error("revision boom"); } }, charged: false, started: false },
		{ name: "budget", override: { reserveBudget: async () => { throw new Error("budget boom"); } }, charged: false, started: false },
		{ name: "runtime", override: { buildRuntimeResult: () => { throw new Error("runtime boom"); } }, charged: true, started: true },
		{ name: "obligations", override: { processObligations: () => { throw new Error("obligations boom"); } }, charged: true, started: true },
	];
	const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", listener);
	try {
		for (const item of cases) {
			const { definition } = harness({ ...base, ...item.override });
			const first = await definition.execute("one", { procedure: "scout", request: item.name, invocation_id: `failure-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.equal(first.details.budgetCharged, item.charged); assert.equal(first.details.executionStarted, item.started); assert.equal(first.details.parentAcceptance.accepted, false);
			const duplicate = await definition.execute("two", { procedure: "scout", request: item.name, invocation_id: `failure-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.deepEqual(duplicate, first);
			const next = await definition.execute("three", { procedure: "scout", request: `${item.name}-next`, invocation_id: `next-${item.name}` }, new AbortController().signal, () => {}, { cwd: root });
			assert.notEqual(next.details.status, "busy");
		}
		await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
	} finally { process.removeListener("unhandledRejection", listener); rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});

test("T13 cancellation is owned by the first Hub invocation and a busy distinct run is not charged", async () => {
	const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-")); let charges = 0, entered!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	try {
		const { definition } = harness({ sessionDir: () => session, taskId: () => "task-2", processObligations: () => ({}), reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; }, effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), scoutAgent: async (options: any) => { entered(); await new Promise((_resolve, reject) => options.run.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); return report; } });
		const controller = new AbortController(); const running = definition.execute("one", { procedure: "scout", request: "Wait", invocation_id: "cancel-run-1" }, controller.signal, () => {}, { cwd: root }); await started;
		const busy = await definition.execute("two", { procedure: "scout", request: "Other", invocation_id: "other-run-2" }, new AbortController().signal, () => {}, { cwd: root }); assert.equal(busy.details.status, "busy"); assert.equal(busy.details.budgetCharged, false);
		controller.abort(); const result = await running; assert.equal(result.details.snapshotCleanup.status, "removed"); assert.equal(charges, 1); assert.equal(result.details.flowAcceptance.accepted, false); assert.equal(result.details.parentAcceptance.accepted, false);
	} finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});


test("snapshot cleanup covers failed setup and budget refusal, and reports removal failure", async () => {
 const root = repo(), session = mkdtempSync(join(tmpdir(), "af-run-flow-session-"));
 const base = { sessionDir: () => session, taskId: () => "cleanup", processObligations: () => ({}), effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), reserveBudget: async () => ({ charged: false, operation: "research", owner: "hub" }) };
 try {
  for (const failSetup of [true, false]) {
   let workspace = "";
   const { definition } = harness({ ...base, createSnapshot: (_root: string, target: string) => { workspace = target; mkdirSync(target); if (failSetup) throw new Error("setup failed"); return {}; } });
   const result = await definition.execute("one", { procedure: "scout", request: "read", invocation_id: `cleanup-${failSetup}` }, new AbortController().signal, () => {}, { cwd: root });
   assert.equal(result.details.status, failSetup ? "snapshot-refused" : "budget-refused");
   assert.equal(result.details.snapshotCleanup.status, "removed"); assert.equal(existsSync(workspace), false);
  }
  let retained = "";
  try {
   const { definition } = harness({ ...base, createSnapshot: () => ({}), removeSnapshot: (path: string) => { retained = path; throw new Error("simulated cleanup denial"); } });
   const result = await definition.execute("one", { procedure: "scout", request: "read", invocation_id: "cleanup-denied" }, new AbortController().signal, () => {}, { cwd: root });
   assert.equal(result.details.status, "budget-refused");
   assert.equal(result.details.snapshotCleanup.status, "failed"); assert.equal(result.details.snapshotCleanup.path, retained);
   assert.ok(existsSync(retained)); assert.match(result.content.map((c: any) => c.text).join("\n"), /cleanup failed.*retained at/);
  } finally { if (retained) rmSync(retained, { recursive: true, force: true }); }
 } finally { rmSync(root, { recursive: true, force: true }); rmSync(session, { recursive: true, force: true }); }
});

/** A workspace like rankedin: a plain folder holding the repositories `rin-docs` and `ringithub`. */
function nestedWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "af-run-flow-nested-"));
	for (const name of ["rin-docs", "ringithub"]) {
		const repo = join(root, name); mkdirSync(repo); writeFileSync(join(repo, "README.md"), `${name} baseline\n`);
		execFileSync("git", ["init", "-q"], { cwd: repo }); execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], { cwd: repo });
	}
	// Fleet resources live at the workspace root, never inside a nested repository.
	mkdirSync(join(root, ".pi/agents/personas"), { recursive: true });
	writeFileSync(join(root, ".pi/damage-control-rules.yaml"), JSON.stringify({ bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [], noDeletePaths: [] }));
	writeFileSync(join(root, ".pi/agents/personas/researcher.md"), "---\nname: researcher\ndescription: read only\ntools: read,grep,find,ls\nmodel: test/model\n---\nScout.\n");
	return root;
}

test("plan 7.5: at a non-Git root, run_flow scouts a snapshot of the one nested repository named by repo", async () => {
	const root = nestedWorkspace(); let charges = 0, configCwd = "", childCwd = "";
	try {
		writeFileSync(join(root, "ringithub", "README.md"), "dirty ringithub\n");
		const { definition } = harness({ sessionDir: () => join(root, ".pi/agent-sessions/sessions/hub"), taskId: () => "nested-task", processObligations: () => ({ open: [] }), nestedRepositories: () => ["rin-docs", "ringithub"],
			reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; },
			effectiveScoutConfig: (cwd: string) => { configCwd = cwd; return { model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }; },
			scoutAgent: async (options: any) => { childCwd = options.cwd; const roots = sessionRootsFromEnv()!; assert.equal(roots.workspaceRoot, root); assert.equal(roots.executionRoot, options.cwd); assert.equal(readFileSync(join(options.cwd, "README.md"), "utf8"), "dirty ringithub\n"); assert.equal(existsSync(join(options.cwd, "rin-docs")), false); assert.ok(options.run.trace.directory.startsWith(`${root}/.pi/`)); return report; } });
		const ctx = { cwd: root } as any, signal = new AbortController().signal;
		const missing = await definition.execute("missing", { procedure: "scout", request: "Where is the API?", invocation_id: "nested-missing" }, signal, () => {}, ctx);
		assert.equal(missing.details.status, "target-refused"); assert.equal(missing.details.budgetCharged, false);
		assert.match(missing.content[0].text, /not a Git repository; pass repo: with the nested repository to scout \(this task uses rin-docs, ringithub\)/);
		for (const repo of ["../outside", "/etc", "missing", "rin-docs,ringithub", ".", "", "r".repeat(513)]) {
			const refused = await definition.execute("bad", { procedure: "scout", request: "Where is the API?", invocation_id: `nested-bad-${charges}-${repo.length}`, repo }, signal, () => {}, ctx);
			assert.equal(refused.details.status, "target-refused", repo); assert.equal(refused.details.budgetCharged, false, repo);
		}
		assert.equal(charges, 0);
		const result = await definition.execute("scout", { procedure: "scout", request: "Where is the API?", invocation_id: "nested-scout-1", repo: "ringithub/" }, signal, () => {}, ctx);
		assert.equal(result.details.flowAcceptance.accepted, true, JSON.stringify(result)); assert.equal(result.details.parentAcceptance.accepted, false);
		assert.equal(result.details.snapshot.repository, "ringithub"); assert.equal(result.details.snapshot.workspaceRoot, root);
		assert.match(result.content[0].text, /Scouted nested repository ringithub; paths in this result are relative to it\./);
		assert.equal(configCwd, root, "scout configuration comes from the workspace root"); assert.equal(charges, 1); assert.equal(existsSync(childCwd), false);
		const other = await definition.execute("other", { procedure: "scout", request: "Where is the API?", invocation_id: "nested-scout-1", repo: "rin-docs" }, signal, () => {}, ctx);
		assert.equal(other.details.status, "stale-duplicate", "one invocation is bound to one repository");
		assert.equal(readFileSync(join(root, "ringithub", "README.md"), "utf8"), "dirty ringithub\n");
		assert.doesNotMatch(execFileSync("git", ["branch", "--list"], { cwd: join(root, "ringithub"), encoding: "utf8" }), /flow\//);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("plan 7.5: repo is refused where the workspace root is itself a repository", async () => {
	const root = repo(); let charges = 0;
	try {
		mkdirSync(join(root, "nested")); execFileSync("git", ["init", "-q"], { cwd: join(root, "nested") });
		const { definition } = harness({ sessionDir: () => join(root, ".pi/agent-sessions/sessions/hub"), taskId: () => "root-task", processObligations: () => ({ open: [] }), reserveBudget: async () => { charges++; return { charged: true, operation: "research", owner: "hub" }; }, effectiveScoutConfig: () => ({ model: "test/model", profile: null, tools: ["read"], fallback: null, allowlisted: true }), scoutAgent: async () => report });
		const refused = await definition.execute("root", { procedure: "scout", request: "Locate README", invocation_id: "root-repo-1", repo: "nested" }, new AbortController().signal, () => {}, { cwd: root } as any);
		assert.equal(refused.details.status, "target-refused"); assert.match(refused.content[0].text, /repo applies only when the workspace root is not a Git repository/); assert.equal(charges, 0);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
