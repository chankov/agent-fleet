import test from 'node:test';
import assert from 'node:assert/strict';
import { DAMAGE_GUARD_QUESTIONS, damageVerdict } from './damage-guard-contract.ts';
import { createCommunicationStore } from './system1-communication-store.ts';
import type { System1Result } from '../lib/system1/contracts.ts';
const result=(effect:string,evidence:string):Extract<System1Result,{status:'ok'}>=>({status:'ok',evaluation:{answers:[{questionId:'effect',type:'choice',value:effect,uncertainty:{provenance:'provider'}},{questionId:'evidence',type:'choice',value:evidence,uncertainty:{provenance:'provider'}}],metadata:{provider:'typesafe',requestedModel:'jev-1.13.0',returnedModel:'jev-1.13.0',questionSetVersion:'damage-guard/v1',latencyMs:1,attempts:1}}});
test('D6 severe AND sufficient alone holds/warns; unknown and partial never authorize',()=>{
 for(const effect of ['severe','not_severe','unknown']) for(const evidence of ['sufficient','partial','unknown']) {
  assert.equal(damageVerdict(result(effect,evidence),'call'),effect==='severe'&&evidence==='sufficient'?'hold_exact_action':effect==='unknown'||evidence!=='sufficient'?'not_evaluated':'no_additional_hold');
 }
 assert.equal(damageVerdict(result('severe','sufficient'),'result'),'warn_result');
 for(const bad of [result('invalid','sufficient'),{status:'cancelled'}, {status:'ok',evaluation:{...result('severe','sufficient').evaluation,answers:[]}}]) assert.equal(damageVerdict(bad as System1Result,'call'),'not_evaluated');
});
test('D6 diagnostic envelope never stores payloads, identities, extras or thrown secrets',async()=>{
 const sentinel='private plain sentinel 29487', store=createCommunicationStore();store.setEnabled(true);
 const snapshots:string[]=[];store.subscribe(()=>snapshots.push(JSON.stringify(store.snapshot())));
 const response=result('severe','sufficient') as any;response.extra=sentinel;response.evaluation.metadata.returnedModel=sentinel;
 const req:any={questionSetVersion:'damage-guard/v1',questions:DAMAGE_GUARD_QUESTIONS,state:{owner:sentinel,trigger:'bash',scope:'commands',coverage:'complete',payload:sentinel+' Bearer abc',bytes:4}};
 const wrapped=store.wrap({evaluate:async()=>response},{provider:sentinel,model:sentinel});
 assert.equal(await wrapped.evaluate(req),response);
 assert.equal(store.snapshot()[0].consumer,'damageGuard');
 assert.ok(!JSON.stringify(store.snapshot()).includes(sentinel));assert.ok(snapshots.every(s=>!s.includes(sentinel)));
 const throwing=store.wrap({evaluate:async()=>{throw Error(sentinel);}},{provider:'typesafe',model:'jev-1.13.0'});
 await assert.rejects(throwing.evaluate(req));
 assert.ok(!JSON.stringify(store.snapshot()).includes(sentinel));
});
