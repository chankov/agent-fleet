import test from 'node:test';import assert from 'node:assert/strict';
import {AGENTIC_COUNTER,restoreAgenticCounter,createAgenticBudget} from './agentic-state.ts';
test('durable high-water counter survives resume and fails closed',()=>{
 const rows:any[]=[];const budget=createAgenticBudget('s',s=>rows.push({customType:AGENTIC_COUNTER,data:s}));
 assert.equal(budget.reserve(2),'ok');assert.equal(budget.reserve(2),'ok');assert.equal(budget.reserve(2),'budget_exhausted');
 assert.equal(createAgenticBudget('s',()=>{},restoreAgenticCounter(rows,'s')).reserve(2),'budget_exhausted');
 assert.equal(restoreAgenticCounter(rows,'other'),null);assert.equal(restoreAgenticCounter([{type:'message',message:{role:'user'}}],'s'),null);
 assert.equal(createAgenticBudget('s',()=>{throw Error();}).reserve(2),'persistence_failed');
 rows.push({customType:AGENTIC_COUNTER,data:{schema:AGENTIC_COUNTER,sessionId:'s',calls:1}});assert.equal(restoreAgenticCounter(rows,'s')?.calls,2);
});
