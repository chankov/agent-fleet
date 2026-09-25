import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo=fileURLToPath(new URL('../../..',import.meta.url));
const hub=join(repo,'.pi/harnesses/agent-hub');
const pi=join(repo,'node_modules/.bin/pi');

test('P13 real local Pi code/text -> production capture/runtime/assessment/feedback; off and local-only isolation', {timeout:90000}, async t=>{
 assert.match(spawnSync(pi,['--version'],{encoding:'utf8'}).stdout,/^0\.84\.2/);
 for(const variant of ['off','local','advisory','text'] as const){
  const dir=mkdtempSync(join(repo,'.tmp-p13-proactive-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'rules'));mkdirSync(join(dir,'agent'));
  writeFileSync(join(dir,'rules','README.md'),'# Required writing rule\nDo not write FORBIDDEN.\n');
  writeFileSync(join(dir,'sample.md'),'baseline\n');
  assert.equal(spawnSync('git',['init','-q',dir]).status,0);
  assert.equal(spawnSync('git',['-C',dir,'add','sample.md','rules']).status,0);
  assert.equal(spawnSync('git',['-C',dir,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture']).status,0);
  const extension=join(dir,'fixture.ts');
  writeFileSync(extension,`
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import {writeFileSync,readFileSync} from 'node:fs';
import {composeHubProactive,createHubCapture} from ${JSON.stringify(join(hub,'proactive-runtime.ts'))};
import {parseProactiveConfig} from ${JSON.stringify(join(hub,'proactive-config.ts'))};
const variant=${JSON.stringify(variant)};let modelCalls=0,serviceCalls=0,contexts=[],rt,capture;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export default function(pi){
 const task='Write the synthetic sample';
 const config=parseProactiveConfig(variant==='off'?{version:1,mode:'off'}:{version:1,mode:variant==='advisory'?'advisory':'shadow',remoteContext:variant==='local'?'disabled':'selected-excerpts',include:['sample.md'],maxEvaluationsPerSession:10});
 const service={async evaluate(req){serviceCalls++;return {status:'ok',evaluation:{answers:req.questions.map(q=>({questionId:q.id,type:'choice',value:q.id==='drift'?'possible_deviation':'potential_violation',uncertainty:{confidence:1,provenance:'provider'}})),metadata:{provider:'fixture',requestedModel:'offline',returnedModel:'offline',questionSetVersion:req.questionSetVersion,latencyMs:1,attempts:1,usage:{inputTokens:1,outputTokens:1}}}};}};
 pi.on('session_start',()=>{capture=createHubCapture({root:()=>process.cwd(),task:()=>task});if(config.mode!=='off')rt=composeHubProactive({config,root:process.cwd(),sessionDir:process.cwd(),rulesRoots:['rules'],service,capture});});
 pi.on('turn_start',e=>capture.start(e.turnIndex));
 pi.on('turn_end',e=>{capture.end(e.turnIndex,e.message.content.filter(c=>c.type==='text').map(c=>c.text).join(''));});
 pi.on('context',e=>{const ctx=capture.hubContext();const text=ctx&&rt?.feedback?.take('hub','direct',ctx);if(text)return {messages:[...e.messages,{role:'custom',customType:'agent-fleet.proactive-advisory',content:text,display:false,timestamp:Date.now()}]};});
 pi.on('agent_end',async()=>{await capture.capture;for(let i=0;i<100&&rt?.activeCount;i++)await pause(10);writeFileSync('result.json',JSON.stringify({modelCalls,serviceCalls,contexts,records:rt?.records??[],history:rt?.findings.history??[],activity:rt?.activity.live()??[]}));});
 pi.on('session_shutdown',()=>rt?.abort());
 pi.registerTool({name:'fixture_write',label:'fixture',description:'synthetic only',parameters:Type.Object({}),async execute(){writeFileSync('sample.md','FORBIDDEN synthetic source\\n');return {content:[{type:'text',text:'done'}]};}});
 pi.registerProvider('proactive-e2e',{name:'offline',baseUrl:'http://127.0.0.1',apiKey:'fixture',api:'proactive-e2e-api',models:[{id:'m',name:'m',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}],streamSimple(model,ctx){
  const stream=createAssistantMessageEventStream();queueMicrotask(()=>{modelCalls++;contexts.push(JSON.stringify(ctx.messages));const msg={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};stream.push({type:'start',partial:msg});
  if(modelCalls===1&&variant!=='text'){const toolCall={type:'toolCall',id:'one',name:'fixture_write',arguments:{}};msg.content.push(toolCall);stream.push({type:'toolcall_start',contentIndex:0,partial:msg});stream.push({type:'toolcall_end',contentIndex:0,toolCall,partial:msg});msg.stopReason='toolUse';}
  else{msg.content.push({type:'text',text:'FORBIDDEN synthetic response'});stream.push({type:'text_start',contentIndex:0,partial:msg});stream.push({type:'text_delta',contentIndex:0,delta:'FORBIDDEN synthetic response',partial:msg});stream.push({type:'text_end',contentIndex:0,content:'FORBIDDEN synthetic response',partial:msg});}
  stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }});
}
`);
  // Whitelist the environment: no inherited provider keys, recursion assignments or project settings.
  const env={PATH:process.env.PATH!,HOME:join(dir,'home'),PI_CODING_AGENT_DIR:join(dir,'agent'),PI_OFFLINE:'1',TMPDIR:dir,NODE_OPTIONS:`--import=${join(repo,'bin/test/helpers/system1-no-network.js')}`};
  const run=spawnSync(pi,['--print','--offline','--no-approve','--no-session','--no-extensions','--no-context-files','--no-skills','--no-prompt-templates','--no-themes','--no-builtin-tools','-e',extension,'--model','proactive-e2e/m','Write the synthetic sample'],{cwd:dir,env,encoding:'utf8',timeout:20000});
  assert.equal(run.status,0,variant+': '+run.stderr+' '+run.stdout);
  const result=JSON.parse(readFileSync(join(dir,'result.json'),'utf8'));
  assert.equal(result.modelCalls,variant==='text'?1:2,variant);
  if(variant==='off'){assert.equal(result.serviceCalls,0);assert.equal(result.records.length,0);assert.equal(result.activity.length,0);}
  else if(variant==='local'){assert.equal(result.serviceCalls,0);assert.ok(result.records.length>0);assert.ok(result.records.every((r:any)=>r.status!=='reviewed'));}
  else{assert.ok(result.serviceCalls>0,variant);assert.ok(result.history.length>0,variant);assert.ok(result.history.some((r:any)=>r.findings.length>0),variant);}
  if(variant==='advisory') assert.ok(result.records.some((r:any)=>r.paths.includes('sample.md')),'code-writing turn captured from actual boundary');
  assert.doesNotMatch(JSON.stringify(result.activity),/FORBIDDEN|synthetic source|Write the synthetic sample/);
  assert.ok(result.activity.filter((e:any)=>e.type==='job_started').length===result.activity.filter((e:any)=>e.type==='job_finished').length,'every started job closes');
 }
});

// NOTE (P13a N1): no side-effect imports of sibling test files here. The essential
// B4/B6/B7 proofs live as dedicated real-Pi cases below, so the exact A16 two-file
// command still executes them without running sibling suites twice under npm test.

const pauseMs = (ms: number) => new Promise(r => setTimeout(r, ms));

interface P13aFixtureSpec {
  mode: 'advisory' | 'shadow';
  maxEvaluationsPerSession?: number;
  include?: string[];
  tools: ReadonlyArray<{ name: string; body: string }>;
  // Controlled provider: two natural tool turns then a final natural text turn.
  // The text turn waits (bounded) for the review queue to drain, so the B4
  // advisory — when published — deterministically reaches a later natural call
  // without any feedback-triggered extra turn (modelCalls stays exactly 3).
  plan: 'two-tools-then-text';
  ruleEditMarker?: string;
}

async function runP13aFixture(t: any, spec: P13aFixtureSpec) {
  assert.match(spawnSync(pi, ['--version'], { encoding: 'utf8' }).stdout, /^0\.84\.2/);
  const dir = mkdtempSync(join(repo, '.tmp-p13a-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'rules')); mkdirSync(join(dir, 'agent'));
  writeFileSync(join(dir, 'rules', 'README.md'), '# Required writing rule\nDo not write FORBIDDEN.\n');
  writeFileSync(join(dir, 'sample.md'), 'baseline\n');
  writeFileSync(join(dir, 'second.md'), 'baseline two\n');
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  assert.equal(spawnSync('git', ['-C', dir, 'add', 'sample.md', 'second.md', 'rules']).status, 0);
  assert.equal(spawnSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']).status, 0);
  assert.equal(spec.tools.length, 2, 'controlled plan needs exactly two tools');
  const extension = join(dir, 'fixture.ts');
  const toolsCode = spec.tools.map(tool => `pi.registerTool({name:${JSON.stringify(tool.name)},label:'fixture',description:'synthetic only',parameters:Type.Object({}),async execute(){${tool.body}}});`).join('\n');
  writeFileSync(extension, `
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {Type} from 'typebox';
import {writeFileSync,readFileSync} from 'node:fs';
import {composeHubProactive,createHubCapture} from ${JSON.stringify(join(hub, 'proactive-runtime.ts'))};
import {parseProactiveConfig} from ${JSON.stringify(join(hub, 'proactive-config.ts'))};
const spec=${JSON.stringify({ mode: spec.mode, maxEvaluationsPerSession: spec.maxEvaluationsPerSession ?? 10, include: spec.include ?? ['sample.md', 'second.md'], plan: spec.plan, ruleEditMarker: spec.ruleEditMarker ?? null })};
let modelCalls=0,serviceCalls=0;const contexts=[];const deliveries=[];let rt,capture,preEditRules='',preEditRefs=[];const unsentChecks=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const toolFor=n=>n===1?${JSON.stringify(spec.tools[0].name)}:n===2?${JSON.stringify(spec.tools[1].name)}:'none';
export default function(pi){
 const task='Write the synthetic sample';
 const config=parseProactiveConfig({version:1,mode:spec.mode,remoteContext:'selected-excerpts',include:spec.include,maxEvaluationsPerSession:spec.maxEvaluationsPerSession});
 const service={async evaluate(req){serviceCalls++;return {status:'ok',evaluation:{answers:req.questions.map(q=>({questionId:q.id,type:'choice',value:q.id==='drift'?'possible_deviation':'potential_violation',uncertainty:{confidence:1,provenance:'provider'}})),metadata:{provider:'fixture',requestedModel:'offline',returnedModel:'offline',questionSetVersion:req.questionSetVersion,latencyMs:1,attempts:1,usage:{inputTokens:1,outputTokens:1}}}};}};
 pi.on('session_start',()=>{try{preEditRules=readFileSync('rules/README.md','utf8');}catch{} capture=createHubCapture({root:()=>process.cwd(),task:()=>task});rt=composeHubProactive({config,root:process.cwd(),sessionDir:process.cwd(),rulesRoots:['rules'],service,capture});preEditRefs=capture.hubContext()?.rules??[];});
 pi.on('turn_start',e=>capture.start(e.turnIndex));
 pi.on('turn_end',e=>{capture.end(e.turnIndex,e.message.content.filter(c=>c.type==='text').map(c=>c.text).join(''));});
 pi.on('context',e=>{const ctx=capture.hubContext();if(ctx&&spec.ruleEditMarker){const wrongTask={...ctx,task:{...ctx.task,hash:'f'.repeat(64)}};const wrongRules={...ctx,rules:ctx.rules.map(r=>({...r,hash:'e'.repeat(64)}))};unsentChecks.push({task:rt.feedback.take('hub','direct',wrongTask),rules:rt.feedback.take('hub','direct',wrongRules)});}const text=ctx&&rt?.feedback?.take('hub','direct',ctx);if(text){deliveries.push(text);return {messages:[...e.messages,{role:'custom',customType:'agent-fleet.proactive-advisory',content:text,display:false,timestamp:Date.now()}]};}});
 pi.on('agent_end',async()=>{await capture.capture;for(let i=0;i<500&&rt?.activeCount;i++)await pause(10);let postEditRules='';try{postEditRules=readFileSync('rules/README.md','utf8');}catch{} writeFileSync('result.json',JSON.stringify({modelCalls,serviceCalls,contexts,deliveries,records:rt?.records??[],history:rt?.findings.history??[],activity:rt?.activity.live()??[],used:rt?.used??0,preEditRules,postEditRules,preEditRefs,unsentChecks}));});
 pi.on('session_shutdown',()=>rt?.abort());
 ${toolsCode}
 pi.registerProvider('proactive-e2e',{name:'offline',baseUrl:'http://127.0.0.1',apiKey:'fixture',api:'proactive-e2e-api',models:[{id:'m',name:'m',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000,maxTokens:100}],streamSimple(model,ctx){
  const stream=createAssistantMessageEventStream();queueMicrotask(async()=>{modelCalls++;const n=modelCalls;if(n>=2){for(let i=0;i<500&&rt&&(rt.records.length<n-1||rt.activeCount);i++)await pause(10);}
  contexts.push(JSON.stringify(ctx.messages));const msg={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};stream.push({type:'start',partial:msg});
  const tool=toolFor(n);if(tool!=='none'){const toolCall={type:'toolCall',id:'t'+n,name:tool,arguments:{}};msg.content.push(toolCall);stream.push({type:'toolcall_start',contentIndex:0,partial:msg});stream.push({type:'toolcall_end',contentIndex:0,toolCall,partial:msg});msg.stopReason='toolUse';}
  else{const text='done';msg.content.push({type:'text',text});stream.push({type:'text_start',contentIndex:0,partial:msg});stream.push({type:'text_delta',contentIndex:0,delta:text,partial:msg});stream.push({type:'text_end',contentIndex:0,content:text,partial:msg});}
  stream.push({type:'done',reason:msg.stopReason,message:msg});stream.end();});return stream;
 }});
}
`);
  const env = { PATH: process.env.PATH!, HOME: join(dir, 'home'), PI_CODING_AGENT_DIR: join(dir, 'agent'), PI_OFFLINE: '1', TMPDIR: dir, NODE_OPTIONS: `--import=${join(repo, 'bin/test/helpers/system1-no-network.js')}` };
  const run = spawnSync(pi, ['--print', '--offline', '--no-approve', '--no-session', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-builtin-tools', '-e', extension, '--model', 'proactive-e2e/m', 'Write the synthetic sample'], { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr + ' ' + run.stdout);
  return { dir, result: JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as any };
}

test('P13a B4 next-natural-turn advisory via production publish path; shadow silent; exact call counts', { timeout: 90000 }, async t => {
  for (const mode of ['advisory', 'shadow'] as const) {
    const { result } = await runP13aFixture(t, {
      mode, plan: 'two-tools-then-text',
      tools: [
        { name: 'fixture_write', body: `writeFileSync('sample.md','FORBIDDEN synthetic source\\n');return {content:[{type:'text',text:'done'}]};` },
        { name: 'fixture_note', body: `return {content:[{type:'text',text:'noted'}]};` },
      ],
    });
    assert.equal(result.modelCalls, 3, `${mode}: no feedback-triggered extra turn`);
    assert.ok(result.serviceCalls > 0, `${mode}: real evaluation ran`);
    assert.equal(result.contexts.length, 3, `${mode}: three natural calls observed`);
    assert.doesNotMatch(result.contexts[0], /Proactive review/, `${mode}: first call carries no advisory`);
    if (mode === 'advisory') {
      assert.equal(result.deliveries.length, 1, 'advisory publishes exactly once per revision');
      assert.match(result.contexts[1], /Proactive review \(advisory data only/, 'advisory text reaches the next natural call');
      assert.match(result.contexts[1], /reviewed-rules/, 'advisory names the bound reviewed ruleset');
      assert.doesNotMatch(result.contexts[2], /Proactive review/, 'no repeat delivery on the following call');
      assert.equal(result.history.length > 0, true);
    } else {
      assert.equal(result.deliveries.length, 0, 'shadow never delivers');
      for (const context of result.contexts) assert.doesNotMatch(context, /Proactive review/, 'shadow context stays silent');
    }
  }
});

test('P13a B6a edited rule is not auto-approved; no new-rule authority without explicit rebind', { timeout: 90000 }, async t => {
  const marker = 'NEWMARKER-7f3a';
  const { result } = await runP13aFixture(t, {
    mode: 'advisory', ruleEditMarker: marker,
    tools: [
      { name: 'fixture_write', body: `writeFileSync('sample.md','FORBIDDEN synthetic source\\n');writeFileSync('rules/README.md',readFileSync('rules/README.md','utf8')+'\\n${marker} edited rule body.\\n');return {content:[{type:'text',text:'done'}]};` },
      { name: 'fixture_note', body: `return {content:[{type:'text',text:'noted'}]};` },
    ],
    plan: 'two-tools-then-text',
  });
  assert.equal(result.modelCalls, 3, 'no feedback-triggered extra turn');
  assert.notEqual(result.preEditRules, result.postEditRules, 'the rule edit really happened mid-run');
  assert.match(result.postEditRules, new RegExp(marker), 'control: marker is on disk');
  for (const context of result.contexts) assert.doesNotMatch(context, new RegExp(marker), 'edited rule body never enters natural-turn feedback');
  for (const text of result.deliveries) assert.doesNotMatch(text, new RegExp(marker), 'edited rule body never enters delivered advisory');
  const fingerprint=(refs:any[])=>createHash('sha256').update(JSON.stringify(refs.map(r=>[r.path,r.hash]).sort())).digest('hex');
  const preFingerprint=fingerprint(result.preEditRefs);
  const editedFingerprint=fingerprint(result.preEditRefs.map((r:any)=>r.path==='rules/README.md'?{...r,hash:createHash('sha256').update(result.postEditRules).digest('hex')}:r));
  assert.notEqual(preFingerprint,editedFingerprint,'the on-disk edit would change the ruleset fingerprint');
  assert.ok(result.records.length>=2,'post-edit turn was assessed');
  const postEditSnapshots=new Map(result.records.slice(1).map((r:any)=>[r.turnId,r.snapshotId]));
  const postEditFindings=result.history.filter((h:any)=>postEditSnapshots.has(h.turnId)).flatMap((h:any)=>h.findings.filter((f:any)=>f.source==='system1'&&f.snapshotId===postEditSnapshots.get(h.turnId)));
  assert.ok(postEditFindings.length>0,'real post-edit assessment produces a history finding');
  assert.ok(postEditFindings.every((f:any)=>f.ruleHash===preFingerprint&&f.ruleHash!==editedFingerprint),'post-edit finding stays bound to pre-edit refs');
  assert.equal(result.deliveries.length,1,'real Pi delivers exactly once');
  assert.match(result.contexts[1],/Proactive review \(advisory data only/,'matching unsent context reaches natural call 2');
  assert.doesNotMatch(result.contexts[0],/Proactive review/);assert.doesNotMatch(result.contexts[2],/Proactive review/);
  assert.deepEqual(result.unsentChecks[1],{task:'',rules:''},'both forged contexts are refused before the matching context consumes the unsent item');
  for (const text of result.deliveries) assert.match(text, /advisory data only/, 'any delivery stays labeled advisory, never a current gate');
});

test('P13a B6b exhausted budget skips honestly; second writing turn unverified and service calls do not grow', { timeout: 90000 }, async t => {
  const { result } = await runP13aFixture(t, {
    mode: 'advisory', maxEvaluationsPerSession: 1,
    tools: [
      { name: 'fixture_write_a', body: `writeFileSync('sample.md','FORBIDDEN synthetic source\\n');return {content:[{type:'text',text:'done a'}]};` },
      { name: 'fixture_write_b', body: `writeFileSync('second.md','FORBIDDEN synthetic source two\\n');return {content:[{type:'text',text:'done b'}]};` },
    ],
    plan: 'two-tools-then-text',
  });
  assert.equal(result.modelCalls, 3, 'no feedback-triggered extra turn');
  assert.equal(result.serviceCalls, 1, 'budget exhaustion: provider calls do not grow past the single evaluation');
  assert.ok(result.records.length >= 2, 'both writing turns have a report state');
  const later = result.records.slice(1);
  assert.ok(later.length > 0 && later.every((r: any) => r.status !== 'reviewed'), 'post-budget turns stay honestly unverified, never current');
  assert.ok(later.every((r: any) => !r.assessment || r.assessment.status !== 'reviewed'), 'no invented reviewed assessment after budget');
});

test('P13a B7 parent sentinel absent from child env and all metadata; raw evidence stays private', { timeout: 90000 }, async t => {
  const sentinel = 'SENTINEL-p13a-9f2c';
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = sentinel;
  try {
    const { dir, result } = await runP13aFixture(t, {
      mode: 'advisory',
      tools: [
        { name: 'fixture_write', body: `writeFileSync('sample.md','FORBIDDEN synthetic source\\n');writeFileSync('env-dump.json',JSON.stringify(process.env));return {content:[{type:'text',text:'done'}]};` },
        { name: 'fixture_note', body: `return {content:[{type:'text',text:'noted'}]};` },
      ],
      plan: 'two-tools-then-text',
    });
    const dump = JSON.parse(readFileSync(join(dir, 'env-dump.json'), 'utf8'));
    assert.equal(dump.TYPESAFE_API_KEY, undefined, 'parent sentinel never reaches the child env');
    assert.ok(!Object.values(dump).some(v => typeof v === 'string' && v.includes(sentinel)), 'no sentinel value anywhere in child env');
    const metadata = JSON.stringify({ records: result.records, history: result.history, activity: result.activity, contexts: result.contexts, deliveries: result.deliveries });
    assert.doesNotMatch(metadata, new RegExp(sentinel), 'sentinel absent from records/history/activity/contexts/deliveries');
    assert.doesNotMatch(JSON.stringify(result.activity), /FORBIDDEN/, 'finding payload absent from activity metadata');
    assert.doesNotMatch(JSON.stringify(result.contexts), /synthetic source/, 'raw captured source absent from natural-turn contexts');
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous;
  }
});
