import {constants,lstatSync,openSync,fstatSync,readSync,closeSync,type Stats} from 'node:fs';
import {dirname} from 'node:path';
import {readPrivateJson,writePrivateJson,privateFileIdentity} from './codex-bootstrap-files.ts';
import type {ConversationKey,TargetEpoch,Right} from './fleet-codex-allowlist.ts';
import {targetKey} from '../../../harnesses/lib/fleet-target-identity.ts';

export type SendState={storeId:string;namespace:ConversationKey;revision:number;bindings:{alias:string;target:TargetEpoch;rights:Right[];status:string;expiresAt?:number}[]};
type Step={from:number;to:number;alias:string;send:boolean;before:string;after:string};
type Lineage={schema:'fleet-send-lineage/v1';storeId:string;namespace:ConversationKey;steps:Step[]};
const limit=64,maxBytes=32768,same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const keys=(v:any,names:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...names].sort());
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function decode(value:unknown,state:SendState):Lineage{
 const v=value as Lineage;
 if(!keys(v,['schema','storeId','namespace','steps'])||v.schema!=='fleet-send-lineage/v1'||v.storeId!==state.storeId||!same(v.namespace,state.namespace)||!Array.isArray(v.steps)||v.steps.length>limit)throw Error('send_lineage_invalid');
 let previous=-1;
 for(const s of v.steps){if(!keys(s,['from','to','alias','send','before','after'])||!Number.isSafeInteger(s.from)||s.from<0||s.from>=Number.MAX_SAFE_INTEGER||s.to!==s.from+1||s.from<=previous||typeof s.alias!=='string'||s.alias.length<1||s.alias.length>1024||typeof s.send!=='boolean'||!digest(s.before)||!digest(s.after))throw Error('send_lineage_invalid');previous=s.from;}
 return v;
}
function changed<T extends SendState>(before:T,alias:string,send:boolean):T{
 const next=structuredClone(before),b=next.bindings.find(b=>b.alias===alias);
 if(!b||b.status!=='active'||b.rights[0]!=='read'||next.revision>=Number.MAX_SAFE_INTEGER)throw Error('send_lineage_invalid');
 b.rights=['read',...(send?['send' as const]:[]),...(b.rights.includes('approve')?['approve' as const]:[])];next.revision++;return next;
}
/** Prepare the exact send-only proof before policy rename, under its existing
 * lock. A future/failed write proves nothing until that after-state is current. */
export async function prepareSendLineage<T extends SendState>(path:string,before:T,after:T,alias:string,send:boolean,hash:(s:T)=>string,signal?:AbortSignal){
 const next=changed(before,alias,send);if(!same(next,after))return;
 const prior=await readPrivateJson(path,maxBytes,signal);
 const lineage:Lineage=prior?decode(prior.value,before):{schema:'fleet-send-lineage/v1',storeId:before.storeId,namespace:structuredClone(before.namespace),steps:[]};
 // Supersede an uncommitted future proof. Past gaps remain gaps, never authority.
 lineage.steps=lineage.steps.filter(s=>s.from<before.revision);
 lineage.steps.push({from:before.revision,to:after.revision,alias,send,before:hash(before),after:hash(after)});lineage.steps=lineage.steps.slice(-limit);
 while(Buffer.byteLength(JSON.stringify(lineage)+'\n')>maxBytes&&lineage.steps.length>1)lineage.steps.shift();
 await writePrivateJson(path,lineage,{signal,expected:prior?.identity??null});
}
/** A failed explicit write can leave a future proof. An equivalent generic
 * reconnect/no-op must retire it before publication, including before a later
 * explicit send can extend the chain. Real read/approve revocations cannot
 * match a send-only state and never depend on optional continuity metadata. */
export async function retireFutureSendLineage<T extends SendState>(path:string,before:T,after:T,signal?:AbortSignal){
 const couldMatch=before.bindings.some(b=>b.status==='active'&&b.rights[0]==='read'&&[false,true].some(send=>same(changed(before,b.alias,send),after)));
 if(!couldMatch)return;
 const prior=await readPrivateJson(path,maxBytes,signal);if(!prior)return;
 const lineage=decode(prior.value,before),steps=lineage.steps.filter(s=>s.from<before.revision);if(steps.length===lineage.steps.length)return;
 lineage.steps=steps;await writePrivateJson(path,lineage,{signal,expected:prior.identity});
}
function readNow(path:string):unknown{
 const uid=process.getuid?.();if(uid===undefined)throw Error('send_lineage_unsafe');
 for(let p=dirname(path);;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.uid!==uid&&s.uid!==0)||((s.mode&0o022)!==0&&!(s.uid===0&&(s.mode&0o1000)!==0))||(p===dirname(path)&&(s.uid!==uid||(s.mode&0o077)!==0)))throw Error('send_lineage_unsafe');if(p===dirname(p))break;}
 const parentStamp=(s:Stats)=>[s.dev,s.ino,s.uid,s.mode].join(':');
 const parent=parentStamp(lstatSync(dirname(path))),before=lstatSync(path);
 const safe=(s:Stats)=>{if(!s.isFile()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o077)!==0||s.nlink!==1||s.size<1||s.size>maxBytes)throw Error('send_lineage_unsafe');};safe(before);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const held=fstatSync(fd);safe(held);if(privateFileIdentity(held)!==privateFileIdentity(before))throw Error('send_lineage_changed');const bytes=Buffer.alloc(held.size+1);let count=0;
  while(count<bytes.length){const n=readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
  if(count!==held.size||privateFileIdentity(fstatSync(fd))!==privateFileIdentity(held)||privateFileIdentity(lstatSync(path))!==privateFileIdentity(held)||parentStamp(lstatSync(dirname(path)))!==parent)throw Error('send_lineage_changed');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,count)));
 }finally{closeSync(fd);}
}
/** Caller pins both policy reads and an issued starting state. Every intermediate
 * state is reconstructed; endpoint equality cannot hide revoke/re-enroll ABA. */
export function verifySendLineage<T extends SendState>(path:string,before:T,after:T,owner:TargetEpoch,hash:(s:T)=>string):boolean{
 try{const anchor=before.bindings.find(b=>targetKey(b.target)===targetKey(owner));if(!anchor||anchor.status!=='active'||anchor.rights[0]!=='read'||after.revision<=before.revision)return false;
  const lineage=decode(readNow(path),before);let state=structuredClone(before);
  for(const step of lineage.steps){if(step.from<state.revision)continue;if(state.revision===after.revision)break;
   if(step.from!==state.revision||step.alias!==anchor.alias||step.before!==hash(state))return false;
   state=changed(state,step.alias,step.send);if(step.to!==state.revision||step.after!==hash(state))return false;
  }
  return same(state,after);
 }catch{return false;}
}
