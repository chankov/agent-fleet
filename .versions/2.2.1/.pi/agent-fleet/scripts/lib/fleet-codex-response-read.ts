import {ReadonlyFleetBridge,ReadonlyFleetError} from './fleet-codex-readonly.ts';
import type {ConversationKey} from './fleet-codex-allowlist.ts';
import type {ResponseTransport} from './fleet-codex-response-transport.ts';
import {sameOwner} from '../../../harnesses/lib/coms-instruction-receipts.ts';
import {ResponseReadError,responseHash,validReference,decodeResponseCursor,validateResponsePage} from '../../../harnesses/lib/coms-response-read.ts';
export function responseScope(c:ConversationKey){return responseHash(JSON.stringify([c.hostProfile,c.principal,c.threadId]));}
export function parseResponseRead(a:unknown):asserts a is {project:string;peer:string;reference:string;cursor?:string}{
 if(!a||typeof a!=='object'||Array.isArray(a))throw new ResponseReadError('INVALID_ARGUMENTS');const v=a as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['project','peer','reference','cursor'].includes(k))||!['project','peer','reference'].every(k=>Object.hasOwn(v,k))||![v.project,v.peer].every(x=>typeof x==='string'&&x.length>0&&x.length<=1024&&x.trim()===x&&!/[\u0000-\u001f\u007f*]/u.test(x))||!validReference(v.reference))throw new ResponseReadError('INVALID_ARGUMENTS');
 if(v.cursor!==undefined)decodeResponseCursor(v.cursor);
}
export class ResponseReadBridge{
 readonly authorization:ReadonlyFleetBridge;readonly transport:ResponseTransport;
 constructor(authorization:ReadonlyFleetBridge,transport:ResponseTransport){this.authorization=authorization;this.transport=transport;}
 async read(c:ConversationKey,a:unknown,signal?:AbortSignal){
  parseResponseRead(a);if(signal?.aborted)throw new ResponseReadError('REQUEST_CANCELLED');const scope=responseScope(c);
  const before=await this.authorization.checkAllowedReadTarget(c,{project:a.project,peer:a.peer});
  if(a.cursor){const old=decodeResponseCursor(a.cursor);if(old.scope!==scope||old.reference!==a.reference||!sameOwner(old.target,before.target))throw new ResponseReadError('INVALID_CURSOR');}
  const check=async()=>{if(signal?.aborted)throw new ResponseReadError('REQUEST_CANCELLED');const fresh=await this.authorization.checkAllowedReadTarget(c,{project:a.project,peer:a.peer});if(!sameOwner(fresh.target,before.target))throw new ReadonlyFleetError('TARGET_CHANGED');};
  let raw:unknown,error:unknown;try{raw=await this.transport.read(before.target,{reference:a.reference,scope,...(a.cursor===undefined?{}:{cursor:a.cursor})},check,signal);}catch(e){error=e;}
  // Revalidate even if the receiver errored; revoke/epoch changes win over old evidence.
  await check();if(error)throw error;
  const page=validateResponsePage(raw,before.target,a.reference,scope,a.cursor);
  return {...page,permission:'read' as const,scope:'public_final_response' as const,taskCompletion:'not_established' as const};
 }
}
