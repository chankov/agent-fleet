import test from "node:test";
import assert from "node:assert/strict";
import { ContextContinuityCoordinator, type ContinuityIdentity, type ContinuityEligibility } from "./context-continuity.ts";
function setup() {
  let id: ContinuityIdentity={session:"s",task:"t",revision:1,owner:"hub",attempt:1};
  let eligibility: ContinuityEligibility={active:true,cancelled:false,completed:false,waitingUser:false,budgetBlocked:false};
  let finish!: ()=>void; const effects:string[]=[];
  let restore=true,user=false;
  const coordinator=new ContextContinuityCoordinator({identity:()=>id,eligibility:()=>eligibility,compact:()=>{effects.push("compact");return new Promise<void>(resolve=>{finish=resolve;});},restore:async()=>{effects.push("restore");return restore;},replayUser:()=>{if(user) effects.push("user");return user;},continueTask:()=>effects.push("continue")});
  return {coordinator,effects,finish:()=>finish(),setId:(value:ContinuityIdentity)=>{id=value;},eligibility,setRestore:(v:boolean)=>{restore=v;},setUser:(v:boolean)=>{user=v;}};
}
test("single flight, native overlap and one continuation only after restore",async()=>{
 const s=setup(); const first=s.coordinator.request("next");
 assert.equal(s.coordinator.request("duplicate"),first);
 const one=s.coordinator.run("preserve"); assert.equal(s.coordinator.run("again"),one);
 await s.coordinator.nativeCompacted(); assert.deepEqual(s.effects,["compact"]);
 s.finish(); assert.equal(await one,true); await s.coordinator.nativeCompacted();
 assert.deepEqual(s.effects,["compact","restore","continue"]);
});
test("restore failure cannot claim recovered or continue",async()=>{
 const s=setup();s.setRestore(false);s.coordinator.request("next");const run=s.coordinator.run("preserve");s.finish();assert.equal(await run,false);assert.equal(s.coordinator.phase,"failed");assert.deepEqual(s.effects,["compact","restore"]);
});
for(const flag of ["cancelled","completed","waitingUser","budgetBlocked"] as const) test(`${flag} remains gated across compact`,async()=>{
 const s=setup();s.coordinator.request("next");const run=s.coordinator.run("preserve");s.eligibility[flag]=true;s.finish();await run;assert.deepEqual(s.effects,["compact","restore"]);
});
test("late callbacks after cancellation or identity replacement are fenced",async()=>{
 for(const kind of ["fence","identity"]){const s=setup();s.coordinator.request("next");const run=s.coordinator.run("preserve");if(kind==="fence")s.coordinator.fence();else s.setId({session:"other",task:"t",revision:1,owner:"hub",attempt:1});s.finish();assert.equal(await run,false);assert.deepEqual(s.effects,["compact"]);}
});
test("real queued user input takes priority over synthetic work",async()=>{
 const s=setup();s.setUser(true);s.coordinator.request("next");const run=s.coordinator.run("preserve");s.finish();await run;assert.deepEqual(s.effects,["compact","restore","user"]);
});

test("explicit no-history skip continues once without compact or restore and keeps user priority",()=>{
 const s=setup();s.coordinator.request("next");assert.equal(s.coordinator.skipNoHistory(),true);assert.equal(s.coordinator.skipNoHistory(),false);assert.equal(s.coordinator.phase,"skipped");assert.deepEqual(s.effects,["continue"]);
 const queued=setup();queued.setUser(true);queued.coordinator.request("next");queued.coordinator.skipNoHistory();assert.deepEqual(queued.effects,["user"]);
});
for(const flag of ["cancelled","completed","waitingUser","budgetBlocked"] as const)test(`no-history skip cannot bypass ${flag}`,()=>{
 const s=setup();s.coordinator.request("next");s.eligibility[flag]=true;s.coordinator.skipNoHistory();assert.deepEqual(s.effects,[]);
});
test("no-history skip after identity change is fenced",()=>{
 const s=setup();s.coordinator.request("next");s.setId({session:"s",task:"different",revision:2,owner:"hub",attempt:1});assert.equal(s.coordinator.skipNoHistory(),false);assert.deepEqual(s.effects,[]);
});
