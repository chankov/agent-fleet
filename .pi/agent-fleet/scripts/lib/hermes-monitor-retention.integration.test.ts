import test from "node:test";
import assert from "node:assert/strict";
import { MonitorStore, MONITOR_RETENTION_MAX } from "./hermes-monitor-store.ts";

test("store prune mutates oldest terminal records while retaining active parent-child relationships and output metadata", () => {
 let time=new Date("2026-01-10T00:00:00Z"); const store=new MonitorStore({now:()=>time});
 store.createParent({id:"active-parent",generation:1,hubInstanceId:"hub",checkoutId:"checkout"});
 store.createChild({id:"active-child",generation:1,parentId:"active-parent",parentGeneration:1,specialist:"qa"}); store.appendPublicOutput("active-child",1,"visible");
 for(let n=0;n<MONITOR_RETENTION_MAX+2;n++){store.createParent({id:`old-${n}`,generation:1,hubInstanceId:"hub",checkoutId:"checkout"});store.transition(`old-${n}`,1,"done");}
 time=new Date("2026-01-20T00:00:00Z"); const snapshot:any=store.prune();
 assert.equal(snapshot.tasks.some((t:any)=>t.id==="active-parent"),true);
 assert.equal(snapshot.tasks.some((t:any)=>t.id==="active-child"),true);
 const child=snapshot.tasks.find((t:any)=>t.id==="active-child"); assert.deepEqual({sequence:child.outputSequence,first:child.firstSequence,truncated:child.truncated},{sequence:1,first:1,truncated:false});
 assert.equal(snapshot.tasks.some((t:any)=>t.id.startsWith("old-")),false);
});
