import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextEvent } from "@mariozechner/pi-coding-agent";
import { CONTENT_REPLY_BYTES } from "./deterministic-fs.ts";
import { artifactPreviewFromText } from "./artifacts.js";

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};
const coordination=new Set(["dispatch_agent","spawn_research","coms_send","coms_get","coms_await","set_task_tier"]);
const inspection=new Set(["read","filesystem","bash","grep","find","ls"]);
const failure=/failed|refused|blocked|cancel|error|pending|stale|incomplete|uncertain/i;
const decisions=(value:unknown)=>Array.isArray(value)&&value.some(v=>String(v).trim()&&!/^(?:none|\[\])$/i.test(String(v).trim()));

function ensureHistoryDirectory(sessionDir:string):void {
 let directory=realpathSync(sessionDir);
 for(const name of ["artifacts","context-history"]){
  directory=join(directory,name);
  try{mkdirSync(directory,{mode:0o700});}catch(error){
   if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
  }
  const entry=lstatSync(directory);
  if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error("Historical artifact parent must be a plain directory");
 }
}

/** Transient model view only. Preserve every call/id, user decision, failure and
 * latest tool batch. Full historical results stay byte-exact in local artifacts
 * and in the original session journal. No summarizing model or network call.
 */
export function projectCoordinationHistory(messages:ContextEvent["messages"],sessionDir:string){
 if(!sessionDir)return {messages,projected:0,savedBytes:0};
 const latest=new Set<string>();
 for(let i=messages.length-1;i>=0;i--){
  const message=messages[i];
  if(message.role==="assistant"){
   for(const part of message.content)if(part.type==="toolCall")latest.add(part.id);
   if(latest.size)break;
  }
 }
 if(!latest.size)for(let i=messages.length-1;i>=0;i--){const last=messages[i];if(last.role==="toolResult"){latest.add(last.toolCallId);break;}}
 // Retain a recent inspection working set equal to one existing content page,
 // plus the entire latest batch. Older source remains available by exact reference.
 let remaining=CONTENT_REPLY_BYTES;
 const recentInspections=new Set<string>();
 for(let i=messages.length-1;i>=0;i--){
  const message=messages[i];if(message.role!=="toolResult"||!inspection.has(message.toolName))continue;
  const bytes=Buffer.byteLength(JSON.stringify(message.content));
  if(latest.has(message.toolCallId)||bytes<=remaining){recentInspections.add(message.toolCallId);remaining=Math.max(0,remaining-bytes);}
 }
 let projected=0,savedBytes=0;
 const next=messages.map(message=>{
  if(message.role!=="toolResult"||message.isError!==false||!(coordination.has(message.toolName)||inspection.has(message.toolName))||latest.has(message.toolCallId)||recentInspections.has(message.toolCallId)||message.content.some(p=>p.type!=="text"))return message;
  const details=object(message.details),runtime=object(details.runtimeResult),verification=object(runtime.verification),structured=object(details.structuredReturn),process=object(details.processVerdict);
  if(!inspection.has(message.toolName)&&details.exitCode!==0&&!/^(?:ok|complete|completed|accepted|completed_unverified|review_reused)$/.test(String(details.status??"")))return message;
  if(details.historicalReference||details.error||object(details.result).error||details.pending||details.exitCode!=null&&details.exitCode!==0||failure.test(String(details.status??""))||details.protocolDiagnostic||decisions(details.questions)||decisions(structured.requires_user_decision)||failure.test(String(verification.status??"")))return message;
  const text=message.content.map(p=>p.type==="text"?p.text:"").join("\n");
  if(/ASK_USER:|NEEDS_RESEARCH:/i.test(text)||coordination.has(message.toolName)&&text.includes("?")&&!Object.hasOwn(structured,"requires_user_decision"))return message;
  try{
   const original=JSON.stringify(message);
   const filename=createHash("sha256").update(original).digest("hex")+".json";
   const directory=join(sessionDir,"artifacts","context-history"),reference=join(directory,filename);
   const summary={schema:"agent-fleet.historical-result/v1",historicalReference:reference,status:details.status??"recorded",exitCode:details.exitCode,
    accepted:details.accepted,verification:verification.status,acceptance:runtime.acceptance,
    assertions_unproven:structured.assertions_unproven,assertions_failed:structured.assertions_failed,
    returnPath:details.returnPath,scopeViolations:details.scopeViolations,
    task:details.taskIdentity,process:details.processVerdict?{accepted:process.accepted,currentStage:process.currentStage,obligations:process.obligations}:undefined};
   const replacement:typeof message={...message,content:[{type:"text" as const,text:`Historical ${message.toolName} result: ${artifactPreviewFromText(text)}\n${JSON.stringify(summary)}\nFull original: ${reference}. This projection adds no verification or authorization; read original evidence when details are needed.`}],details:JSON.parse(JSON.stringify(summary))};
   const saved=Buffer.byteLength(original)-Buffer.byteLength(JSON.stringify(replacement));if(saved<=0)return message;
   ensureHistoryDirectory(sessionDir);
   try{writeFileSync(reference,original,{flag:"wx",mode:0o600});}catch(error){
    if((error as NodeJS.ErrnoException).code!=="EEXIST"||!lstatSync(reference).isFile()||lstatSync(reference).isSymbolicLink()||readFileSync(reference,"utf8")!==original)return message;
   }
   projected++;savedBytes+=saved;return replacement;
  }catch{return message;}
 });
 return {messages:projected?next:messages,projected,savedBytes};
}
