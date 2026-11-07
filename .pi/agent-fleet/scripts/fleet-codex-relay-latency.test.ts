import test from 'node:test';import assert from 'node:assert/strict';import {RelayLatencyTrace,summarizeLatency,runLatencySeries,captureLatencyEmission} from './lib/fleet-codex-relay-latency.ts';
test('Pi-applied cannot be inferred from queue ACK; percentiles preserve missing model phases and unknowns',()=>{
 const emission=captureLatencyEmission(),trace=new RelayLatencyTrace('fixture',emission.wallMs+5000,'fixture_no_model',emission);trace.mark('queue_accepted');assert.throws(()=>trace.finish('applied'),/applied_not_observed/);
 trace.mark('decision_returned');trace.mark('pi_applied');const sample=trace.finish('applied'),report=summarizeLatency([sample]);assert.equal(report.count,1);assert.equal(report.modelObservedMs,null);assert.equal(report.noModelSloEvidence,true);
});
test('remote clock error stays explicit; recorded host input is not model awareness',()=>{
 const emission=captureLatencyEmission(),t=new RelayLatencyTrace('remote',emission.wallMs+5000,'live',emission);t.remote('host_input_recorded',emission.wallMs+50,1);t.remote('model_observed',emission.wallMs+100,null);t.remote('pi_applied',emission.wallMs+200,null);
 const sample=t.finish('applied'),report=summarizeLatency([sample]);assert.equal(sample.deadlineAssessment,'unknown_clock_error');assert.equal(report.modelObservedMs,null);assert.equal(report.piAppliedMs,null);assert.equal(report.noModelSloEvidence,true);
});

test('20-sample driver is ready, but live mode without NEW coordinator approval cannot run',async()=>{
 let called=0;await assert.rejects(runLatencySeries({mode:'live',count:20,run:async()=>{called++;throw Error('must not run');}}),/live_series_not_authorized/);assert.equal(called,0);
 const samples=await runLatencySeries({mode:'fixture_no_model',count:20,run:async i=>{const t=new RelayLatencyTrace('fixture-'+i,Date.now()+5000,'fixture_no_model');t.mark('decision_returned');t.mark('pi_applied');return t.finish('applied');}});assert.equal(samples.count,20);assert.equal(samples.deadlineMisses,0);
});
