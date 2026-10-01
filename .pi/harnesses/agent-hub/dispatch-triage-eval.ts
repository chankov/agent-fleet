import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { System1Result, System1Service } from "../lib/system1/contracts.ts";
import { createSystem1Runtime } from "../lib/system1/service.ts";
import { system1SelectedByDesired } from "../lib/system1/selection.js";
import { parseTriageConfig, triageQuestions, TRIAGE_VERSION, type TriageInput, type TriageConfig } from "./dispatch-triage-contract.ts";
import { buildTriageState } from "./dispatch-triage-state.ts";
import { triageAdvice } from "./dispatch-triage-policy.ts";
export interface TriageExample {
 id: string; group: string; split: "calibration" | "held-out"; origin: "synthetic" | "real-redacted";
 labelRevision: string; rationale: string; remoteApproved: boolean; input: TriageInput;
 labels: { personas: string[]; touches_security: boolean | null; is_destructive: boolean | null; decomposition: boolean | null };
 baseline?: string; replay?: System1Result;
}
export function validateCorpus(value: unknown): TriageExample[] {
 if (!Array.isArray(value) || !value.length) throw new Error("Corpus must be a nonempty array");
 const ids = new Set<string>(), groups = new Map<string,string>();
 for (const e of value as TriageExample[]) {
  if (!e || typeof e.id !== "string" || !e.id || ids.has(e.id) || typeof e.group !== "string" || !e.group || !["calibration","held-out"].includes(e.split) || !["synthetic","real-redacted"].includes(e.origin) || !e.labelRevision || !e.rationale || typeof e.remoteApproved !== "boolean") throw new Error("Invalid corpus identity, review or provenance");
  ids.add(e.id); if (groups.has(e.group) && groups.get(e.group) !== e.split) throw new Error("Group leakage between splits"); groups.set(e.group,e.split);
  const i=e.input;
  if (!i || typeof i.task !== "string" || typeof i.taskId !== "string" || typeof i.constraints !== "string" || typeof i.language !== "string" || typeof i.domain !== "string" || typeof i.complete !== "boolean" || !Array.isArray(i.scope) || !i.scope.every(x => typeof x === "string") || !Array.isArray(i.candidates) || !i.candidates.every(c => typeof c.name === "string" && typeof c.description === "string" && (c.excluded === undefined || typeof c.excluded === "string"))) throw new Error("Invalid input snapshot");
  if (!e.labels || !Array.isArray(e.labels.personas) || !e.labels.personas.length || !e.labels.personas.every(n => n === "none" || i.candidates.some(c => !c.excluded && c.name === n)) || ![e.labels.touches_security,e.labels.is_destructive,e.labels.decomposition].every(v => v === null || typeof v === "boolean")) throw new Error("Invalid human labels");
 }
 return value;
}
export async function evaluateCorpus(corpus: TriageExample[], config: TriageConfig, options: { service?: System1Service; maxCalls?: number; maxMs?: number } = {}) {
 const live = !!options.service;
 if (live && (!config.remoteContextApproved || !Number.isSafeInteger(options.maxCalls) || options.maxCalls! <= 0 || !Number.isSafeInteger(options.maxMs) || options.maxMs! <= 0 || corpus.some(e => !e.remoteApproved))) throw new Error("Live requires approved corpus, remote consent and explicit call/time limits");
 const records: Array<Record<string,unknown>> = []; let calls=0;
 const deadline = live ? Date.now()+options.maxMs! : Infinity;
 for (const e of corpus) {
  const state = buildTriageState(e.input,config); let result: System1Result | undefined;
  let reason: string | undefined;
  if (!state.ok) reason=state.reason;
  else if (!live) result=e.replay;
  else if (calls >= Math.min(config.maxCalls,options.maxCalls!) || Date.now() >= deadline) reason="experiment_budget";
  else {
   calls++; const controller=new AbortController(); const timer=setTimeout(() => controller.abort(), Math.max(1,deadline-Date.now()));
   try { result=await options.service!.evaluate({ state:state.state,questions:triageQuestions(state.candidates),questionSetVersion:TRIAGE_VERSION,requiredCapabilities:["distribution","probability_true"],signal:controller.signal }); }
   catch { result={status:"unavailable",reason:"network"}; } finally {clearTimeout(timer);}
  }
  let advice: ReturnType<typeof triageAdvice> | undefined;
  try { advice=result ? triageAdvice(result,e.input,config.profile) : undefined; } catch { reason="invalid_replay"; }
  const modelChoice = advice?.uncertainty ? Object.entries(advice.uncertainty.distribution).sort((a,b)=>b[1]-a[1])[0]?.[0] : undefined;
  const choice = advice?.persona ?? (advice?.status === "abstain" ? "none" : undefined);
  const risk=(key: "touches_security"|"is_destructive", threshold: number | undefined) => e.labels[key] === null || advice?.risks === undefined || threshold === undefined || advice.status === "uncalibrated" ? null : { expected:e.labels[key],predicted:advice.risks[key]>=threshold };
  records.push({ id:e.id,split:e.split,origin:e.origin,language:e.input.language,domain:e.input.domain,modelChoice:modelChoice??null,modelCorrect:modelChoice === undefined ? null : e.labels.personas.includes(modelChoice),distribution:advice?.uncertainty?.distribution??null,status:advice?.status??reason??"missing_replay",correct:choice === undefined ? null : e.labels.personas.includes(choice),baselineCorrect:e.baseline === undefined ? null : e.labels.personas.includes(e.baseline),agreement:choice === undefined || e.baseline === undefined ? null : choice===e.baseline,security:risk("touches_security",config.profile?.securityThreshold),destructive:risk("is_destructive",config.profile?.destructiveThreshold),decomposition:advice?.complexity === undefined || e.labels.decomposition === null ? null : (advice.complexity === 2) === e.labels.decomposition,confidence:advice?.uncertainty?.confidence??null,margin:advice?.uncertainty?.margin??null,latencyMs:result?.status === "ok" ? result.evaluation.metadata.latencyMs : null,attempts:result?.status === "ok" ? result.evaluation.metadata.attempts : null,usage:result?.status === "ok" ? result.evaluation.metadata.usage??null : null });
 }
 const count=(key:string,value:unknown)=>records.filter(r=>r[key]===value).length;
 const confusion=(key:string)=>({ truePositive:records.filter(r=>(r[key] as any)?.expected===true&&(r[key] as any)?.predicted===true).length,falseNegative:records.filter(r=>(r[key] as any)?.expected===true&&(r[key] as any)?.predicted===false).length,falsePositive:records.filter(r=>(r[key] as any)?.expected===false&&(r[key] as any)?.predicted===true).length,trueNegative:records.filter(r=>(r[key] as any)?.expected===false&&(r[key] as any)?.predicted===false).length,unknown:count(key,null) });
 const strata = Object.fromEntries(["split","origin","language","domain"].map(key => [key,Object.fromEntries([...new Set(records.map(r=>String(r[key])))].map(value=>{const subset=records.filter(r=>String(r[key])===value);return [value,{count:subset.length,correct:subset.filter(r=>r.correct===true).length,incorrect:subset.filter(r=>r.correct===false).length,unknown:subset.filter(r=>r.correct===null).length,modelCorrect:subset.filter(r=>r.modelCorrect===true).length}];}))]));
 const digest=createHash("sha256").update(JSON.stringify(corpus)).digest("hex");
 return { version:TRIAGE_VERSION, corpusDigest:digest,strata, mode:live?"live":"offline-replay", profile:config.profile??null, count:records.length,calls,correct:count("correct",true),incorrect:count("correct",false),unknown:count("correct",null),abstentions:count("status","abstain"),security:confusion("security"),destructive:confusion("destructive"),cost:null,calibrationAccepted:false,notice:"No automatic calibration approval. Synthetic/replay evidence is not live accuracy. Failures remain in the denominator. Cost unknown, not zero. Review records by split/origin/language/domain.",records };
}
export async function runTriageEvaluator(argv=process.argv.slice(2)) {
 const value=(key:string)=>{const i=argv.indexOf(key);return i<0?undefined:argv[i+1];};
 if (argv.includes("--help") || !argv.length) { console.log("dispatch-triage-eval --corpus FILE --config FILE [--live --max-calls N --max-ms N --workspace DIR]\nOffline replay by default. Live requires per-example consent and explicit budgets. No dotenv loading."); return; }
 const corpusFile=value("--corpus"),configFile=value("--config");
 if (!corpusFile || !configFile) throw new Error("Explicit --corpus and --config required");
 const corpus=validateCorpus(JSON.parse(readFileSync(corpusFile,"utf8"))),config=parseTriageConfig(JSON.parse(readFileSync(configFile,"utf8")));
 if (!config) throw new Error("Invalid triage config");
 let service: System1Service | undefined;
 if (argv.includes("--live")) {
  const workspace=value("--workspace"); if (!workspace) throw new Error("Live requires explicit --workspace");
  // Consent and budget validation happens before constructing the provider or reading its key.
  if (!config.remoteContextApproved || corpus.some(e=>!e.remoteApproved) || !Number.isSafeInteger(Number(value("--max-calls"))) || Number(value("--max-calls"))<=0 || !Number.isSafeInteger(Number(value("--max-ms"))) || Number(value("--max-ms"))<=0) throw new Error("Live consent or budgets missing");
  const desired=JSON.parse(readFileSync(resolve(workspace,".ai/agent-fleet.json"),"utf8"));
  const runtime=createSystem1Runtime({selected:system1SelectedByDesired(desired),config:JSON.parse(readFileSync(resolve(workspace,".ai/system1.json"),"utf8")),env:process.env});
  if (runtime.readiness.status!=="ready") throw new Error("System 1 unavailable"); service=runtime.service;
 }
 console.log(JSON.stringify(await evaluateCorpus(corpus,config,{service,maxCalls:Number(value("--max-calls")),maxMs:Number(value("--max-ms"))}),null,2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runTriageEvaluator().catch(()=>{console.error("Triage evaluation refused or failed; check schema, consent, budget and local files. No raw payload printed.");process.exitCode=1;});
