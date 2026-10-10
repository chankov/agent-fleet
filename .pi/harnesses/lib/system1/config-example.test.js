import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CONSUMERS,normalizeSystem1Config} from './config-v2.js';
import {TASK_TRIAGE_LIMITS} from './config-triage.js';

const examplePath=new URL('../../../../docs/system1.example.json',import.meta.url);
const readExample=()=>JSON.parse(readFileSync(examplePath,'utf8'));

test('published System1 example covers every schema consumer and is inert without secrets or fake approval',()=>{
 const example=readExample(),normalized=normalizeSystem1Config(example);
 assert.deepEqual(normalized.errors,[]);assert.equal(normalized.status,'off');
 assert.deepEqual(Object.keys(example.consumers).sort(),[...CONSUMERS].sort());
 for(const name of CONSUMERS){assert.equal(normalized.consumers[name].status,'off');assert.equal(example.consumers[name].mode,'off');}
 assert.equal(example.provider,'typesafe');assert.equal(example.model,'jev-1.13.0');assert.equal(example.apiKeyEnv,'TYPESAFE_API_KEY');
 assert.equal(example.consumers.proactiveReview.remoteContext,'disabled');assert.equal(example.consumers.proactiveReview.maxEvaluationsPerSession,0);
 assert.deepEqual(example.consumers.proactiveReview.localBindings,[]);
 assert.equal(example.consumers.dispatchTriage.profile,undefined);
 assert.deepEqual(example.consumers.taskTriage.limits,TASK_TRIAGE_LIMITS);
 for(const name of ['dispatchTriage','taskTriage','agenticAsk','fileDiscovery','contextCompaction'])assert.equal(example.consumers[name].remoteContextApproved,false);
 assert.equal(example.consumers.fileDiscovery.semanticReads.mode,'off');
 const walk=value=>{if(!value || typeof value!=='object')return;for(const [key,item] of Object.entries(value)){assert.ok(!/^(?:apiKey|token|password|secret|credential|approved|evidence)$/i.test(key),key);walk(item);}};
 walk(example);
});

test('documented opt-in edits validate without fabricating dispatch profiles or local rule bindings',()=>{
 const example=readExample();example.mode='auto';
 example.consumers.watchdog.mode='shadow';
 Object.assign(example.consumers.proactiveReview,{mode:'advisory',remoteContext:'selected-excerpts',include:['docs/**'],maxEvaluationsPerSession:20});
 Object.assign(example.consumers.dispatchTriage,{mode:'advisory',remoteContextApproved:true});
 Object.assign(example.consumers.taskTriage,{mode:'experimental',remoteContextApproved:true});
 Object.assign(example.consumers.agenticAsk,{mode:'recommended',remoteContextApproved:true});
 Object.assign(example.consumers.fileDiscovery,{mode:'active',remoteContextApproved:true});example.consumers.fileDiscovery.semanticReads.mode='active';
 Object.assign(example.consumers.contextCompaction,{mode:'automatic',remoteContextApproved:true});
 const normalized=normalizeSystem1Config(example);assert.deepEqual(normalized.errors,[]);assert.equal(normalized.status,'ready');
 for(const name of CONSUMERS)assert.equal(normalized.consumers[name].status,'ready',name);
});

test('npm documentation surface includes example and its consumer guides',()=>{
 const pkg=JSON.parse(readFileSync(new URL('../../../../package.json',import.meta.url),'utf8'));
 for(const path of ['docs/system1.example.json','docs/system1-config.md','docs/system1-context-continuity.md','docs/system1-dispatch-triage.md','docs/system1-agentic.md','docs/system1-file-discovery.md'])assert.ok(pkg.files.includes(path),path);
});
