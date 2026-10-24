import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {spawnPiAgent} from "./spawn.ts";
import {chmodSync} from "node:fs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
import {resolvePiTestRuntime} from '../../../bin/test/helpers/pi-runtime.js';
const runtimeInfo=resolvePiTestRuntime({root});
const runtime=runtimeInfo.root;
// Pi 1.1 resumes the existing agent run; the later verified contract emits
// before_agent_start for the continuation as well. Effects/restore/replay
// assertions below remain identical for both lifecycle variants.
const expectedAgentStarts=(userRuns:number)=>userRuns+(runtimeInfo.version==='1.1.0'?0:1);

// Real CLI, real compaction implementation, fake inference only. No custom summary
// hook: the fake provider must also service Pi's actual summary request.
const fixture = String.raw`
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const record = (x: any) => appendFileSync(process.env.D7_EVENTS!, JSON.stringify(x) + "\n");
let calls = 0, episodes = 0, taskStep = 0;
let pressureAbort = false;
let recoveryContext: any;
let summarizing=false;
const hub = process.env.D7_HUB === "1";
const explicit = process.env.D7_EXPLICIT === "1";
const native = process.env.D7_NATIVE === "1";
const readOnly = process.env.D7_READ_ONLY === "1";
const taskReset = process.env.D7_TASK_RESET === "1";
const semantic = process.env.D7_SEMANTIC === "1";
export default function(pi: any) {
  pi.on("session_compact", (e: any) => { summarizing=false; record({event:"restored", result:e.compactionEntry}); });
  pi.on("before_agent_start", () => record({event:"before_agent_start"}));
  pi.on("message_end", (e:any)=>{if(e.message.role==="assistant")record({event:"assistant_end",stop:e.message.stopReason});});
  pi.on("session_before_compact", (_event: any, ctx: any) => {
    summarizing=true;
    if (process.env.D7_CANCEL === "2") { record({event:"cancelled_during_compact"}); ctx.abort(); return {cancel:true}; }
  });
  pi.on("tool_result", (e: any) => record({event:"tool_result", name:e.toolName, error:e.isError,...(taskReset?{status:e.details?.status,reason:e.details?.reason}: {})}));
  pi.on("turn_end", (_event: any, ctx: any) => {
    if (!hub && !native && calls === 2 && !pressureAbort) { pressureAbort = true; record({event:"pressure_abort"}); ctx.abort(); }
  });
  pi.on("agent_settled", async (event: any, ctx: any) => {
    record({event:"settled", aborted:event.aborted});
    if (hub || native || episodes++ || (event.aborted && !pressureAbort)) return;
    if (process.env.D7_CANCEL === "1") { record({event:"cancelled"}); return; }
    recoveryContext = ctx;
    record({event:"compact_start"});
    const ok = await new Promise<boolean>(resolve => ctx.compact({
      customInstructions: "Preserve the write-once result and next allowed step.",
      onComplete: () => {record({event:"compact_complete"}); resolve(true);},
      onError: (e: any) => {record({event:"compact_error", error:String(e)}); resolve(false);}
    }));
    if (!ok) return;
    record({event:"continuation"});
    pi.sendMessage({customType:"d7-continuation",content:"Continue the same permitted task; do not repeat the write.",display:false}, {triggerTurn:true});
  });
  pi.registerProvider("d7-fixture", {
    name:"d7-fixture", baseUrl:"http://127.0.0.1", apiKey:"fixture", api:"d7-api",
    models:[{id:"m",name:"m",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:semantic?272000:64000,maxTokens:semantic?128000:2000}],
    streamSimple(model: any, ctx: any, options: any) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const inbound = JSON.stringify(ctx.messages);
        const summary = summarizing;
        if(taskReset && !summary)taskStep++;
        record({event:"provider", call:++calls, summary, hasResult:inbound.includes("write-once"), compactionToolAvailable:pi.getActiveTools().includes("request_compaction"), continuation:inbound.includes("Continue the same permitted task") || inbound.includes("Continue the same authorized task") || inbound.includes("Continue the same authorized physical attempt")});
        const msg: any = {role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,usage:{input:semantic?166000:hub || native ? (explicit?1000:Number(process.env.D7_PRESSURE_TOKENS??45000)):20000,output:20,cacheRead:0,cacheWrite:0,totalTokens:semantic?166020:hub || native ? (explicit?1020:Number(process.env.D7_PRESSURE_TOKENS??45000)+20):20020,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()};
        stream.push({type:"start",partial:msg});
        if (summary && process.env.D7_CANCEL === "3") {
          record({event:"cancelled_inflight"});
          recoveryContext.abort();
          msg.stopReason="aborted"; msg.errorMessage="operator cancellation fixture";
          stream.push({type:"aborted",reason:"aborted",error:msg}); stream.end(); return;
        }
        if(semantic && !summary && calls<=2){
          const tc={type:"toolCall",id:"semantic-read-"+calls,name:"read",arguments:{path:calls===1?"large-a.md":"large-b.md",offset:1,limit:1000}};
          msg.content.push(tc);msg.stopReason="toolUse";stream.push({type:"toolcall_start",contentIndex:0,partial:msg});stream.push({type:"toolcall_end",contentIndex:0,toolCall:tc,partial:msg});
        } else if (taskReset && !summary && [1,3,4,5,6].includes(taskStep)) {
          const tc = taskStep === 3 ? {type:"toolCall",id:"reset-task",name:"set_task_tier",arguments:{tier:"small",risk:"low",scope:"read-only",new_task:true,reason:"User switched from preliminary read to explicit compaction smoke test"}}
            : taskStep === 5 ? {type:"toolCall",id:"reset-compact",name:"request_compaction",arguments:{reason:"Current user requested compact",continuationPrompt:"Read package.json then return D7_TASK_RESET_FINISHED. Do not repeat reads."}}
            : {type:"toolCall",id:"reset-read-"+taskStep,name:"read",arguments:{path:taskStep===6?"package.json":"README.md"}};
          msg.content.push(tc);msg.stopReason="toolUse";
          stream.push({type:"toolcall_start",contentIndex:0,partial:msg});stream.push({type:"toolcall_end",contentIndex:0,toolCall:tc,partial:msg});
        } else if (calls === 1 || (explicit && calls === 2 && !summary && !taskReset)) {
          const tc = calls === 1 ? (readOnly ? {type:"toolCall",id:"read-once",name:"read",arguments:{path:"large.txt"}} : {type:"toolCall",id:"write-once",name:"bash",arguments:{command:"printf 'write-once\\n' >> effect.txt; printf '%05000d\\n' 0"}}) : {type:"toolCall",id:"explicit-compact",name:"request_compaction",arguments:{reason:"Operator requested compact",continuationPrompt:"Return D7_FINAL without repeating the effect."}};
          msg.content.push(tc); msg.stopReason="toolUse";
          stream.push({type:"toolcall_start",contentIndex:0,partial:msg});
          stream.push({type:"toolcall_end",contentIndex:0,toolCall:tc,partial:msg});
        } else {
          const text = taskReset && !summary ? (taskStep===2?"D7_TASK_A_FINISHED":"D7_TASK_RESET_FINISHED") : summary ? "## Goal\nComplete fixture task.\n## Progress\nwrite-once tool result persisted; do not repeat it.\n## Next Steps\nReturn D7_FINAL." : calls === 2 ? "D7_BOUNDARY " + "history ".repeat(4000) : "D7_FINAL";
          msg.content.push({type:"text",text});
          stream.push({type:"text_start",contentIndex:0,partial:msg});
          stream.push({type:"text_delta",contentIndex:0,delta:text,partial:msg});
          stream.push({type:"text_end",contentIndex:0,content:text,partial:msg});
        }
        stream.push({type:"done",reason:msg.stopReason,message:msg}); stream.end();
      }); return stream;
    }
  });
}
`;

async function run(cancel: boolean | "during" | "inflight", hub=false, explicit=false, native=false, readOnly=false, localOnly=false, smallSession=false, semantic=false, pressureTokens=45000) {
  assert.ok(existsSync(join(runtime, "dist/cli.js")), `Pi runtime missing: ${runtime}`);
  assert.equal(JSON.parse(readFileSync(join(runtime, "package.json"), "utf8")).version, runtimeInfo.version, 'SDK metadata must stay unchanged during the fixture');
  const dir = mkdtempSync(join(tmpdir(), "d7-contract-"));
  try {
    mkdirSync(join(dir, "agent"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(join(dir, "probe.ts"), fixture);
    if(semantic){
      mkdirSync(join(dir,".ai"));writeFileSync(join(dir,".ai/agent-fleet.json"),JSON.stringify({features:{system1:true}}));
      writeFileSync(join(dir,".ai/system1.json"),JSON.stringify({version:2,mode:"auto",provider:"typesafe",model:"jev-1.13.0",apiKeyEnv:"TYPESAFE_API_KEY",consumers:{contextCompaction:{mode:"automatic",remoteContextApproved:true,earlyOpportunityPercent:60,limits:{timeoutMs:1000,maxStateBytes:8192}}}}));
    }
    if(semantic){writeFileSync(join(dir,"large-a.md"),"Architecture and allowed runtime recovery.\n".repeat(1200));writeFileSync(join(dir,"large-b.md"),"Evidence, permissions and context continuity.\n".repeat(1100));}
    writeFileSync(join(dir, "agent/settings.json"), JSON.stringify({compaction:{enabled:false,...(smallSession || semantic?{}:{keepRecentTokens:100,reserveTokens:2000})}}));
    // Exercise the npm-bin symlink to the same bundled entry used by `pi`,
    // not only the direct unbundled CLI path that hid the compatibility bug.
    const bundled=join(runtime,"dist/bundle/cli.js");assert.ok(existsSync(bundled));
    const launcher=join(dir,"pi");symlinkSync(bundled,launcher);
    const result = spawnSync(launcher, [ "--mode","json","-p","--no-extensions",...(hub ? ["-e",join(root,".pi/harnesses/agent-hub/index.ts"),"--solo","--work-mode","operator"] : []),...(explicit ? ["-e",join(root,".pi/extensions/compact-and-continue/index.ts")] : []),...(localOnly ? ["-e",join(root,".pi/harnesses/agent-hub/context-continuity-child.ts")] : []),"--session-dir",join(dir,"sessions"),"-e",join(dir,"probe.ts"),"--model","d7-fixture/m",explicit ? "Complete write-once fixture, then use request_compaction and continue." : "Complete write-once fixture."], {
      cwd:dir, timeout:20000, encoding:"utf8", maxBuffer:4*1024*1024,
      env:{PATH:process.env.PATH!, HOME:dir, PI_CODING_AGENT_DIR:join(dir,"agent"), PI_OFFLINE:"1", AGENT_SKILLS_NO_UPDATE_CHECK:"1", D7_EVENTS:join(dir,"events.jsonl"), D7_PRESSURE_TOKENS:String(pressureTokens), D7_HUB:hub?"1":"0",D7_SEMANTIC:semantic?"1":"0",...(semantic?{TYPESAFE_API_KEY:"synthetic-offline-only",AGENT_HUB_TASK_TRIAGE_FAKE:"context-safe",AGENT_HUB_CONTEXT_FAKE_DELAY_MS:"100",AGENT_HUB_TASK_TRIAGE_FAKE_RECORD:join(dir,"fake-calls.jsonl")} : {}), D7_NATIVE:localOnly?"1":"0", D7_EXPLICIT:explicit?"1":"0", D7_CANCEL:cancel === "inflight" ? "3" : cancel === "during" ? "2" : cancel?"1":"0", NODE_OPTIONS:`--import=${join(root,"bin/test/helpers/system1-no-network.js")}`},
    });
    let effectiveResult=result;
    if(native) {
     mkdirSync(join(dir,"bin"));writeFileSync(join(dir,"bin/pi"),`#!/bin/sh\nexec ${JSON.stringify(launcher)} -e ${JSON.stringify(join(dir,"probe.ts"))} "$@"\n`);chmodSync(join(dir,"bin/pi"),0o700);
     // Reset first probe effects; native physical spawn owns the actual acceptance run.
     rmSync(join(dir,"events.jsonl"),{force:true});rmSync(join(dir,"effect.txt"),{force:true});
     if(readOnly)writeFileSync(join(dir,"large.txt"),"write-once ".repeat(500));
     const nativeResult=await spawnPiAgent({model:"d7-fixture/m",tools:readOnly?"read":"bash",thinking:"off",sessionFile:join(dir,"native.jsonl"),prompt:"Complete write-once fixture.",cwd:dir,turnDeadlineMs:20000,env:{PATH:`${join(dir,"bin")}:${process.env.PATH}`,HOME:dir,PI_CODING_AGENT_DIR:join(dir,"agent"),PI_OFFLINE:"1",D7_EVENTS:join(dir,"events.jsonl"),D7_PRESSURE_TOKENS:String(pressureTokens),D7_NATIVE:"1",D7_READ_ONLY:readOnly?"1":"0",D7_CANCEL:"0",NODE_OPTIONS:`--import=${join(root,"bin/test/helpers/system1-no-network.js")}`}});
     effectiveResult={...result,stdout:nativeResult.output,stderr:nativeResult.stderr,status:nativeResult.exitCode,error:nativeResult.assistantError?new Error(nativeResult.assistantError):undefined};
    }
    const events = existsSync(join(dir,"events.jsonl")) ? readFileSync(join(dir,"events.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)) : [];
    const effect = existsSync(join(dir,"effect.txt")) ? readFileSync(join(dir,"effect.txt"),"utf8") : "";
    const runtimeEntries=existsSync(join(dir,"sessions")) ? (await import("node:fs")).readdirSync(join(dir,"sessions")).filter(name=>name.endsWith(".jsonl")).flatMap(name=>readFileSync(join(dir,"sessions",name),"utf8").trim().split("\n").map(line=>JSON.parse(line))) : [];
    const fakeCalls=existsSync(join(dir,"fake-calls.jsonl"))?readFileSync(join(dir,"fake-calls.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
    return {result:effectiveResult, events, effect, runtimeEntries, fakeCalls};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

test("Project Pi real -p CLI compacts, restores and continues exactly once", async () => {
  const {result,events,effect} = await run(false);
  assert.equal(result.error, undefined, JSON.stringify({events,stderr:result.stderr,error:String(result.error)}));
  assert.equal(result.status,0,result.stderr);
  assert.equal(effect,"write-once\n");
  assert.equal(events.filter(e=>e.event==="tool_result" && !e.error).length,1);
  assert.equal(events.filter(e=>e.event==="compact_complete").length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="restored").length,1);
  assert.equal(events.filter(e=>e.event==="provider" && e.summary).length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="continuation").length,1);
  assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1);
  assert.equal(events.filter(e=>e.event==="provider" && e.continuation && e.hasResult).length,1);
  assert.match(result.stdout,/D7_FINAL/);
});

test("operator cancellation during real summary inference never continues", async () => {
  const {result,events,effect} = await run("inflight");
  assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
  assert.equal(effect,"write-once\n");
  assert.equal(events.filter(e=>e.event==="cancelled_inflight").length,1);
  assert.equal(events.filter(e=>e.event==="compact_complete").length,0,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="continuation").length,0);
});

test("cancellation at real compaction boundary never continues", async () => {
  const {result,events,effect} = await run("during");
  assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
  assert.equal(effect,"write-once\n");
  assert.equal(events.filter(e=>e.event==="cancelled_during_compact").length,1);
  assert.equal(events.filter(e=>e.event==="compact_complete").length,0);
  assert.equal(events.filter(e=>e.event==="continuation").length,0);
});

test("cancelled eligibility never sends a continuation", async () => {
  const {result,events,effect} = await run(true);
  assert.equal(result.error,undefined,result.stderr);
  assert.equal(result.status,0,result.stderr);
  assert.equal(effect,"write-once\n");
  assert.equal(events.filter(e=>e.event==="continuation").length,0);
  assert.equal(events.filter(e=>e.event==="cancelled").length,1);
});

test("production Hub resumes pressure-interrupted work without a new user turn", async t => {
  const {result,events,effect,runtimeEntries}=await run(false,true);
  assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
  assert.equal(result.status,0,result.stderr);
  assert.equal(effect,"write-once\n");
  assert.equal(events.filter(e=>e.event==="restored").length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="before_agent_start").length,expectedAgentStarts(1));
  const monitor=runtimeEntries.filter(e=>e.customType==="agent-hub-compaction-monitor").map(e=>e.data);
  assert.deepEqual(monitor.slice(0,3).map(e=>e.phase),["started","restored","continuation_requested"]);
  assert.ok(monitor[0].beforePercent>=70 && monitor[0].beforePercent<=80,JSON.stringify(monitor));
  assert.equal(monitor[0].targetPercent,70);
  assert.ok(monitor.some(e=>e.phase==="continued" && e.measurement==="first_post_compaction"),JSON.stringify(monitor));
  t.diagnostic(JSON.stringify({scenario:"deterministic-target",beforePercent:monitor[0].beforePercent,phases:monitor.slice(0,3).map(e=>e.phase),effects:1}));
  assert.match(result.stdout,/D7_FINAL/);
});

test("low-pressure explicit request_compaction remains available through reads via real Pi symlink launcher", async () => {
  const {result,events,effect}=await run(false,true,true);
  assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
  assert.equal(result.status,0,result.stderr);
  assert.equal(effect,"write-once\n");
  assert.equal(events.find(e=>e.event==="provider" && e.call===2)?.compactionToolAvailable,true,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="tool_result" && e.name==="request_compaction" && !e.error).length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="restored").length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1,JSON.stringify(events));
  assert.equal(events.filter(e=>e.event==="before_agent_start").length,expectedAgentStarts(1));
  assert.match(result.stdout,/D7_FINAL/);
});

test("native physical spawn adapter compacts and continues write-once in the same attempt", async()=>{
 const {result,events,effect}=await run(false,false,false,true);
 assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
 assert.equal(result.status,0,result.stderr);assert.equal(effect,"write-once\n");
 assert.equal(events.filter(e=>e.event==="restored").length,1,JSON.stringify(events));
 assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1,JSON.stringify(events));
 assert.equal(events.filter(e=>e.event==="before_agent_start").length,expectedAgentStarts(1));
 assert.match(result.stdout,/D7_FINAL/);
});

test("read-only research/nested physical surface uses shared adapter and own model window", async()=>{
 const {result,events,effect}=await run(false,false,false,true,true);
 assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
 assert.equal(result.status,0,result.stderr);assert.equal(effect,"");
 assert.equal(events.filter(e=>e.event==="tool_result" && e.name==="read").length,1);
 assert.equal(events.filter(e=>e.event==="restored").length,1);
 assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1);
 assert.match(result.stdout,/D7_FINAL/);
});

test("local deterministic child recovery works with no parent context channel or System1", async()=>{
 const {result,events,effect}=await run(false,false,false,false,false,true);
 assert.equal(result.error,undefined,JSON.stringify({events,error:String(result.error),stderr:result.stderr}));
 assert.equal(result.status,0,result.stderr);assert.equal(effect,"write-once\n");
 assert.equal(events.filter(e=>e.event==="restored").length,1);
 assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1);
 assert.match(result.stdout,/D7_FINAL/);
});

test("two tasks in one Pi session: authorized new_task keeps current explicit compaction and resumes once", async t=>{
 const dir=mkdtempSync(join(tmpdir(),"d7-task-reset-"));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,"agent"));writeFileSync(join(dir,"package.json"),'{"type":"module"}');writeFileSync(join(dir,"README.md"),"Read-only test fixture.\n");writeFileSync(join(dir,"probe.ts"),fixture);
 writeFileSync(join(dir,"agent/settings.json"),JSON.stringify({compaction:{enabled:false,keepRecentTokens:100,reserveTokens:2000}}));
 const launcher=join(dir,"pi");symlinkSync(join(runtime,"dist/bundle/cli.js"),launcher);
 const child=spawn(launcher,["--mode","rpc","--no-extensions","-e",join(root,".pi/harnesses/agent-hub/index.ts"),"-e",join(root,".pi/extensions/compact-and-continue/index.ts"),"-e",join(dir,"probe.ts"),"--solo","--work-mode","operator","--session-dir",join(dir,"sessions"),"--model","d7-fixture/m"],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:join(dir,"agent"),PI_OFFLINE:"1",D7_EVENTS:join(dir,"events.jsonl"),D7_HUB:"1",D7_EXPLICIT:"1",D7_TASK_RESET:"1",NODE_OPTIONS:`--import=${join(root,"bin/test/helpers/system1-no-network.js")}`},stdio:["pipe","pipe","pipe"]});
 let buffer="",stderr="";const messages:any[]=[];let closed=false;
 child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{buffer+=chunk;const lines=buffer.split("\n");buffer=lines.pop()!;for(const line of lines){try{const message=JSON.parse(line);messages.push(message);if(message.type==="extension_ui_request" && message.method==="select" && message.title?.startsWith("Authorize one-time abandonment") && message.options?.includes("Yes — supersede once"))child.stdin.write(JSON.stringify({type:"extension_ui_response",id:message.id,value:"Yes — supersede once"})+"\n");}catch{}}});
 child.stderr.setEncoding("utf8");child.stderr.on("data",chunk=>{stderr+=chunk;});child.on("error",error=>{stderr+=String(error);closed=true;});child.on("close",()=>{closed=true;});
 const events=()=>existsSync(join(dir,"events.jsonl"))?readFileSync(join(dir,"events.jsonl"),"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)):[];
 const wait=async(predicate:()=>boolean)=>{const end=Date.now()+20000;while(!predicate()){assert.ok(!closed,stderr);assert.ok(Date.now()<end,JSON.stringify({messages:messages.slice(-8),events:events(),stderr}));await new Promise(resolve=>setTimeout(resolve,20));}};
 try {
  child.stdin.write(JSON.stringify({type:"prompt",id:"task-a",message:"Read README.md only, then return D7_TASK_A_FINISHED."})+"\n");
  await wait(()=>messages.some(m=>m.type==="response" && m.id==="task-a") && events().filter(e=>e.event==="settled").length>=1);
  assert.equal(messages.find(m=>m.type==="response" && m.id==="task-a").success,true);
  child.stdin.write(JSON.stringify({type:"prompt",id:"task-b",message:"This is a different specialist lifecycle test (do not dispatch). Classify it with set_task_tier new_task:true, tier small, risk low, scope read-only. Read README.md once, use request_compaction, continue by reading package.json once, and finish with D7_TASK_RESET_FINISHED. No writes or shell commands."})+"\n");
  await wait(()=>messages.some(m=>m.type==="response" && m.id==="task-b") && events().filter(e=>e.event==="settled").length>=3);
  assert.equal(messages.find(m=>m.type==="response" && m.id==="task-b").success,true);
  const records=events();
  assert.equal(records.find(e=>e.event==="provider" && e.call===4)?.compactionToolAvailable,true,JSON.stringify(records));
  assert.equal(records.filter(e=>e.event==="tool_result" && e.name==="set_task_tier" && !e.error).length,1,JSON.stringify({records,messages:messages.filter(m=>m.type==="tool_execution_end")}));
  assert.equal(records.filter(e=>e.event==="tool_result" && e.name==="request_compaction" && !e.error).length,1);
  assert.equal(records.filter(e=>e.event==="restored").length,1);
  assert.equal(records.filter(e=>e.event==="provider" && e.continuation).length,2); // read and final output within one continuation
  assert.equal(records.filter(e=>e.event==="before_agent_start").length,expectedAgentStarts(2),"two accepted user runs plus the runtime-specific continuation event");
  assert.equal(records.filter(e=>e.event==="tool_result" && e.name==="read" && !e.error).length,3,JSON.stringify({records,results:messages.filter(m=>m.type==="tool_execution_end")}));
  assert.ok(JSON.stringify(messages).includes("D7_TASK_RESET_FINISHED"));
 } finally {child.kill("SIGTERM");if(!closed)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill("SIGKILL");resolve();},1000);child.once("close",()=>{clearTimeout(timer);resolve();});});}
});

test("default Pi retention: small explicit request is honestly skipped and continues without compaction",async()=>{
 const {result,events,effect,runtimeEntries}=await run(false,true,true,false,false,false,true);
 assert.equal(result.error,undefined,result.stderr);assert.equal(result.status,0,result.stderr);assert.equal(effect,"write-once\n");
 assert.equal(events.filter(e=>e.event==="restored").length,0);
 assert.equal(events.filter(e=>e.event==="provider" && e.summary).length,0);
 assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,1);
 assert.equal(events.filter(e=>e.event==="before_agent_start").length,expectedAgentStarts(1));
 assert.ok(runtimeEntries.some(e=>e.customType==="agent-hub-context-continuity" && e.data.phase==="skipped"));
 assert.ok(!runtimeEntries.some(e=>e.type==="compaction" || e.customType==="agent-hub-context-pressure" && e.data.phase==="failed"));
 assert.match(result.stdout,/D7_FINAL/);
});

test("delayed System1 hook compacts within 60–70% with default Pi reserve",async t=>{
 const {result,events,runtimeEntries,fakeCalls}=await run(false,true,false,false,false,false,false,true);
 assert.equal(result.error,undefined,result.stderr);assert.equal(result.status,0,result.stderr);
 assert.ok(fakeCalls.some(e=>e.questions.includes("boundary") && e.questions.includes("retention")),JSON.stringify({events,diagnostics:runtimeEntries.filter(e=>e.customType==="agent-hub-context-assessment")}));
 assert.equal(events.filter(e=>e.event==="tool_result" && e.name==="request_compaction").length,0);
 assert.equal(events.filter(e=>e.event==="restored").length,1,JSON.stringify(events));
 const accepted=runtimeEntries.find(e=>e.customType==="agent-hub-context-assessment" && e.data.status==="accepted");
 assert.ok(accepted,JSON.stringify(runtimeEntries.filter(e=>e.customType==="agent-hub-context-assessment")));
 assert.equal(accepted.data.responseReservedTokens,16384);assert.ok(accepted.data.percent>=60 && accepted.data.percent<=70);assert.equal(accepted.data.inferenceRequested,true);
 const workRequests=events.filter(e=>e.event==="provider" && !e.summary);
 assert.equal(workRequests.at(-1)?.continuation,true,"early assessment must finish before the next work request, then continue after real compaction");
 t.diagnostic(JSON.stringify({scenario:"delayed-semantic",percent:accepted.data.percent,boundaryConfidence:accepted.data.boundaryConfidence,compactions:events.filter(e=>e.event==="restored").length}));
 assert.ok(runtimeEntries.some(e=>e.customType==="agent-hub-context-continuity" && e.data.phase==="compacting"));
 assert.match(result.stdout,/D7_FINAL/);
});


test("automatic Hub does not compact below 50%, while a tool-result overshoot above 80% recovers before another work request",async()=>{
 const low=await run(false,true,false,false,false,false,false,false,25000);
 assert.equal(low.result.status,0,low.result.stderr);
 assert.equal(low.events.filter(e=>e.event==="restored").length,0);
 const high=await run(false,true,false,false,false,false,false,false,52000);
 assert.equal(high.result.status,0,high.result.stderr);assert.equal(high.effect,"write-once\n");
 assert.equal(high.events.filter(e=>e.event==="restored").length,1);
 assert.equal(high.events.filter(e=>e.event==="provider" && e.continuation).length,1);
 const start=high.runtimeEntries.find(e=>e.customType==="agent-hub-compaction-monitor" && e.data.phase==="started");
 assert.equal(start?.data.ceilingExceeded,true);
 const work=high.events.filter(e=>e.event==="provider" && !e.summary);
 assert.equal(work.length,2);assert.equal(work[1].continuation,true,"no ordinary work request before recovery");
});

for(const owner of ["hub","child"])test(`real ${owner} cancellation at compaction boundary never auto-continues`,async()=>{
 const {result,events,effect}=await run("during",owner==="hub",false,false,false,owner==="child");
 assert.equal(result.error,undefined,result.stderr);assert.equal(result.status,0,result.stderr);
 assert.equal(effect,"write-once\n");
 assert.equal(events.filter(e=>e.event==="restored").length,0);
 assert.equal(events.filter(e=>e.event==="provider" && e.continuation).length,0);
 assert.equal(events.filter(e=>e.event==="cancelled_during_compact").length,1);
});
