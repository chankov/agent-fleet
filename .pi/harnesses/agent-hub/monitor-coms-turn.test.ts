import test from 'node:test';
import assert from 'node:assert/strict';
import {registerTurnPresence} from './lifecycle/turn-handlers.ts';
import {createMonitorSessionBridge} from './monitor-session-bridge.ts';

function presenceHarness() {
 const handlers=new Map<string,()=>Promise<void>>();
 const bridge=createMonitorSessionBridge();let parent:string|null=null;let starts=0;const presence:string[]=[];
 registerTurnPresence({on:(event,callback)=>{handlers.set(event,callback);}}, {
  beforeAgentPresence:async()=>{presence.push('working');parent=`parent-${++starts}`;bridge.startParent({id:parent,generation:1,hubInstanceId:'hub',checkoutId:'checkout'});},
  agentEndPresence:async()=>{presence.push('idle');bridge.finishParent(parent!,'completed');parent=null;},
 });
 return {handlers,bridge,presence,starts:()=>starts,parent:()=>parent};
}

test('coms custom-message start publishes intermediate child output without before_agent_start',async()=>{
 const {handlers,bridge,presence,starts,parent}=presenceHarness();
 // Pi sendCustomMessage(triggerTurn) emits agent_start directly, with no before_agent_start.
 await handlers.get('agent_start')?.();
 assert.equal(starts(),1);assert.ok(parent(),'custom-message turn must acquire a monitor parent before dispatch');
 const child=await bridge.startChild({key:'child',id:'child',generation:1,parentId:parent()!,specialist:'builder'},{});
 await bridge.appendOutputFor(child,'INTERMEDIATE');
 const active=bridge.snapshot().tasks.find(t=>t.id==='child');
 assert.ok(['starting','running'].includes(active?.state));assert.equal(bridge.readOutput({taskId:'child',generation:1,afterSequence:0}).text,'INTERMEDIATE');
 await bridge.finalizeChildFor(child,'FINAL','completed');await handlers.get('agent_end')?.();
 assert.deepEqual(presence,['working','idle']);assert.equal(starts(),1);
});

test('normal hub turn emitting before_agent_start then agent_start reports presence exactly once',async()=>{
 const {handlers,presence,starts}=presenceHarness();
 assert.equal(handlers.has('before_agent_start'),false);
 assert.equal(handlers.has('agent_start'),true);
 await handlers.get('before_agent_start')?.();
 assert.equal(starts(),0);
 assert.deepEqual(presence,[]);
 await handlers.get('agent_start')?.();
 assert.equal(starts(),1);
 assert.deepEqual(presence,['working']);
 await handlers.get('agent_end')?.();
 assert.deepEqual(presence,['working','idle']);
 assert.equal(starts(),1);
});
