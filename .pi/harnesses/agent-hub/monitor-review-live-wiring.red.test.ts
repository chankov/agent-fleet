import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorLifecycle } from "./monitor-lifecycle.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
import { MonitorStore, MONITOR_RETENTION_MAX, pruneMonitorTasks } from "../../../scripts/lib/hermes-monitor-store.ts";

const parent={id:"parent",generation:1,hubInstanceId:"hub",checkoutId:"checkout"};

test("RED: lifecycle exposes one bridge-backed snapshot, output, and cancel registration", () => {
 const lifecycle:any=createMonitorLifecycle({registry:{register:()=>{ throw new Error("not reached"); }}});
 // One lifecycle entry point must wire the three callbacks from one bridge instance.
 assert.equal(typeof lifecycle.startBridge, "function");
});

test("RED: child start is serialized before output/completion and snapshot has parent children cursor metadata", async () => {
 const bridge:any=createMonitorSessionBridge(); bridge.startParent(parent);
 const starting=bridge.startChild({key:"child",id:"child",generation:1,parentId:"parent",specialist:"qa"},{});
 await assert.doesNotReject(bridge.appendOutput("child","too early"));
 await assert.doesNotReject(bridge.finishChild("child","done"));
 await starting;
 const snapshot=bridge.snapshot(); assert.ok(snapshot.tasks.some((t:any)=>t.id==="parent")&&snapshot.tasks.some((t:any)=>t.parentId==="parent"),"flat parent-child relationship expected");
 assert.ok(snapshot.tasks.some((t:any)=>t.outputSequence!==undefined&&t.firstSequence!==undefined&&t.truncated!==undefined),"cursor metadata expected");
});

test("RED: late history is bounded and store actively prunes, validates terminal transitions, rejects terminal output", () => {
 const bridge:any=createMonitorSessionBridge(); for(let n=0;n<300;n++)bridge.recordComsLateEvent("cancelled",`event-${n}`); assert.ok(bridge.recordComsLateEvent("cancelled","last").history.length<=200);
 const old=Array.from({length:MONITOR_RETENTION_MAX+1},(_,n)=>({state:"done",updatedAt:"2000-01-01T00:00:00.000Z",n})); assert.equal(pruneMonitorTasks({now:new Date("2026-01-01"),tasks:old}).length,0,"active store retention required");
 const store=new MonitorStore(); store.createParent(parent); store.transition("parent",1,"done"); assert.throws(()=>store.transition("parent",1,"running"),/terminal|transition/i); assert.throws(()=>store.appendPublicOutput("parent",1,"late"),/terminal|late/i);
});
