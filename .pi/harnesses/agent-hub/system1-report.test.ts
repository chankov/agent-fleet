import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createProactiveRuntime } from "./proactive-runtime.ts";
import { discoverRules } from "./proactive-rules.ts";
import { createProactiveEvaluator } from "./proactive-evaluate.ts";
import { loadProactiveLabels } from "./system1-report.ts";
import { proactiveEvidenceContent } from "../lib/fleet-detail-view.ts";
import { parseProactiveConfig } from "./proactive-config.ts";
import { createWatchdogActivity } from "./system1-activity.ts";
import { buildWatchdogReport, buildProactiveReport, commandProactiveLabels, formatWatchdogStatus, readWatchdogEvents, watchdogEvents } from "./system1-report.ts";
import { registerAudit } from "./commands/audit.ts";
import { registerHubReport } from "./commands/hub-report.ts";
import { buildSessionAudit } from "./session-audit.ts";

const id = { dispatchId: "dispatch-1", attemptId: "attempt-1", checkId: "check-1", snapshotId: "snapshot-1", llmAttemptId: "llm-1" };
test("T10 readback counts checks, evaluations, LLM attempts separately without worker tokens or secrets", t => {
 const dir = mkdtempSync(join(tmpdir(), "af-report-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = createWatchdogActivity({ directory: join(dir, "artifacts/watchdog"), sessionId: "session-1" });
 activity.evaluationStarted({ ...id, configuredMode: "shadow", effectiveMode: "shadow" });
 activity.llmStarted(id);
 activity.evaluationFinished({ ...id, status: "unavailable", reason: "timeout", elapsedMs: 11, usage: null });
 activity.llmFinished({ ...id, status: "unavailable" });
 activity.decision({ ...id, source: "llm", outcome: "judge_unavailable", applied: "no" });
 const events = watchdogEvents(dir);
 assert.equal(events.length, 5);
 const report = buildWatchdogReport(events, activity.live());
 assert.equal(report.checks, 1); assert.equal(report.evaluations.started, 1); assert.equal(report.llm.started, 1);
 assert.equal(report.llm.parallel, 1); assert.equal(report.llm.fallback, 0);
 assert.deepEqual(report.evaluations.byStatus, { unavailable: 1 });
 assert.deepEqual(report.usage, { known: 0, unknown: 1, inputTokens: 0, outputTokens: 0 });
 assert.equal(report.latencyMs.p95, 11);
 assert.equal(report.decisions["llm:judge_unavailable:no"], 1);
 assert.doesNotMatch(JSON.stringify(report), /task|secret|raw prompt/);
});
test("C5 malformed line and incomplete tail remain visible without leaking their contents", t => {
 const dir = mkdtempSync(join(tmpdir(), "af-report-corrupt-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
 const activity = createWatchdogActivity({ directory: join(dir, "artifacts/watchdog"), sessionId: "session-1" });
 activity.evaluationStarted(id);
 appendFileSync(activity.path!, "{broken secret-sentinel}\n{unfinished secret-sentinel");
 const trace = readWatchdogEvents(dir);
 assert.equal(trace.events.length, 1);
 assert.deepEqual(trace.integrity, { invalidRecords: 1, partialTail: true, readError: false });
 const report = buildWatchdogReport(trace.events, null, trace.integrity);
 assert.equal(report.observability.degraded, true);
 assert.equal(report.observability.invalidRecords, 1);
 assert.equal(report.observability.partialTail, true);
 assert.doesNotMatch(JSON.stringify(report), /secret-sentinel/);
});

test("T10 incomplete trace and headless/off status never claim successful inference", () => {
 const base = { schema: "watchdog-trace/v1", consumer: "watchdog", sessionId: "session-1", ...id, sequence: 1, at: 1, policyVersion: "none" } as const;
 const report = buildWatchdogReport([{ ...base, type: "evaluation_started" }]);
 assert.equal(report.evaluations.incomplete, 1); assert.equal(report.evaluations.finished, 0);
 assert.equal(report.latencyMs.p50, null);
 assert.equal(report.observability.duplicateEvents, 0);
 const duplicated = buildWatchdogReport([{ ...base, type: "evaluation_started" }, { ...base, type: "evaluation_started", sequence: 2 }]);
 assert.equal(duplicated.observability.duplicateEvents, 1);
 assert.equal(duplicated.observability.degraded, true);
 assert.match(formatWatchdogStatus(null, null), /effective off/);
});

test("P12 proactive report dedupes turns/evaluations, keeps gaps/unknowns and never copies payload", async () => {
 const { buildProactiveReport, compareProactiveLabels } = await import("./system1-report.ts");
 const h="a".repeat(64), base={schema:"proactive-review-trace/v1",consumer:"proactive-review",sessionId:"fixture",jobId:h} as const;
 const events:any[]=[{...base,type:"job_started",at:10,sequence:1},{...base,type:"evaluation_started",evaluationId:"b".repeat(64),at:11,sequence:2},{...base,type:"evaluation_finished",evaluationId:"b".repeat(64),at:20,sequence:3,status:"ok"},{...base,type:"evaluation_started",evaluationId:"c".repeat(64),at:21,sequence:4},{...base,type:"evaluation_finished",evaluationId:"c".repeat(64),at:30,sequence:5,status:"ok"},{...base,type:"job_finished",at:35,sequence:6,status:"reviewed"}];
 const assessment:any={status:"reviewed",gaps:[],findings:[],rules:[],drift:{task:"aligned",plan:"not_checked"},evaluations:[{status:"ok",metadata:{provider:"SECRET_PAYLOAD",latencyMs:9,usage:{inputTokens:3,outputTokens:2}}},{status:"unavailable",reason:"SECRET_PAYLOAD"}]};
 const record:any={owner:"SECRET_PAYLOAD",attempt:"one",turnId:"one",status:"reviewed",assessment,paths:["SECRET_PAYLOAD"],uncheckedPaths:[]};
 const input:any={records:[record,record],history:[{turnId:"one",coverage:{status:"checked",gaps:[],checked:[]},findings:[]}],current:[{id:h,source:"system1",state:"current",subject:"SECRET_PAYLOAD"}],activity:[...events,events[0]]};
 const result=buildProactiveReport(input);
 assert.equal(result.turns.observed,1);assert.equal(result.turns.reviewed,1);assert.equal(result.evaluations.started,2);assert.equal(result.observability.duplicateEvents,2);
 assert.equal(result.usage.known,1);assert.equal(result.usage.unknown,1);assert.equal(result.usage.inputTokens,3);assert.equal(result.latencyMs.p95,25);
 assert.equal(result.findings.system1Suspicions,1);assert.equal(result.feedback.nativeDelivered,null);assert.equal(result.labels.precision,null);
 assert.doesNotMatch(JSON.stringify(result),/SECRET_PAYLOAD/);
 const partial=buildProactiveReport({...input,records:[{...record,status:"not_checked"}],history:[{turnId:"one",coverage:{status:"partial",gaps:["SECRET_PAYLOAD"],checked:[]}}]});
 assert.equal(partial.turns.reviewed,0);assert.equal(partial.turns.partial,1);assert.equal(partial.coverage.gapCount,1);assert.doesNotMatch(JSON.stringify(partial),/SECRET_PAYLOAD/);
 const skipped=buildProactiveReport({...input,records:[{...record,status:"no_new_evidence",assessment:undefined}],history:[],activity:[]});
 assert.equal(skipped.turns.eligible,0);assert.equal(skipped.turns.reviewed,0);assert.equal(skipped.turns.skipped,1);
 assert.equal(compareProactiveLabels().availability,"unavailable");
 assert.equal(result.labels.falseAlarms,null);assert.equal(result.turns.coverageUnknown,0);
 const label={snapshotId:h,ruleHash:h,ruleId:"rule",subject:"src/a.ts",expected:"violation" as const};
 assert.equal(compareProactiveLabels([label],[],[]).unchecked,1);
 assert.equal(compareProactiveLabels([{...label,observed:"finding"} as any],[],[]).invalid,1);
 assert.equal(buildProactiveReport().availability,"unavailable");
});

test("P12 trace-only crash readback cannot invent reviewed turns or known findings", async t => {
 const { readProactiveReport }=await import("./system1-report.ts");
 const { createProactiveActivity }=await import("./system1-activity.ts");
 const dir=mkdtempSync(join(tmpdir(),"proactive-report-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const a=createProactiveActivity({directory:join(dir,"artifacts","proactive-activity")});a.jobStarted("a".repeat(64));
 const report=readProactiveReport(dir);assert.equal(report.availability,"trace-only");assert.equal(report.turns.reviewed,null);assert.equal(report.observability.incompleteJobs,1);
 appendFileSync(a.path!,"{SECRET_PAYLOAD}\n");const corrupt=readProactiveReport(dir);assert.equal(corrupt.observability.invalidRecords,1);assert.doesNotMatch(JSON.stringify(corrupt),/SECRET_PAYLOAD/);
});

test("P12 retained history eviction does not lose turn buckets; attempt gaps are separate", async () => {
 const { buildProactiveReport }=await import("./system1-report.ts");
 const good:any={status:"reviewed",gaps:[],findings:[],rules:[],drift:{task:"aligned",plan:"not_checked"},evaluations:[],ruleCoverage:[]};
 const records:any[]=Array.from({length:150},(_,i)=>({owner:"hub",attempt:"direct",turnId:`turn-${i}`,status:"reviewed",paths:[],uncheckedPaths:[],assessment:good}));
 records.push({owner:"child",attempt:"attempt",turnId:"attempt:observer",status:"not_instrumented",paths:[],uncheckedPaths:[]});
 const history:any[]=records.slice(50,150).map(r=>({turnId:r.turnId,coverage:{status:"checked",gaps:[],checked:[]},findings:[]}));
 const report=buildProactiveReport({records,history,current:[],activity:[]});
 assert.equal(report.turns.observed,150);assert.equal(report.turns.reviewed,150);assert.equal(report.turns.coverageUnknown,0);assert.equal(report.attempts.notInstrumented,1);
 const unknown=buildProactiveReport({records:[{...records[0],assessment:undefined}],history:[],current:[],activity:[]});
 assert.equal(unknown.turns.reviewed,0);assert.equal(unknown.turns.coverageUnknown,1);
});

test("P12 unavailable local assessment and real partial history occupy only skipped bucket", async () => {
 const digest=(text:string)=>createHash("sha256").update(text).digest("hex");
 const text="[bad](/absolute.md)\n", ruleText="# Links\nUse relative links.\n", ruleHash=digest(ruleText);
 const rule={path:"rules/links.md",heading:"Links",occurrence:1,hash:ruleHash};
 const config=parseProactiveConfig({version:1,mode:"shadow",include:["docs/**"],localBindings:[{version:1,validator:"relative-markdown-links",rule,applicability:{paths:["docs/**"],kinds:["added","modified"]},exceptions:{paths:[],legacy:false}}]});
 const snapshot:any={snapshotId:digest("snap"),turnId:"session:hub:direct:0",head:"",context:{task:{path:"task",revision:"1",hash:digest("task")},rules:[{path:rule.path,revision:ruleHash,hash:ruleHash}],exceptions:[]},planStatus:"task_only",status:"complete",gaps:[],units:[{id:"u",path:"docs/new.md",kind:"added",attribution:"observed_only",after:{text,hash:digest(text),offset:0,endOffset:Buffer.byteLength(text),startLine:1,endLine:2,truncated:false}}],observedPaths:1,coverage:{retainedUnits:1,retainedBytes:Buffer.byteLength(text),omittedPaths:0}};
 const runtime=createProactiveRuntime({config,localSections:[{id:`rules/links.md#Links@1:${ruleHash}`,source:{path:rule.path,revision:ruleHash,hash:ruleHash},heading:"Links",occurrence:1,text:ruleText,context:"",kind:"default"}],evaluate:async()=>{throw Error("offline rejection");}});
 assert.equal(runtime.submit("hub","direct",snapshot,0),true);
 for(let i=0;i<100&&!runtime.records.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(runtime.records[0]?.status,"unavailable");assert.equal(runtime.records[0]?.assessment?.status,"not_checked");
 assert.equal(runtime.findings.history[0]?.coverage.status,"partial");
 const report=buildProactiveReport({records:runtime.records,history:runtime.findings.history,current:runtime.findings.current,activity:runtime.activity.live()});
 assert.deepEqual([report.turns.observed,report.turns.reviewed,report.turns.partial,report.turns.coverageUnknown,report.turns.skipped],[1,0,0,0,1]);
 assert.equal(report.turns.observed,report.turns.reviewed+report.turns.partial+report.turns.coverageUnknown+report.turns.skipped);
});

test("P12 mixed skipped cancelled budget and capture gaps never claim complete uncovered inventory", () => {
 const base:any={owner:"hub",attempt:"direct",paths:[],uncheckedPaths:[]};
 const records:any[]=[{...base,turnId:"reviewed",status:"reviewed",assessment:{status:"reviewed",gaps:[],evaluations:[],ruleCoverage:[{ruleId:"rule",ruleHash:"a".repeat(64),status:"not_selected",reason:"budget"}]}},...(["cancelled","session_budget","not_checked","superseded"] as const).map((status,i)=>({...base,turnId:`missing-${i}`,status})),{...base,turnId:"empty",status:"no_new_evidence"}];
 const input={records,history:[],current:[],activity:[]};
 const mixed=buildProactiveReport(input);
 assert.equal(mixed.coverage.uncoveredRulesKnown,false);assert.equal(mixed.coverage.turnsWithoutRuleInventory,4);
 assert.equal(mixed.coverage.uncoveredRules.length,1);
 assert.equal(mixed.turns.observed,mixed.turns.reviewed+mixed.turns.partial+mixed.turns.coverageUnknown+mixed.turns.skipped);
 const complete=buildProactiveReport({...input,records:[records[0],records.at(-1)]});
 assert.equal(complete.coverage.uncoveredRulesKnown,true);assert.equal(complete.coverage.turnsWithoutRuleInventory,0);
});

test("P12 labels join checked ledger, not asserted outcomes; conflicts and omissions remain unknown", async () => {
 const { buildProactiveReport }=await import("./system1-report.ts");
 const h="a".repeat(64), r="b".repeat(64), snapshotId=h;
 const label=(ruleId:string,subject:string,expected:"violation"|"clean"|"unknown")=>({snapshotId,ruleHash:r,ruleId,subject,expected});
 const base:any={owner:"hub",attempt:"direct",turnId:"turn",snapshotId,status:"reviewed",paths:[],uncheckedPaths:[],assessment:{status:"reviewed",gaps:[],evaluations:[],ruleCoverage:[{ruleId:"omitted",ruleHash:r,status:"not_selected",reason:"budget"},{ruleId:"maybe",ruleHash:r,status:"uncertain",reason:"selection"},{ruleId:"low",ruleHash:r,status:"insufficient",reason:"insufficient_evidence"}],checkedUnits:[{ruleId:"clear",ruleHash:r,subject:"src/clear.ts",verdict:"no_observed_violation"}]}};
 const finding:any={id:h,source:"system1",state:"current",snapshotId,ruleId:"found",ruleHash:r,subject:"src/found.ts"};
 const input:any={records:[base,base],history:[{turnId:"turn",coverage:{status:"checked",gaps:[],checked:[]},findings:[finding]}],current:[finding],activity:[]};
 const labels=[label("found","src/found.ts","clean"),label("clear","src/clear.ts","violation"),label("omitted","src/other.ts","violation"),label("unknown","src/unknown.ts","unknown")];
 const report=buildProactiveReport({...input,labels});
 assert.equal(report.labels.falseAlarms,1);assert.equal(report.labels.misses,1);assert.equal(report.labels.unchecked,1);assert.equal(report.labels.unknown,1);
 assert.equal(report.labels.precision,0);assert.equal(report.labels.recall,0);
 assert.equal(report.coverage.uncoveredRules.length,3);assert.equal(report.coverage.uncoveredRules[0].count,1);
 assert.match(report.coverage.uncoveredRules[0].ruleId,/^[a-f0-9]{64}$/);
 assert.equal(report.turns.observed,1);assert.doesNotMatch(JSON.stringify(report),/SECRET_PAYLOAD|src\/found|src\/clear/);
 const conflict=buildProactiveReport({...input,labels:[labels[0],{...labels[0],expected:"violation"},labels[0],{...labels[0],observed:"finding"}]});
 assert.equal(conflict.labels.labelled,0);assert.equal(conflict.labels.falseAlarms,0);assert.equal(conflict.labels.conflicts,1);assert.equal(conflict.labels.invalid,2);
 const privateRule=buildProactiveReport({...input,records:[{...base,assessment:{...base.assessment,ruleCoverage:[{ruleId:"SECRET_PAYLOAD heading",ruleHash:r,status:"not_selected",reason:"budget"}]}}]});
 assert.doesNotMatch(JSON.stringify(privateRule),/SECRET_PAYLOAD/);
 const forged=buildProactiveReport({...input,labels:[label("found","src/forged.ts","clean")]});
 assert.equal(forged.labels.unchecked,1);assert.equal(forged.labels.falseAlarms,0);
});

test("P12 report and audit registrars execute explicit label arguments against live ledger without side effects", async t => {
 const dir=mkdtempSync(join(tmpdir(),"af-label-commands-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,"artifacts"));
 const h="a".repeat(64), r="b".repeat(64), label={snapshotId:h,ruleId:"rule",ruleHash:r,subject:"src/a.ts",expected:"clean"};
 const input:any={records:[{owner:"hub",attempt:"direct",turnId:"one",snapshotId:h,status:"reviewed",paths:[],uncheckedPaths:[],assessment:{status:"reviewed",gaps:[],evaluations:[],checkedUnits:[]}}],history:[{turnId:"one",coverage:{status:"checked",gaps:[],checked:[]},findings:[{id:h,source:"system1",state:"current",snapshotId:h,ruleId:"rule",ruleHash:r,subject:"src/a.ts"}]}],current:[],activity:[]};
 const file=join(dir,"artifacts","labels.json"), outside=join(dir,"outside.json"), link=join(dir,"artifacts","link.json");
 writeFileSync(file,JSON.stringify([label]));writeFileSync(outside,JSON.stringify([label]));symlinkSync(outside,link);
 const handlers=new Map<string,(args:string,ctx:any)=>Promise<void>>(), notices:string[]=[];
 const pi:any={registerCommand:(name:string,spec:any)=>handlers.set(name,spec.handler)};
 const context:any={handleHubReport:async (args:string,ctx:any)=>ctx.ui.notify(JSON.stringify(buildProactiveReport({...input,labels:commandProactiveLabels(dir,args)})),"info"),handleAudit:async (ctx:any,args="")=>ctx.ui.notify(JSON.stringify(buildSessionAudit({entries:[],sessionDir:dir,proactive:{...input,labels:commandProactiveLabels(dir,args)}}).proactive),"info")};
 registerHubReport(pi,context);registerAudit(pi,context);
 const ctx:any={ui:{notify:(text:string)=>notices.push(text)}};
 for(const name of ["af-hub-report","af-audit"]){
  const invoke=async (arg:string)=>{await handlers.get(name)!(arg,ctx);return JSON.parse(notices.pop()!)};
  const absent=await invoke("");assert.equal(absent.labels.availability,"unavailable");assert.equal(absent.labels.falseAlarms,null);
  const before=statSync(file).mtimeMs, files=readdirSync(join(dir,"artifacts"));
  const matched=await invoke(`--labels ${file}`);assert.equal(matched.labels.availability,"available");assert.equal(matched.labels.falseAlarms,1);assert.equal(matched.labels.misses,0);assert.equal(matched.turns.observed,1);
  assert.equal(statSync(file).mtimeMs,before);assert.deepEqual(readdirSync(join(dir,"artifacts")),files);
  for(const arg of ["--labels",`--labels ${outside}`,`--labels ${link}`,"--labels relative.json",`--labels ${file} --extra`,"--bad SECRET_PAYLOAD"]){
   const report=await invoke(arg);assert.equal(report.labels.availability,"unavailable");assert.equal(report.labels.falseAlarms,null);assert.doesNotMatch(JSON.stringify(report),/SECRET_PAYLOAD|src\/a\.ts|outside\.json/);
  }
  writeFileSync(file,"{SECRET_PAYLOAD");assert.equal((await invoke(`--labels ${file}`)).labels.availability,"unavailable");
  writeFileSync(file,"x".repeat(65537));assert.equal((await invoke(`--labels ${file}`)).labels.availability,"unavailable");
  writeFileSync(file,JSON.stringify([{...label,subject:"src/unmatched.ts"}]));
  const unmatched=await invoke(`--labels ${file}`);assert.equal(unmatched.labels.availability,"available");assert.equal(unmatched.labels.unchecked,1);assert.equal(unmatched.labels.falseAlarms,0);
  writeFileSync(file,JSON.stringify([label]));
  assert.equal(unmatched.readOnly,true);
 }
 assert.deepEqual(JSON.parse(readFileSync(file,"utf8")),[label]);
});

test("explicit labels accept a safe temporary-root alias", t => {
 const sandbox = mkdtempSync(join(tmpdir(), "labels-root-alias-")); t.after(() => rmSync(sandbox, { recursive: true, force: true }));
 const actual = join(sandbox, "actual"), alias = join(sandbox, "alias");
 mkdirSync(join(actual, "artifacts"), { recursive: true }); symlinkSync(actual, alias);
 const h = "a".repeat(64), label = { snapshotId: h, ruleHash: h, ruleId: "rule", subject: "src/a.ts", expected: "clean" as const };
 const file = join(alias, "artifacts", "labels.json"); writeFileSync(file, JSON.stringify([label]));
 assert.deepEqual(loadProactiveLabels(alias, file), [label]);
});

test("D1 discovered slash ID passes real evaluator, findings ledger and explicit human label join", async t => {
 const dir=mkdtempSync(join(tmpdir(),"label-real-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,"rules"));mkdirSync(join(dir,".ai/rules"),{recursive:true});mkdirSync(join(dir,"artifacts"));
 writeFileSync(join(dir,"rules/README.md"),"# Required writing rule\nAvoid broken links.\n");
 writeFileSync(join(dir,".ai/rules/local.md"),"# Paths a/../b 🐈 漢字\nAvoid broken links.\n");
 const catalog=discoverRules(dir,["rules",".ai/rules"]);
 assert.equal(catalog.sections.length,2);
 assert.ok(catalog.sections.some(s=>s.id.startsWith("rules/README.md#Required writing rule@1:")));
 assert.ok(catalog.sections.some(s=>s.id.startsWith(".ai/rules/local.md#Paths a/../b 🐈 漢字@1:")));
 for (const section of catalog.sections) {
 const digest=(s:string)=>createHash("sha256").update(s).digest("hex"), text="[broken](/absolute.md)\n", snapshotId=digest(section.id);
 const config=parseProactiveConfig({version:1,mode:"shadow",remoteContext:"selected-excerpts",include:["docs/**"]});
 const selection:any={selected:[section],coverage:[],gaps:[],status:"complete",cacheKey:"bound"};
 const snapshot:any={snapshotId,turnId:"session:hub:direct:0",head:"",context:{task:{path:"task",revision:"1",hash:digest("task")},rules:[section.source],exceptions:[]},planStatus:"task_only",status:"complete",gaps:[],units:[{id:"u",path:"docs/new.md",kind:"added",attribution:"observed_only",after:{text,hash:digest(text),offset:0,endOffset:Buffer.byteLength(text),startLine:1,endLine:2,truncated:false}}],observedPaths:1,coverage:{retainedUnits:1,retainedBytes:Buffer.byteLength(text),omittedPaths:0}};
 let calls=0;
 const service:any={evaluate:async (request:any)=>{calls++;return {status:"ok",evaluation:{metadata:{provider:"offline-fixture",requestedModel:"fixture",returnedModel:"fixture",questionSetVersion:request.questionSetVersion,latencyMs:1,attempts:1},answers:request.questions.map((q:any)=>({questionId:q.id,type:"choice",value:q.id==="drift"?"aligned":"potential_violation",uncertainty:{provenance:"provider",confidence:.99}}))}};}};
 const evaluate=createProactiveEvaluator({config,service,taskText:"task",selection});
 const runtime=createProactiveRuntime({config,evaluate});assert.equal(runtime.submit("hub","direct",snapshot,0),true);
 for(let i=0;i<100&&!runtime.records.length;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(calls,1);assert.equal(runtime.records[0]?.status,"reviewed");
 const finding=runtime.findings.history[0]?.findings.find(f=>f.ruleId===section.id);
 assert.ok(finding,"real evaluator finding must be retained");
 const chunks=proactiveEvidenceContent("captured",finding as any,17);
 const begin=chunks.findIndex(line=>line.startsWith(" {"));
 assert.ok(begin>=0,"template offered for real catalog ID");
 const tail=chunks.slice(begin).findIndex(line=>line === " captured");
 assert.ok(tail>0);
 const json=chunks.slice(begin,begin+tail).map(line=>line.slice(1)).join("");
 assert.ok(chunks.slice(begin,begin+tail).every(line=>line.length<=17 && !/[^\x00-\x7f]/.test(line)));
 const key=JSON.parse(json);assert.deepEqual(key,{snapshotId:finding.snapshotId,ruleId:finding.ruleId,ruleHash:finding.ruleHash,subject:finding.subject,expected:"unknown"});
 if(section.id.includes("漢字")) assert.match(json,/\\ud83d\\udc08.*\\u6f22\\u5b57/);
 const file=join(dir,"artifacts","human-labels.json");
 for (const [expected,tp,fa] of [["violation",1,0],["clean",0,1]] as const) {
  const label={...key,expected};writeFileSync(file,JSON.stringify([label]));
  assert.deepEqual(loadProactiveLabels(dir,file),[label]);
  const report=buildProactiveReport({records:runtime.records,history:runtime.findings.history,current:runtime.findings.current,activity:runtime.activity.live(),labels:loadProactiveLabels(dir,file)});
  assert.equal(report.labels.truePositives,tp);assert.equal(report.labels.falseAlarms,fa);
  assert.doesNotMatch(JSON.stringify(report),/rules\/README|local\.md|docs\/new\.md|offline-fixture/);
 }
 }
});

test("P12 explicit labels loader rejects malformed, oversized, symlink and outside paths without payloads", async t => {
 const { loadProactiveLabels }=await import("./system1-report.ts");
 const dir=mkdtempSync(join(tmpdir(),"labels-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const artifacts=join(dir,"artifacts");mkdirSync(artifacts);
 const file=join(artifacts,"labels.json"), h="a".repeat(64);
 const valid={snapshotId:h,ruleHash:h,ruleId:"rule",subject:"src/a.ts",expected:"clean"};
 writeFileSync(file,JSON.stringify([valid]));assert.deepEqual(loadProactiveLabels(dir,file),[valid]);
 // Catalog IDs and subjects are opaque, even if they resemble paths.
 for (const ruleId of [".ai/rules/a.md#h@1:x", "rules/a.md#Paths a/../b@1:x", "../opaque#h@1:x"]) {
  const label={...valid,ruleId};writeFileSync(file,JSON.stringify([label]));assert.deepEqual(loadProactiveLabels(dir,file),[label]);
  assert.ok(proactiveEvidenceContent("captured",label as any,17).some(line=>line.startsWith(" {")));
 }
 const unicode={...valid,subject:"src/漢🐈.ts"};writeFileSync(file,JSON.stringify([unicode]));assert.deepEqual(loadProactiveLabels(dir,file),[unicode]);
 const lines=proactiveEvidenceContent("captured",unicode as any,17), start=lines.findIndex(line=>line.startsWith(" {")), end=lines.findIndex((line,i)=>i>start && line===" captured");
 assert.deepEqual(JSON.parse(lines.slice(start,end).map(line=>line.slice(1)).join("")),{...unicode,expected:"unknown"});
 assert.ok(lines.slice(start,end).every(line=>line.length<=17 && /^[\x00-\x7f]*$/.test(line)));
 for (const field of ["snapshotId","ruleHash","ruleId","subject"] as const) for (const bad of ["\u0000","\u001b","\u007f","\u009b"]) {
  const label={...valid,[field]:field==="snapshotId"||field==="ruleHash" ? bad+ h.slice(1) : `ok${bad}value`};
  writeFileSync(file,JSON.stringify([label]));assert.throws(()=>loadProactiveLabels(dir,file),/Invalid labels file/);
  const lines=proactiveEvidenceContent("captured",label as any,17);
  assert.ok(lines.some(line=>line.includes("unavailable")));
  assert.ok(!lines.some(line=>line.startsWith(" {")));
  assert.doesNotMatch(lines.join("\n"),/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
 }
 writeFileSync(file,'{SECRET_PAYLOAD');assert.throws(()=>loadProactiveLabels(dir,file),/Invalid labels file/);
 writeFileSync(file,JSON.stringify([{...valid,observed:"finding"}]));assert.throws(()=>loadProactiveLabels(dir,file),/Invalid labels file/);
 writeFileSync(file,"x".repeat(65537));assert.throws(()=>loadProactiveLabels(dir,file),/Unavailable labels file/);
 const outside=join(dir,"outside.json");writeFileSync(outside,JSON.stringify([valid]));
 symlinkSync(outside,join(artifacts,"link.json"));assert.throws(()=>loadProactiveLabels(dir,join(artifacts,"link.json")),/Unavailable labels file/);
 assert.throws(()=>loadProactiveLabels(dir,outside),/Unavailable labels file/);
});
