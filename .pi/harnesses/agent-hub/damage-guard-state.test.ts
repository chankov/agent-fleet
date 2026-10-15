import test from 'node:test';
import assert from 'node:assert/strict';
import {createDamageState,damageDenyKey} from './damage-guard-state.ts';
const action={taskId:'task',inputRevision:'revision',operation:'bash' as const,target:'a'.repeat(64),cwd:'/repo',actionId:'call1',owner:'hub',attempt:'attempt1'};
test('durable deny ignores call/attempt but preserves task revision and exact input cwd',()=>{
 const entries:unknown[]=[];const state=createDamageState(row=>entries.push(row));
 state.deny(action);assert.equal(state.denied({...action,actionId:'new',attempt:'new'}),true);
 const resumed=createDamageState(()=>{});resumed.restore(entries);
 assert.equal(resumed.denied(action),true);
 assert.equal(resumed.denied({...action,inputRevision:'next'}),false);
 assert.equal(resumed.denied({...action,cwd:'/other'}),false);
 resumed.allow(action);assert.equal(resumed.denied(action),true);
 const otherOwner={...action,owner:'child',attempt:'new'};assert.equal(damageDenyKey(action),damageDenyKey(otherOwner));
});
test('persistence failure cannot claim durable decision or restore malformed grants',()=>{
 const state=createDamageState(()=>{throw Error();});assert.throws(()=>state.deny(action));assert.equal(state.denied(action),true);
 state.restore([{schema:'damage-denial/v1',key:'forged',decision:'allow_once'},{schema:'other'}]);assert.equal(state.denied(action),false);
});
