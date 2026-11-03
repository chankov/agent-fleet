import assert from "node:assert/strict";
import test from "node:test";
import { instrumentBash } from "./runtime-test-check.ts";

test("runtime test records the actual guarded operation exit and revisions without parsing output", async () => {
 let calls = 0;
 const factory = (_cwd: string, { operations }: any) => ({ execute: async (_id: string, params: any) => {
  const result = await operations.exec(params.command);
  if (result.exitCode) throw new Error("all green (misleading output)");
  return { content: [{ type: "text", text: "all green" }] };
 } });
 for (const code of [0, 1]) {
  const execute = instrumentBash(factory, { exec: async () => { calls++; return { exitCode: code }; } }, "/fixture", () => "revision");
  const result = await execute("id", { command: "node --test semantic.test.js" }, undefined, undefined);
  assert.equal(result.details.runtimeTest.exitCode, code);
  assert.equal(result.details.runtimeTest.beforeRevision, "revision");
  assert.equal(result.details.runtimeTest.afterRevision, "revision");
 }
 assert.equal(calls, 2);
});

test("unexecuted or interrupted bash creates no success evidence", async () => {
 const execute = instrumentBash(() => ({ execute: async () => { throw new Error("denied"); } }), {}, "/fixture", () => "revision");
 await assert.rejects(() => execute("id", { command: "node --test" }, undefined, undefined), /denied/);
});

test("transport rejects disabled, unmatched, and untrusted result-shaped claims", async () => {
 const { runtimeTestFromResult } = await import("./runtime-test-check.ts");
 const record = { producer: "agent-fleet.runtime-test/v1", command: "node --test", exitCode: 0, beforeRevision: "revision", afterRevision: "revision" };
 const result = { details: { runtimeTest: record } };
 assert.deepEqual(runtimeTestFromResult(true, record.command, "bash", result), record);
 assert.equal(runtimeTestFromResult(false, record.command, "bash", result), null);
 assert.equal(runtimeTestFromResult(true, undefined, "bash", result), null);
 assert.equal(runtimeTestFromResult(true, "echo success", "bash", result), null);
 assert.equal(runtimeTestFromResult(true, record.command, "write", result), null);
 assert.equal(runtimeTestFromResult(true, record.command, "bash", { details: { runtimeTest: { ...record, producer: "specialist" } } }), null);
});

test("observer forwards execution context and tool options", async () => {
 const ctx = { model: { id: "configured" } }; let seen: any;
 const execute = instrumentBash((_cwd: string, options: any) => ({ execute: async (...args: any[]) => { seen = { ctx: args[4], options }; return { content: [] }; } }), {}, "/fixture", () => "r", { commandPrefix: "setup", shellPath: "/configured/shell" });
 await execute("id", { command: "true" }, undefined, undefined, ctx);
 assert.equal(seen.ctx, ctx); assert.equal(seen.options.shellPath, "/configured/shell"); assert.equal(seen.options.commandPrefix, "setup");
});

test("real agent-core event transport preserves bash failure and repeated-failure terminal safeguard", async () => {
 const { realpathSync } = await import("node:fs");
 const { dirname, join } = await import("node:path");
 const cli = realpathSync("node_modules/.bin/pi");
 const api = await import(join(dirname(cli), "index.js"));
 // Pi 1.1 hoists agent-core beside the coding agent instead of nesting it in its package.
 const { agentLoop } = await import("@earendil-works/pi-agent-core");
 const { createDriftMonitor } = await import("./drift-watchdog.js");
 const { registerObservedBash } = await import("./runtime-test-check.ts");
 let tool: any, hook: any;
 registerObservedBash({ registerTool: (t: any) => tool = t, on: (name: string, fn: any) => { if (name === "tool_result") hook = fn; } }, api, process.cwd(), {});
 assert.equal(typeof tool.renderCall, "function"); assert.equal(typeof tool.renderResult, "function");
 const monitor = createDriftMonitor({}); let trips: any[] = []; let turns = 0; const ends: any[] = [];
 const streamFn = () => {
  const message = { role: "assistant", content: turns++ < 5 ? [{ type: "toolCall", id: `b${turns}`, name: "bash", arguments: { command: "exit 7" } }] : [], stopReason: turns <= 5 ? "toolUse" : "stop", api: "test", provider: "test", model: "test", timestamp: 0, usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } } };
  return { async *[Symbol.asyncIterator]() {}, result: async () => message };
 };
 const events = agentLoop([{ role: "user", content: "fixture", timestamp: 0 }], { systemPrompt: "", messages: [], tools: [tool] }, {
  model: { id: "fixture", api: "test", provider: "test" }, convertToLlm: (m: any) => m,
  afterToolCall: ({ toolCall, result, isError }: any) => hook?.({ toolName: toolCall.name, toolCallId: toolCall.id, ...result, isError }),
 }, undefined, streamFn);
 for await (const event of events) if (event.type === "tool_execution_end") { ends.push(event); const trip = monitor.onToolEnd(event.toolName, event.isError); if (trip) trips.push(trip); }
 assert.equal(ends.length, 5);
 for (const end of ends) { assert.equal(end.isError, true); assert.equal(end.result.details.runtimeTest.exitCode, 7); }
 assert.ok(trips.some(t => t.rule === "failures" && t.terminal));
});

test('matched native unknown/missing result emits invalidation even though success parser rejects it', async () => {
 const { runtimeTestFromResult, runtimeTestObservationFromResult } = await import('./runtime-test-check.ts');
 for (const result of [undefined, {}, { details: { runtimeTest: { producer: 'agent-fleet.runtime-test/v1', command: 'exact', exitCode: null } } }, { details: { runtimeTest: { producer: 'specialist', command: 'exact', exitCode: 0 } } }]) {
  assert.equal(runtimeTestFromResult(true, 'exact', 'bash', result), null);
  assert.deepEqual(runtimeTestObservationFromResult(true, 'exact', 'bash', result), { producer: 'agent-fleet.runtime-test/v1', command: 'exact', exitCode: null, beforeRevision: 'unavailable', afterRevision: 'unavailable' });
 }
 assert.equal(runtimeTestObservationFromResult(false, 'exact', 'bash', {}), null);
 assert.equal(runtimeTestObservationFromResult(true, undefined, 'bash', {}), null);
 assert.equal(runtimeTestObservationFromResult(true, 'exact', 'write', {}), null);
});

test('native event transport retains unknown end and unfinished bash invalidations (offline fake Pi only)', async t => {
 const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { spawnPiAgent } = await import('./spawn.ts');
 const dir = mkdtempSync(join(tmpdir(), 'runtime-event-fixture-')); t.after(() => rmSync(dir, {recursive:true,force:true}));
 const events = [
  {type:'tool_execution_start',toolName:'bash',toolCallId:'known',args:{command:'test-exact'}},
  {type:'tool_execution_end',toolName:'bash',toolCallId:'known',result:{details:{runtimeTest:{producer:'agent-fleet.runtime-test/v1',command:'test-exact',exitCode:0,beforeRevision:'a'.repeat(64),afterRevision:'a'.repeat(64)}}}},
  {type:'tool_execution_start',toolName:'bash',toolCallId:'unknown',args:{command:'test-exact'}},
  {type:'tool_execution_end',toolName:'bash',toolCallId:'unknown',result:{content:[{type:'text',text:'guard timeout; not success'}]}},
  {type:'tool_execution_start',toolName:'bash',toolCallId:'unfinished',args:{command:'compile-exact'}},
  {type:'tool_execution_start',toolName:'write',toolCallId:'overlap',args:{path:'a.ts'}},
  {type:'tool_execution_end',toolName:'write',toolCallId:'overlap',result:{}},
 ];
 writeFileSync(join(dir,'pi'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});\n`, {mode:0o755});
 const result = await spawnPiAgent({ model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline fixture',sessionFile:join(dir,'fixture.json'),prompt:'fixture',cwd:dir,env:{PATH:`${dir}:${process.env.PATH ?? ''}`},runtimeTestObserver:true });
 assert.equal(result.exitCode,0);
 assert.deepEqual(result.runtimeTests.map(r=>[r.command,r.exitCode]),[['test-exact',0],['test-exact',null],['compile-exact',null]]);
 assert.ok(result.runtimeTests[0].startedAt <= result.runtimeTests[0].finishedAt);
 assert.equal(result.runtimeTests[0].exclusive,false, "actual child overlap invalidates earlier capture exclusivity");
});

export async function offlineEventChecks(events: any[], dir: string) {
 const { writeFileSync } = await import('node:fs'); const { join } = await import('node:path');
 const { spawnPiAgent } = await import('./spawn.ts');
 writeFileSync(join(dir,'pi'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(events.map(e=>JSON.stringify(e)).join('\n')+'\n')});\n`, {mode:0o755});
 return spawnPiAgent({model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline',sessionFile:join(dir,'session.json'),prompt:'fixture',cwd:dir,env:{PATH:`${dir}:${process.env.PATH ?? ''}`},runtimeTestObserver:true});
}
for (const scenario of [
 { name: 'separate assistant messages', messages: [['…without another test run.'], ['**Verdict:** APPROVE.']], output: '…without another test run.\n**Verdict:** APPROVE.', approve: true },
 { name: 'mid-line verdict within one message', messages: [['…without another test run.', '**Verdict:** APPROVE.']], output: '…without another test run.**Verdict:** APPROVE.', approve: false },
 { name: 'intra-message delta bytes', messages: [['  α\r\n', 'text\t', '', 'tail  ']], output: '  α\r\ntext\ttail  ', approve: false },
 { name: 'existing newline at message boundary', messages: [['…without another test run.\n'], ['**Verdict:** APPROVE.']], output: '…without another test run.\n**Verdict:** APPROVE.', approve: true },
 { name: 'empty final delta preserves boundary newline', messages: [['text\n', ''], ['tail']], output: 'text\ntail', approve: false },
 { name: 'empty messages add no extra separators', messages: [[], ['text'], [], ['tail'], []], output: 'text\ntail', approve: false },
]) test(`assistant output preserves ${scenario.name}`, async t => {
 const { mkdtempSync, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
 const { affirmativeReviewVerdict } = await import('./review-verdict.ts');
 const dir = mkdtempSync(join(tmpdir(), 'verdict-seam-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const events = scenario.messages.flatMap(deltas => [
  ...deltas.map(delta => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })),
  { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } },
 ]);
 const result = await offlineEventChecks(events, dir);
 assert.equal(result.exitCode, 0);
 assert.equal(result.output, scenario.output, 'only missing inter-message newlines may be inserted');
 if (scenario.name === 'separate assistant messages') assert.ok(result.output.includes('run.\n**Verdict:** APPROVE'));
 assert.equal(affirmativeReviewVerdict(result.output), scenario.approve);
});

export function temporalEvents(command = 'test-exact', revision = 'a'.repeat(64), overlap?: string) {
 const start=(id:string,name:string)=>({type:'tool_execution_start',toolName:name,toolCallId:id,args:{command}});
 const end=(id:string,name:string)=>({type:'tool_execution_end',toolName:name,toolCallId:id,result:name==='bash'?{details:{runtimeTest:{producer:'agent-fleet.runtime-test/v1',command,exitCode:0,beforeRevision:revision,afterRevision:revision}}}:{}});
 const reads=(prefix:string)=>[start(prefix+'r','read'),start(prefix+'g','grep'),start(prefix+'f','find'),start(prefix+'l','ls'),end(prefix+'r','read'),end(prefix+'g','grep'),end(prefix+'f','find'),end(prefix+'l','ls')];
 return [...reads('before'),start('b1','bash'),...(overlap?[start('other',overlap)]:[]),end('b1','bash'),...(overlap?[end('other',overlap)]:[]),...reads('between'),start('b2','bash'),end('b2','bash'),...reads('after')];
}
test('parallel capabilities before/between/after serial checks do not poison attribution', async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'temporal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=await offlineEventChecks(temporalEvents(),dir);
 assert.equal(result.runtimeTests.length,2);
 for(const record of result.runtimeTests){assert.notEqual(record.exclusive,false);assert.ok(record.startedAt<=record.finishedAt);}
});
for(const tool of ['read','grep','find','ls','write','edit','bash','unknown']) test(`actual ${tool} overlap taints intersecting check only`,async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'temporal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=await offlineEventChecks(temporalEvents('test-exact','a'.repeat(64),tool),dir);
 assert.equal(result.runtimeTests[0].exclusive,false);
 assert.notEqual(result.runtimeTests.at(-1).exclusive,false);
});

for(const scenario of ['end-before-start','duplicate-start','reused-id','missing-end','missing-id','non-string-id','mismatched-name','malformed-bash'] as const) test(`malformed native interval ${scenario} fails closed`,async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'interval-negative-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const start:any={type:'tool_execution_start',toolName:'read',toolCallId:'broken',args:{}};
 const end:any={type:'tool_execution_end',toolName:'read',toolCallId:'broken',result:{}};
 const malformed:Record<string,any[]>={
  'end-before-start':[end,start,end], 'duplicate-start':[start,start,end], 'reused-id':[start,end,start,end],
  'missing-end':[start], 'missing-id':[{...start,toolCallId:undefined}], 'non-string-id':[{...start,toolCallId:42}],
  'mismatched-name':[start,{...end,toolName:'grep'}], 'malformed-bash':[{...start,toolName:'bash'}, {...end,toolName:'bash'}],
 };
 const events=temporalEvents();
 const result=await offlineEventChecks([...events,...malformed[scenario]],dir);
 assert.equal(result.exitCode,0);
 assert.ok(result.runtimeTests.length>=2);
 for(const record of result.runtimeTests) assert.equal(record.exclusive,false,scenario);
});

test('native capture integrity is explicit with no completed runtime checks', async t=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'empty-capture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 for(const events of [[],[{type:'tool_execution_start',toolName:'read',toolCallId:'lost',args:{}}],[{type:'tool_execution_end',toolName:'bash',toolCallId:'orphan',result:{}}]]){
  const result=await offlineEventChecks(events,dir);
  assert.deepEqual(result.runtimeTests,[],'integrity must not fabricate a test observation');
  assert.equal(result.lifecycle.runtimeCaptureIntegrity,events.length?'tainted':'complete');
 }
});

for(const scenario of ['all-non-json','garbage-between-events','unterminated-trailing-garbage'] as const) test(`unparseable native stream line taints capture integrity: ${scenario} (offline fake Pi only)`, async t=>{
 const {mkdtempSync,rmSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const { spawnPiAgent } = await import('./spawn.ts');
 const dir=mkdtempSync(join(tmpdir(),'non-json-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const events=temporalEvents().map(e=>JSON.stringify(e));
 const raw:Record<typeof scenario,string>={
  'all-non-json':'Warning: not an event\nstill not json\n',
  'garbage-between-events':[...events.slice(0,9),'{"type":"tool_execution_end","toolName":"bash","toolCallId":"b1",',...events.slice(9)].join('\n')+'\n',
  'unterminated-trailing-garbage':events.join('\n')+'\n{"type":"tool_execution_sta',
 };
 writeFileSync(join(dir,'pi'),`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(raw[scenario])});\n`,{mode:0o755});
 const result=await spawnPiAgent({model:'fake/offline',tools:'bash',thinking:'off',systemPrompt:'offline',sessionFile:join(dir,'session.json'),prompt:'fixture',cwd:dir,env:{PATH:`${dir}:${process.env.PATH ?? ''}`},runtimeTestObserver:true});
 assert.equal(result.exitCode,0);
 assert.equal(result.lifecycle.runtimeCaptureIntegrity,'tainted',scenario);
 for(const record of result.runtimeTests) assert.equal(record.exclusive,false,scenario);
 if(scenario==='all-non-json') assert.deepEqual(result.runtimeTests,[],'no fabricated observation');
});
