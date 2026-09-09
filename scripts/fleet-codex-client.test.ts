import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { FleetSessionClient } from "./lib/fleet-codex-session.ts";
import type { RegistryEntry } from "./lib/coms-envelope.ts";

const chatA = "01a07f9f-e6a8-72f1-b05b-4611a5ddfdd0";
const chatB = "01a07f9f-e6a8-72f1-b05b-4611a5ddfdd1";
const now = Date.now();
function peer(name = "orchestrator", id = "session-one"): RegistryEntry {
 return { name, session_id: id, purpose: "Review code", model: "test", cwd: "/repo", started_at: new Date(now - 1000).toISOString(), heartbeat_at: new Date(now).toISOString(), pid: 123, endpoint: "/private/secret.sock", color: "red", explicit: false, version: 1 };
}
function fixture(t: TestContext) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-client-test-"));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const entries: Record<string, RegistryEntry[]> = { af: [peer()], other: [peer("orchestrator", "other-session")] };
 const client = (id: string | undefined = chatA) => new FleetSessionClient({ stateDir: path.join(dir, "state"), clientId: id, readRegistry: p => entries[p] ?? [], now: () => now });
 return { dir, entries, client };
}
test("selection persists per chat/project and detach leaves other chat and registry intact", t => {
 const f = fixture(t); const before = JSON.stringify(f.entries);
 assert.equal(f.client().select("af", "orchestrator").status, "available");
 f.client(chatB).select("other", "orchestrator");
 assert.equal(f.client().status().binding?.project, "af");
 assert.equal(f.client(chatB).status().binding?.project, "other");
 f.client().detach();
 assert.equal(f.client().status().status, "unbound");
 assert.equal(f.client(chatB).status().status, "available");
 assert.equal(JSON.stringify(f.entries), before);
});
test("peer restart marks old binding stale and never silently adopts replacement", t => {
 const f = fixture(t); f.client().select("af", "orchestrator");
 f.entries.af = [peer("orchestrator", "replacement")];
 assert.equal(f.client().status().status, "stale");
 assert.equal(f.client().status().binding?.sessionId, "session-one");
 f.client().select("af", "orchestrator");
 assert.equal(f.client().status().binding?.sessionId, "replacement");
});
test("missing/expired/ambiguous target refuses select without replacing current binding", t => {
 const f = fixture(t); f.client().select("af", "orchestrator");
 f.entries.other[0].heartbeat_at = new Date(0).toISOString();
 assert.throws(() => f.client().select("other", "orchestrator"), /unavailable/);
 f.entries.af.push(peer());
 assert.throws(() => f.client().select("af", "orchestrator"), /ambiguous/);
 f.entries.af = [];
 assert.equal(f.client().status().status, "unavailable");
});
test("expired heartbeat is unavailable even with a live-looking PID", t => {
 const f = fixture(t); f.client().select("af", "orchestrator");
 f.entries.af[0].heartbeat_at = new Date(0).toISOString();
 f.entries.af[0].pid = process.pid;
 assert.equal(f.client().status().status, "unavailable");
});
test("missing identity permits discovery only; unsafe inputs cannot create bindings", t => {
 const f = fixture(t);
 const c = new FleetSessionClient({stateDir: path.join(f.dir, "none"), readRegistry: () => [peer()]});
 assert.equal(c.sessions("af").sessions.length, 1);
 assert.throws(() => c.select("af", "orchestrator"), /CODEX_THREAD_ID/);
 assert.throws(() => f.client("../../x").status(), /CODEX_THREAD_ID/);
 assert.throws(() => f.client().sessions("../bad"), /project/i);
 assert.throws(() => f.client().select("af", "../bad"), /name/i);
});
test("public discovery excludes endpoints/PIDs and cannot select malformed identities", t => {
 const f = fixture(t);
 const text = JSON.stringify(f.client().sessions("af"));
 assert.ok(!text.includes("secret.sock")); assert.ok(!text.includes('"pid"'));
 f.entries.af[0].session_id = "";
 assert.throws(() => f.client().select("af", "orchestrator"), /unavailable/);
});
test("private state rejects symlink/corrupt/foreign-client bindings", t => {
 const f = fixture(t); f.client().select("af", "orchestrator");
 const state = path.join(f.dir, "state"); const file = path.join(state, fs.readdirSync(state)[0]);
 assert.equal(fs.statSync(file).mode & 0o777, 0o600);
 assert.equal(fs.statSync(state).mode & 0o777, 0o700);
 const saved = JSON.parse(fs.readFileSync(file, "utf8"));
 fs.writeFileSync(file, JSON.stringify({...saved, clientId:chatB}));
 assert.throws(() => f.client().status(), /invalid binding/);
 fs.writeFileSync(file, "{broken");
 assert.throws(() => f.client().status(), /invalid binding/);
 fs.unlinkSync(file); fs.symlinkSync(path.join(f.dir,"outside"),file);
 assert.throws(() => f.client().select("af","orchestrator"), /unsafe/);
});
test("CLI help is side effect free and invalid operations fail as JSON", t => {
 const f = fixture(t); const cli = path.resolve("scripts/fleet-codex-client.ts");
 const env = {...process.env, CODEX_THREAD_ID: chatA};
 const help = spawnSync(process.execPath,[cli,"--help"],{encoding:"utf8",env});
 assert.equal(help.status,0,help.stderr); assert.ok(help.stdout.includes("sessions"));
 const bad = spawnSync(process.execPath,[cli,"send","--state-dir",path.join(f.dir,"state")],{encoding:"utf8",env});
 assert.equal(bad.status,1); assert.ok(JSON.parse(bad.stdout).error);
 assert.equal(fs.existsSync(path.join(f.dir,"state")),false);
});

test("CLI send refuses a symlink text-file without following it", t => {
 const f = fixture(t); const cli = path.resolve("scripts/fleet-codex-client.ts");
 const env = {...process.env, CODEX_THREAD_ID: chatA};
 const secret = path.join(f.dir, "secret.txt");
 fs.writeFileSync(secret, "SECRET", {mode: 0o600});
 fs.chmodSync(secret, 0o600);
 const link = path.join(f.dir, "instruction.txt");
 fs.symlinkSync(secret, link);
 const result = spawnSync(process.execPath, [cli, "send", "--id", "task-1", "--text-file", link, "--state-dir", path.join(f.dir, "state")], {encoding: "utf8", env});
 assert.equal(result.status, 1, result.stdout + result.stderr);
 assert.match(JSON.parse(result.stdout).error, /unsafe text file/);
});

test("private directory and concurrent mutation are refused without changing selection", t => {
 const f = fixture(t); f.client().select("af", "orchestrator");
 const state = path.join(f.dir,"state"); const file = path.join(state,fs.readdirSync(state)[0]);
 fs.writeFileSync(file+".lock", "owned by another operation");
 assert.throws(() => f.client().detach(), /EEXIST/);
 assert.equal(f.client().status().binding?.project,"af");
 fs.unlinkSync(file+".lock"); fs.chmodSync(state,0o755);
 assert.throws(() => f.client().status(), /unsafe/);
 fs.chmodSync(state,0o700);
});
test("CLI selects from real registry fixtures and restores on a new invocation", t => {
 const f = fixture(t); const piDir = path.join(f.dir,"pi");
 const registry = path.join(piDir,"coms","projects","af","agents");
 fs.mkdirSync(registry,{recursive:true}); fs.writeFileSync(path.join(registry,"orchestrator.json"),JSON.stringify(peer()));
 const cli = path.resolve("scripts/fleet-codex-client.ts");
 const env = {...process.env,HOME:f.dir,PI_COMS_DIR:path.join(f.dir,".pi","coms"),CODEX_THREAD_ID:chatA};
 const invoke = (args: string[]) => spawnSync(process.execPath,[cli,...args,"--state-dir",path.join(f.dir,"state")],{encoding:"utf8",env});
 // coms root follows os.homedir(), which is HOME on this runtime.
 fs.renameSync(piDir,path.join(f.dir,".pi"));
 const select = invoke(["select","--project","af","--peer","orchestrator"]);
 assert.equal(select.status,0,select.stdout+select.stderr);
 assert.equal(JSON.parse(invoke(["status"]).stdout).binding.sessionId,"session-one");
 assert.equal(JSON.parse(invoke(["detach"]).stdout).status,"unbound");
 assert.ok(fs.existsSync(path.join(f.dir,".pi","coms","projects","af","agents","orchestrator.json")));
});

test("durable command IDs suppress repeats after restart and reject changed text", async t => {
 const f = fixture(t); f.client().select('af','orchestrator');
 let sends = 0;
 const { FleetClientOperations } = await import('./lib/fleet-codex-operations.ts');
 const ops = () => new FleetClientOperations(f.client(), {read:async () => ({pane:{paneId:'p',state:'idle'},cursor:{},activity:{},monitor:{}}), send:async (_e,_project,_p,_i,_text,_w,ack) => {sends++; ack('submitted'); return {state:'result',result:'BLUE'};}});
 assert.equal((await ops().send('color-1','BLUE',100)).state,'result');
 assert.equal((await ops().send('color-1','BLUE',100)).state,'result');
 assert.equal(sends,1);
 await assert.rejects(ops().send('color-1','RED',100), /different/);
});
test("uncertain send is durable and never retried; stale target never sends", async t => {
 const f=fixture(t); f.client().select('af','orchestrator'); let sends=0;
 const { FleetClientOperations }=await import('./lib/fleet-codex-operations.ts');
 const ops=new FleetClientOperations(f.client(),{read:async()=>({pane:{paneId:'p',state:'working'},cursor:{}}),send:async()=>{sends++;throw Error('timeout');}});
 assert.equal((await ops.send('one','work',100)).state,'unknown');
 assert.equal((await ops.send('one','work',100)).state,'unknown'); assert.equal(sends,1);
 f.entries.af=[peer('orchestrator','replacement')];
 await assert.rejects(ops.send('two','work',100),/stale/); assert.equal(sends,1);
});
test("resync persists scoped cursors and replay survives a lost tool response",async t=>{
 const f=fixture(t);f.client().select('af','orchestrator'); const seen:unknown[]=[];
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 const ops=()=>new FleetClientOperations(f.client(),{read:async(_e,_p,cursor)=>{seen.push(cursor);return {pane:{paneId:'p',state:'idle'},cursor:{n:3},activity:{current:{detail:'BLUE'}},monitor:{tasks:[]}};}});
 await ops().resync();await ops().resync();assert.deepEqual(seen,[{}, {n:3}]);
 assert.equal((await ops().replay()).activity.current.detail,'BLUE');
 f.client().select('other','orchestrator');await ops().resync();assert.deepEqual(seen[2],{});
});

test('send lock blocks detach, stale reads are discarded, receipts stay inspectable offline', async t=>{
 const f=fixture(t);f.client().select('af','orchestrator');
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 const ops=new FleetClientOperations(f.client(),{read:async()=>({cursor:{},pane:{paneId:'p',state:'idle'}}),send:async()=>{assert.throws(()=>f.client().detach(),/EEXIST/);return {state:'submitted'};}});
 await ops.send('one','work',100);await ops.resync();f.entries.af=[];
 assert.equal((await ops.receipts()).receipts[0].state,'submitted');assert.equal((await ops.replay()).replayed,true);
 f.entries.af=[peer()];
 const changing=new FleetClientOperations(f.client(),{read:async()=>{f.entries.af=[peer('orchestrator','other')];return {cursor:{bad:99}};}});
 await assert.rejects(changing.resync(),/target changed/);
 assert.deepEqual((await ops.replay()).cursor,{});
});

test('resync resolves only the recorded wire reply and never substitutes another task',async t=>{
 const f=fixture(t);f.client().select('af','orchestrator');
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 let refs:string[]=[];
 const ops=new FleetClientOperations(f.client(),{read:async(_e,_p,_c,_w,pending)=>{refs=pending??[];return {cursor:{},pane:{paneId:'p',state:'idle'},replies:refs.length?[{wireId:'alien',state:'result',result:'RED',truncated:false},{wireId:refs[0],state:'result',result:'BLUE',truncated:false}]:[]};},send:async()=>({state:'queued'})});
 const first=await ops.send('one','work',100);assert.ok(first.wireId);assert.equal(first.state,'queued');
 await ops.resync();assert.deepEqual(refs,[first.wireId]);assert.equal((await ops.receipts()).receipts[0].result,'BLUE');
});

test('CLI executes when invoked through a symlink or macOS /tmp alias',t=>{
 const f=fixture(t);const link=path.join(f.dir,'client.ts');fs.symlinkSync(path.resolve('scripts/fleet-codex-client.ts'),link);
 const r=spawnSync(process.execPath,[link,'--help'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout).usage.includes('status'));
});

test('addressed answers persist before transport; duplicate IDs never repeat and late receipts recover by exact question and request',async t=>{
	const f=fixture(t); f.client().select('af','orchestrator');
	const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
	let calls=0; let wire='';
	const ops=new FleetClientOperations(f.client(),{question:async(_e,_p,r)=>{
		if(r.operation==='list')return {status:'available',questions:[],resolved:[{id:'question-one',requestId:wire,state:'answered'}]};
		calls++;wire=r.msg_id;
		const pending=(await ops.receipts()).questionReceipts[0];
		assert.equal(pending.status,'unknown');
		throw Error('lost reply');
	}});
	assert.equal((await ops.answerQuestion('answer-one','question-one',{kind:'freeform',text:'BG'})).status,'unknown');
	assert.equal((await ops.answerQuestion('answer-one','question-one',{kind:'freeform',text:'BG'})).status,'unknown');
	assert.equal(calls,1);
	await assert.rejects(ops.answerQuestion('answer-one','question-one',null),/different/);
	await ops.status();
	assert.equal((await ops.receipts()).questionReceipts[0].status,'accepted');
});

test('question reads do not resolve another question receipt and stale owners refuse writes',async t=>{
	const f=fixture(t);f.client().select('af','orchestrator');
	const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
	let wire='';
	const ops=new FleetClientOperations(f.client(),{question:async(_e,_p,r)=>{
		if(r.operation==='list')return {status:'available',questions:[],resolved:[{id:'different',requestId:wire,state:'answered'}]};
		wire=r.msg_id;return {status:'unknown'};
	}});
	await ops.answerQuestion('one','q',null);await ops.status();
	assert.equal((await ops.receipts()).questionReceipts[0].status,'unknown');
	f.entries.af=[peer('orchestrator','replacement')];
	await assert.rejects(ops.answerQuestion('two','q',null),/stale/);
});

test('status and resync discover pending questions; subsequent samples retain them without repeating new IDs',async t=>{
	const f=fixture(t);f.client().select('af','orchestrator');
	const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
	const pending={id:'q1',toolCallId:'tool',question:'Language?',options:[{title:'BG'}],allowMultiple:false,allowFreeform:true,allowComment:false};
	let calls=0;let current=[pending];
	const ops=()=>new FleetClientOperations(f.client(),{read:async()=>({cursor:{seq:1},partial:false}),
		question:async()=>{calls++;return {status:'available',questions:current,resolved:[],partial:false,nextCursor:null};}});
	const first=await ops().status();
	assert.equal(first.status,'available');assert.equal((first.questionState.questions[0] as {id:string}).id,'q1');
	assert.deepEqual(first.questionState.newQuestionIds,['q1']);
	const next=await ops().resync();
	assert.deepEqual(next.questionState.newQuestionIds,[]);assert.equal(next.questionState.questions.length,1);
	assert.equal(((await ops().replay()).questionState.questions[0] as {id:string}).id,'q1');
	current=[];assert.deepEqual((await ops().resync()).questionState.questions,[]);
	assert.equal(calls,3);
});

test('question and transcript failures are independent and never erase available evidence',async t=>{
	const f=fixture(t);f.client().select('af','orchestrator');
	const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
	const a=new FleetClientOperations(f.client(),{read:async()=>{throw Error('Python unavailable');},
		question:async()=>({status:'available',questions:[{id:'q'}],resolved:[]})});
	const report=await a.resync();assert.equal((report.questionState.questions[0] as {id:string}).id,'q');assert.equal(report.partial,true);
	assert.equal(report.activity.available,false);
	const b=new FleetClientOperations(f.client(),{read:async()=>({cursor:{},activity:{current:{detail:'progress'}}}),question:async()=>{throw Error('socket lost');}});
	const next=await b.resync();assert.equal(next.activity.current.detail,'progress');assert.equal(next.questionState.status,'unavailable');
	assert.deepEqual(next.questionState.questions,[]);
});

test('automatic question reads are paginated but bounded and preserve unsupported legacy status',async t=>{
	const f=fixture(t);f.client().select('af','orchestrator');
	const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
	const seen:string[]=[];
	const ops=new FleetClientOperations(f.client(),{question:async(_e,_p,r)=>{
		seen.push(r.after??'');const id=`q${seen.length}`;
		return {status:'available',questions:[{id}],resolved:[],partial:true,nextCursor:id};
	}});
	const result=await ops.status();assert.equal(seen.length,4);assert.equal(result.questionState.questions.length,4);
	assert.equal(result.questionState.nextCursor,'q4');assert.equal(result.questionState.partial,true);
	const legacy=new FleetClientOperations(f.client(),{question:async()=>({status:'unsupported'})});
	assert.equal((await legacy.status()).questionState.status,'unsupported');
	f.client().detach();assert.equal((await legacy.status()).questionState.status,'unavailable');
});


test('question observations are isolated by chat and replacement target',async t=>{
 const f=fixture(t);f.client().select('af','orchestrator');f.client(chatB).select('af','orchestrator');
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 const adapters={question:async()=>({status:'available',questions:[{id:'same-id'}],resolved:[]})};
 const a=new FleetClientOperations(f.client(),adapters);const b=new FleetClientOperations(f.client(chatB),adapters);
 assert.deepEqual((await a.status()).questionState.newQuestionIds,['same-id']);
 assert.deepEqual((await b.status()).questionState.newQuestionIds,['same-id']);
 assert.deepEqual((await a.status()).questionState.newQuestionIds,[]);
 f.client().select('other','orchestrator');
 assert.deepEqual((await a.status()).questionState.newQuestionIds,['same-id']);
 assert.deepEqual((await b.status()).questionState.newQuestionIds,[]);
});

test('catalog drives help and CLI argument validation without needing a chat identity',async()=>{
 const {runClient}=await import('./fleet-codex-client.ts');
 const help:any=await runClient(['--help'],{});
 assert.equal(help.schemaVersion,1);
 assert.equal(help.operations.length,16);
 assert.deepEqual(help.usage,help.operations.map((o:any)=>o.usage));
 for(const op of help.operations){
  assert.ok(op.description);assert.ok(op.inputSchema);assert.ok(op.effects);assert.ok(op.requirements.length);
  await assert.rejects(runClient([op.name,'--alien','value'],{}),/Invalid/);
  for(const flag of op.inputSchema.required)assert.ok(op.inputSchema.properties[flag]);
 }
 await assert.rejects(runClient(['watch','--seconds','0'],{}),/seconds/);
 const description:any=await runClient(['describe'],{});
 assert.equal(description.operations.find((o:any)=>o.name==='send').availability.status,'unavailable');
 assert.equal(description.operations.find((o:any)=>o.name==='describe').availability.status,'available');
});

test('describe probes capabilities independently without writing state or invoking mutations',async t=>{
 const f=fixture(t);f.client().select('af','orchestrator');
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 let questions=0;let reads=0;let probes=0;
 const ops=new FleetClientOperations(f.client(),{
  read:async()=>{reads++;return {cursor:{},activity:{available:true},monitor:{available:false},partial:true};},
  question:async(_e,_p,r)=>{questions++;assert.equal(r.operation,'list');return {status:'unsupported',reason:'legacy wrapper'};},
  probe:async()=>{probes++;return {status:'unavailable',reason:'no matching visible pane'};},
  send:async()=>{assert.fail('describe must not send');},
 });
 const before=f.client().readRuntime().raw;
 const d=await ops.describe();const operation=(n:string)=>d.operations.find(o=>o.name===n)!;
 assert.equal(operation('send').availability.status,'unavailable');
 assert.equal(operation('answer').availability.status,'unsupported');
 assert.equal(operation('questions').availability.reason,'legacy wrapper');
 assert.equal(operation('summary').availability.status,'available');
 assert.equal(operation('replay').availability.status,'unavailable');
 assert.equal(f.client().readRuntime().raw,before);assert.deepEqual([questions,reads,probes],[1,1,1]);
 f.entries.af=[peer('orchestrator','replacement')];
 const stale=await ops.describe();assert.equal(stale.operations.find(o=>o.name==='send')!.availability.status,'unavailable');
 assert.deepEqual([questions,reads,probes],[1,1,1]);
});

test('describe reports failed probes and target replacement without claiming ready writes',async t=>{
 const f=fixture(t);f.client().select('af','orchestrator');
 const {FleetClientOperations}=await import('./lib/fleet-codex-operations.ts');
 const failing=async()=>{throw Error('missing adapter');};
 const failed=await new FleetClientOperations(f.client(),{read:failing,question:failing,probe:failing}).describe();
 for(const name of ['summary','send','questions','answer'])assert.equal(failed.operations.find(o=>o.name===name)!.availability.status,'unavailable');
 const changed=await new FleetClientOperations(f.client(),{
  read:async()=>({cursor:{},activity:{available:true}}),question:async()=>({status:'available',questions:[],resolved:[]}),
  probe:async()=>{f.entries.af=[peer('orchestrator','replaced')];return {status:'available',reason:'ping'};},
 }).describe();
 for(const name of ['summary','send','questions','answer'])assert.match(changed.operations.find(o=>o.name===name)!.availability.reason,/target changed/);
});
