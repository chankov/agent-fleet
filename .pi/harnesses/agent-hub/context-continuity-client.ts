import {createConnection} from "node:net";
import type {ContextChannelAssignment} from "./context-continuity-broker.ts";
export const CONTEXT_CHANNEL_ENV="AF_D7_CONTEXT_CHANNEL";
export function parseContextChannel(value:string|undefined):ContextChannelAssignment|undefined {
 try{const a=JSON.parse(value??"");if(a && Object.keys(a).length===4 && typeof a.socket==="string" && a.socket.startsWith("/") && typeof a.owner==="string" && /^[a-f0-9]{64}$/.test(a.owner) && typeof a.attempt==="string" && /^[a-f0-9-]{36}$/.test(a.attempt) && typeof a.token==="string" && a.token.length===72)return a;}catch{}return undefined;
}
export function contextChannelCall(assignment:ContextChannelAssignment,operation:"context_status"|"context_assessment",payload:unknown,timeoutMs=1000,signal?:AbortSignal):Promise<any> {
 const body=JSON.stringify({owner:assignment.owner,attempt:assignment.attempt,token:assignment.token,operation,payload});
 if(Buffer.byteLength(body)>16384 || signal?.aborted)return Promise.resolve({status:"unavailable"});
 return new Promise(resolve=>{
  let done=false;let raw="";
  const req=createConnection(assignment.socket);
  const finish=(result:any)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener("abort",cancel);req.destroy();resolve(result);};
  const cancel=()=>finish({status:"unavailable"});const timer=setTimeout(cancel,timeoutMs);
  req.on("connect",()=>req.write(body+"\n"));
  req.on("data",chunk=>{raw+=chunk.toString();if(Buffer.byteLength(raw)>16384)return finish({status:"unavailable"});if(raw.includes("\n")){try{finish(JSON.parse(raw.trim()));}catch{finish({status:"unavailable"});}}});
  req.on("error",cancel);req.on("end",cancel);signal?.addEventListener("abort",cancel,{once:true});
 });
}
