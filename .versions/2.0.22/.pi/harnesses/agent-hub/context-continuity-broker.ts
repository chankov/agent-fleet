import { COMPACTION_TARGET_PERCENT } from "../lib/context-compaction-policy.js";
import {createServer} from "node:net";
import {mkdtempSync,chmodSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {admittedContextOwner,validContextStatus,type ContextOwner} from "./context-continuity-owners.ts";
import {ContextCompactionRuntime} from "./context-compaction-runtime.ts";
import {getContextCompactionService} from "./system1-runtime.ts";
export interface ContextChannelAssignment {socket:string;owner:string;attempt:string;token:string}
export async function createContextContinuityBroker() {
 const dir=mkdtempSync(join(tmpdir(),"af-context-")),socket=join(dir,"broker.sock");
 const assessors=new Map<string,ContextCompactionRuntime>();let closed=false;
 const connections=new Set<import('node:net').Socket>();
 const server=createServer(connection=>{
  if(connections.size>=16){connection.destroy();return;}connections.add(connection);connection.once('close',()=>connections.delete(connection));
  const send=(_status:number,value:unknown)=>{connection.end(JSON.stringify(value)+"\n");};
  if(closed)return send(404,{status:"denied"});
  let raw="",handled=false;connection.setTimeout(1000,()=>connection.destroy());connection.on("error",()=>{});
  connection.on("data",async chunk=>{if(handled)return;raw+=chunk.toString();if(Buffer.byteLength(raw)>16384){handled=true;return send(413,{status:"denied"});}if(!raw.includes("\n"))return;handled=true;
  try{const body=JSON.parse(raw.trim());
   if(!body || Object.keys(body).some(k=>!["owner","attempt","token","operation","payload"].includes(k)))return send(400,{status:"denied"});
   const token=typeof body.token==="string"?body.token:"";
   const owner=admittedContextOwner(body.attempt,body.owner,token);if(!owner)return send(403,{status:"denied"});
   if(body.operation==="context_status") {
    if(!validContextStatus(body.payload) || body.payload.episode<owner.status.episode)return send(400,{status:"denied"});
    owner.status={...body.payload};
    const pressure=owner.status.tokens!==null && owner.status.window!==null && owner.status.window>0 && owner.status.tokens/owner.status.window>=COMPACTION_TARGET_PERCENT/100;
    return send(200,{status:"ok",directive:pressure && owner.status.phase==="pending"?{type:"compact",owner:owner.owner,attempt:owner.attempt,episode:owner.status.episode}:null});
   }
   if(body.operation!=="context_assessment")return send(400,{status:"denied"});
   const p=body.payload;
   if(!p || Object.keys(p).some(k=>!["identity","task","revision","turn","tokens","window","historyTokens","keepRecentTokens","responseTokens","unsafe"].includes(k)) || typeof p.task!=="string" || typeof p.identity!=="string" || p.identity.length>256 || p.task.length>8192 || typeof p.unsafe!=="boolean" || !["revision","turn","historyTokens","keepRecentTokens","responseTokens"].every(k=>Number.isSafeInteger(p[k]) && p[k]>=0) || !["tokens","window"].every(k=>p[k]===null || typeof p[k]==="number" && Number.isFinite(p[k]) && p[k]>=0))return send(400,{status:"denied"});
   let assessor=assessors.get(owner.attempt);if(!assessor){assessor=new ContextCompactionRuntime();assessors.set(owner.attempt,assessor);}
   const consumer=getContextCompactionService();const result=await assessor.assess({...p,identity:`${owner.owner}:${owner.attempt}:${p.identity}`},consumer?.service,consumer?.config);
   if(!admittedContextOwner(body.attempt,body.owner,token))return send(403,{status:"denied"});
   send(200,{status:"ok",assessment:result,owner:owner.owner,attempt:owner.attempt});
  }catch{send(400,{status:"denied"});}
  });
 });
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,()=>{chmodSync(socket,0o600);resolve();});});server.unref();
 return {assignment:(owner:ContextOwner):ContextChannelAssignment=>({socket,owner:owner.owner,attempt:owner.attempt,token:owner.token}),async close(){closed=true;for(const connection of connections)connection.destroy();for(const assessor of assessors.values())assessor.fence();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}};
}
