import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const text=Type.String({minLength:1,maxLength:4000});
const strings=Type.Array(text,{maxItems:100});
const assertion=Type.Object({id:Type.String({pattern:"^A[0-9]+$"}),note:Type.Optional(text),evidence:Type.Optional(text),reason:Type.Optional(text)},{additionalProperties:false});
export const SpecialistResultSchema=Type.Object({
 status:Type.Union([Type.Literal("completed"),Type.Literal("partial"),Type.Literal("blocked")]),
 summary:text,
 changed_files:strings,
 assertions_proven:Type.Array(assertion,{maxItems:100}),
 assertions_unproven:Type.Array(assertion,{maxItems:100}),
 assertions_failed:Type.Array(assertion,{maxItems:100}),
 tests_run:strings,
 open_risks:strings,
 requires_user_decision:strings,
 evidence:Type.Array(Type.Object({path:text},{additionalProperties:false}),{maxItems:50}),
},{additionalProperties:false});

export interface SpecialistResult {
 status:"completed"|"partial"|"blocked"; summary:string;
 changed_files:string[]; assertions_proven:any[]; assertions_unproven:any[]; assertions_failed:any[];
 tests_run:string[]; open_risks:string[]; requires_user_decision:string[];
 evidence:{path:string;sha256:string;bytes:number}[];
}
export function validateSpecialistResult(input:unknown,cwd:string):SpecialistResult {
 if(!Value.Check(SpecialistResultSchema,input))throw new Error("Invalid submit_result fields: "+[...Value.Errors(SpecialistResultSchema,input)].slice(0,5).map(e=>e.path+": "+e.message).join("; "));
 if(Buffer.byteLength(JSON.stringify(input))>65536)throw new Error("submit_result exceeds 64 KiB; use evidence references");
 const root=realpathSync(cwd);
 let totalBytes=0;
 const evidence=input.evidence.map(ref=>{
  const path=realpathSync(resolve(root,ref.path));
  const rel=relative(root,path);
  if(rel===".."||rel.startsWith(".."+sep)||isAbsolute(rel))throw new Error("Evidence must stay inside the workspace");
  const stat=statSync(path);
  totalBytes+=stat.size;
  if(totalBytes>16*1024*1024)throw new Error("Evidence exceeds 16 MiB aggregate limit");
  if(!stat.isFile()||stat.size>8*1024*1024)throw new Error("Evidence must be a regular file at most 8 MiB");
  return {path:ref.path,sha256:createHash("sha256").update(readFileSync(path)).digest("hex"),bytes:stat.size};
 });
 const ids=new Set<string>();
 for(const entry of [...input.assertions_proven,...input.assertions_unproven,...input.assertions_failed]){
  if(ids.has(entry.id))throw new Error("Duplicate assertion id: "+entry.id);
  ids.add(entry.id);
 }
 for(const entry of input.assertions_proven){
  if(!entry.evidence||!evidence.some(ref=>ref.path===entry.evidence))throw new Error("Proven assertion must reference an evidence path in this submission: "+entry.id);
 }
 return {...input,evidence} as SpecialistResult;
}

export { resultFromToolEvent } from "./specialist-result-receipt.ts";

export default function specialistResultExtension(pi:any) {
 pi.registerTool({
  name:"submit_result",label:"Submit specialist result",
  description:"Hand off your structured result. Evidence paths must exist inside the workspace. A valid report is not proof that the entire task is accepted. Call after completing work; if blocked/partial, state that honestly.",
  parameters:SpecialistResultSchema,
  async execute(_id:string,input:unknown,_signal:any,_update:any,ctx:any){
   if(_signal?.aborted)throw new Error("Submission cancelled");
   const result=validateSpecialistResult(input,ctx.cwd);
   return {content:[{type:"text",text:"Specialist report received; whole-task acceptance remains with the runtime."}],details:{specialistResult:result}};
  },
 });
}
export const SPECIALIST_RESULT_INSTRUCTION = "Before your final answer, call submit_result with status, summary, changed_files, assertions_proven/unproven/failed, tests_run, open_risks, requires_user_decision and evidence. Use empty arrays where appropriate. Each proven assertion evidence must name a local file path from evidence; listed commands and file presence are not proof of passing. Correct validation errors directly. Report blocked/partial honestly. The parent decides whole-task acceptance. Keep a short final answer with any ASK_USER/NEEDS_RESEARCH markers and review verdict/findings.";
