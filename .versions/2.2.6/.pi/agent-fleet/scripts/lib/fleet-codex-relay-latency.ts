export type LatencyMode='fixture_no_model'|'live';
export type LatencyStage='ingress_committed'|'host_write_attempt'|'queue_accepted'|'host_input_recorded'|'model_observed'|'decision_returned'|'pi_applied';
export const captureLatencyEmission=()=>({wallMs:Date.now(),monotonicNs:process.hrtime.bigint()});
type Point={elapsedMs:number|null;basis:'local_monotonic'|'remote_wall';uncertaintyMs:number|null};
export class RelayLatencyTrace {
 private readonly eventId:string;private readonly deadline:number;private readonly mode:LatencyMode;
 private readonly emission:ReturnType<typeof captureLatencyEmission>;private points:Partial<Record<LatencyStage,Point>>={};
 constructor(eventId:string,deadline:number,mode:LatencyMode,emission=captureLatencyEmission()){
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(eventId)||!Number.isSafeInteger(deadline)||deadline<=emission.wallMs||!['fixture_no_model','live'].includes(mode))throw Error('latency_trace_invalid');
  this.eventId=eventId;this.deadline=deadline;this.mode=mode;this.emission=emission;
 }
 mark(stage:LatencyStage){
  if(!['ingress_committed','host_write_attempt','queue_accepted','host_input_recorded','model_observed','decision_returned','pi_applied'].includes(stage)||this.points[stage])throw Error('latency_phase_conflict');
  if(stage==='pi_applied'&&!this.points.decision_returned)throw Error('decision_not_observed');
  this.points[stage]={elapsedMs:Number(process.hrtime.bigint()-this.emission.monotonicNs)/1e6,basis:'local_monotonic',uncertaintyMs:0};
 }
 remote(stage:LatencyStage,sourceWallMs:number,uncertaintyMs:number|null){
  if(!['ingress_committed','host_write_attempt','queue_accepted','host_input_recorded','model_observed','decision_returned','pi_applied'].includes(stage)||this.points[stage]||!Number.isFinite(sourceWallMs)||uncertaintyMs!==null&&(!Number.isFinite(uncertaintyMs)||uncertaintyMs<0))throw Error('latency_remote_invalid');
  // Unknown cross-process clock error MUST NOT turn a wall timestamp into exact latency.
  this.points[stage]={elapsedMs:uncertaintyMs===null?null:sourceWallMs-this.emission.wallMs,basis:'remote_wall',uncertaintyMs};
 }
 finish(outcome:'applied'|'denied'|'expired'|'unknown'|'unsupported'|'cancelled'|'stale'){
  if(!['applied','denied','expired','unknown','unsupported','cancelled','stale'].includes(outcome))throw Error('latency_outcome_invalid');
  if(outcome==='applied'&&!this.points.pi_applied)throw Error('applied_not_observed');
  const point=this.points.pi_applied,elapsed=point?.elapsedMs??null,budgetMs=this.deadline-this.emission.wallMs;
  const deadlineAssessment=outcome==='expired'?'missed':!point?'not_applied':elapsed===null||point.uncertaintyMs===null?'unknown_clock_error':elapsed-point.uncertaintyMs>budgetMs?'missed':elapsed+point.uncertaintyMs<=budgetMs?'within_deadline':'unknown_clock_error';
  return {schema:'fleet-relay-latency/v1',eventId:this.eventId,mode:this.mode,emittedAt:new Date(this.emission.wallMs).toISOString(),originalDeadline:new Date(this.deadline).toISOString(),budgetMs,outcome,phases:structuredClone(this.points),deadlineAssessment,deadlineMiss:deadlineAssessment==='missed',piAppliedScope:'one_use_authority_consumption_not_tool_completion',modelInferredFromAck:false};
 }
}
export type LatencySample=ReturnType<RelayLatencyTrace['finish']>;
const stats=(values:number[])=>{const v=[...values].sort((a,b)=>a-b);return v.length?{count:v.length,p50:v[Math.ceil(v.length*.5)-1],p95:v[Math.ceil(v.length*.95)-1],max:v.at(-1)!}:null;};
export function summarizeLatency(samples:LatencySample[]){
 if(!samples.length||samples.length>200)throw Error('latency_series_invalid');
 const phase=(key:LatencyStage)=>stats(samples.flatMap(s=>{const p=s.phases[key];return p?.elapsedMs!==null&&p?.elapsedMs!==undefined&&p.uncertaintyMs===0?[p.elapsedMs]:[];}));
 return {schema:'fleet-relay-latency-series/v1',count:samples.length,percentileMethod:'nearest_rank',noModelSloEvidence:samples.some(s=>s.mode==='fixture_no_model'||s.phases.model_observed?.elapsedMs==null||s.phases.model_observed.uncertaintyMs!==0),deadlineMisses:samples.filter(s=>s.deadlineMiss).length,unknownClock:samples.filter(s=>s.deadlineAssessment==='unknown_clock_error').length,unknown:samples.filter(s=>s.outcome==='unknown').length,unsupported:samples.filter(s=>s.outcome==='unsupported').length,outcomes:Object.fromEntries(['applied','denied','expired','unknown','unsupported','cancelled','stale'].map(k=>[k,samples.filter(s=>s.outcome===k).length])),piAppliedMs:phase('pi_applied'),queueAcceptedMs:phase('queue_accepted'),modelObservedMs:phase('model_observed'),samples};
}
/** Driver injection keeps real model/host actions outside the local harness. A live
 * series needs NEW explicit coordinator authorization for this exact count/profile. */
export async function runLatencySeries(options:{mode:LatencyMode;count:number;confirmSeries?:()=>Promise<boolean>;run(index:number):Promise<LatencySample>}){
 if(!['fixture_no_model','live'].includes(options.mode))throw Error('latency_mode_invalid');
 if(!Number.isSafeInteger(options.count)||options.count<20||options.count>200)throw Error('latency_series_count');
 if(options.mode==='live'&&(!options.confirmSeries||!await options.confirmSeries()))throw Error('live_series_not_authorized');
 const samples:LatencySample[]=[];for(let i=0;i<options.count;i++){const sample=await options.run(i);if(sample.mode!==options.mode)throw Error('latency_mode_mismatch');samples.push(sample);}
 return summarizeLatency(samples);
}
