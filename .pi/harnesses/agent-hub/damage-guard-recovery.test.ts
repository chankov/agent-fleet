import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageHubSession} from './damage-guard-hub.ts';
import {normalizeSystem1Config} from '../lib/system1/config-v2.js';
const document={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{damageGuard:{mode:'off'}}};
test('allow-only and recovery-only restoration cannot turn a human dialog arm into off/outage admission',async()=>{
 for(const decision of ['allow','recovery'])for(const outage of [false,true]){
  const rows:any[]=[],append=(customType:string,data:unknown)=>rows.push({customType,data}),options={root:process.cwd(),taskId:()=> 'task',append,entries:()=>rows,canRead:()=>true,selected:true};
  const seed=createDamageHubSession({...options,snapshot:normalizeSystem1Config(document),ask:async()=>{throw Error('must not ask');}});seed.accept('input');
  const event={toolName:'bash',toolCallId:'seed',input:{command:'echo public'}},ctx={cwd:process.cwd(),revalidateBaseline:()=>true};await seed.call(event,ctx);seed.dispose();
  const {createDamageGuard}=await import('../damage-control-continue/system1-guard.ts'),{createDamageState}=await import('./damage-guard-state.ts'),{parseDamageGuardConfig}=await import('../lib/system1/config-damage-guard.js');
  const guard=createDamageGuard({root:process.cwd(),config:parseDamageGuardConfig({mode:'off'}),state:createDamageState(()=>{}),binding:()=>({taskId:'task',inputRevision:rows[0].data.revision,owner:'hub',attempt:'fixture'}),canRead:()=>true,approve:async()=>false}),action=guard.action(event,ctx);guard.dispose();
  rows.push({customType:'damage-guard-denial',data:{schema:'damage-denial/v1',taskId:action.taskId,inputRevision:action.inputRevision,operation:action.operation,target:action.target,cwd:action.cwd,decision}});
  let asks=0;const session=createDamageHubSession({...options,snapshot:normalizeSystem1Config(outage?{...document,consumers:{damageGuard:{mode:'active',remoteScopes:{commands:true},include:['docs']}}}:document),service:{evaluate:async()=>({status:'unavailable',reason:'network'})},ask:async()=>{asks++;throw Error('cancelled synthetic dialog');}});
  assert.equal((await session.call({...event,toolCallId:'first'},ctx)).block,true);
  assert.equal(session.armOverride('first'),true);
  assert.equal((await session.call({...event,toolCallId:'retry'},ctx)).block,true,`${decision}/${outage}: no consent means no effect`);assert.equal(asks,1,`${decision}/${outage}: arm must open a new dialog`);
  assert.equal((await session.call({...event,toolCallId:'again'},ctx)).block,true);assert.equal(asks,1);session.dispose();
 }
});
