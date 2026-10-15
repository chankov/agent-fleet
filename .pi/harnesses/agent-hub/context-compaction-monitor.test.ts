import test from "node:test";
import assert from "node:assert/strict";
import { createCompactionMonitor } from "./context-compaction-monitor.ts";
test("monitor records actual threshold, restoration and later usage without inventing a reduction",()=>{
 const events:Record<string,unknown>[]=[];const m=createCompactionMonitor(e=>events.push(e));
 m.record("started",{tokens:65000,contextWindow:100000});
 m.record("restored",{tokens:null,contextWindow:100000});
 m.record("continuation_requested",{tokens:null,contextWindow:100000});
 assert.equal(events[1].afterPercent,null);
 m.observe({tokens:15000,contextWindow:100000});
 assert.equal(events[3].afterPercent,15);assert.equal(events[3].beforePercent,65);
 assert.equal(events[3].measurement,"first_post_compaction");
 assert.equal(events[3].phase,"continued");
 m.observe({tokens:16000,contextWindow:100000});assert.equal(events.length,4);
 assert.equal(events[0].minimumPercent,50);assert.equal(events[0].maximumPercent,80);
});
test("ceiling overshoot and failure remain visible",()=>{
 const events:Record<string,unknown>[]=[];const m=createCompactionMonitor(e=>events.push(e));
 m.record("started",{tokens:83000,contextWindow:100000});m.record("failed");
 assert.equal(events[0].ceilingExceeded,true);assert.equal(m.snapshot().phase,"failed");
 assert.equal(m.snapshot().afterPercent,null);
});
