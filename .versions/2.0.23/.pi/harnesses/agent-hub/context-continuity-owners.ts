import {sessionRootsFromEnv,validateSessionRoots,type SessionRoots} from '../lib/workspace-context.ts';
import {randomUUID,createHash} from "node:crypto";
export interface ContextOwnerStatus {phase:"running"|"pending"|"compacting"|"recovered"|"continued"|"failed"|"cancelled";episode:number;tokens:number|null;window:number|null;cacheRead:number|null;cacheWrite:number|null;input:number|null;output:number|null}
export interface ContextOwner {readonly sessionRoots?:SessionRoots;readonly owner:string;readonly attempt:string;readonly parent:string|null;status:ContextOwnerStatus;active:boolean;readonly token:string}
const records=new Map<string,ContextOwner>();
export function openContextOwner(session:string,parent:string|null=null):ContextOwner {
 const owner=createHash("sha256").update(session).digest("hex"),attempt=randomUUID();
 const roots=sessionRootsFromEnv();
 const entry:ContextOwner={...(roots?.mode==='targeted'?{sessionRoots:roots}:{}),owner,attempt,parent,token:randomUUID()+randomUUID(),active:true,status:{phase:"running",episode:0,tokens:null,window:null,cacheRead:null,cacheWrite:null,input:null,output:null}};for(const key of ['owner','attempt','parent','token',...(roots?.mode==='targeted'?['sessionRoots']:[])])Object.defineProperty(entry,key,{writable:false,configurable:false});records.set(attempt,entry);if(records.size>256){for(const [id,record] of records){if(!record.active){records.delete(id);if(records.size<=256)break;}}}return entry;
}
export function revokeContextOwner(attempt:string):void {const owner=records.get(attempt);if(owner)owner.active=false;}
export function contextOwners():Omit<ContextOwner,"token">[] {return [...records.values()].map(({token,...record})=>({...record,status:{...record.status}}));}
export function admittedContextOwner(attempt:string,owner:string,token:string):ContextOwner|undefined {const entry=records.get(attempt);try{if(entry?.sessionRoots)validateSessionRoots(entry.sessionRoots);}catch{if(entry)entry.active=false;return undefined;}return entry?.active && entry.owner===owner && entry.token===token?entry:undefined;}
export function validContextStatus(value:any):value is ContextOwnerStatus {
 if(!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(k=>!["phase","episode","tokens","window","cacheRead","cacheWrite","input","output"].includes(k)) || !["running","pending","compacting","recovered","continued","failed","cancelled"].includes(value.phase) || !Number.isSafeInteger(value.episode) || value.episode<0)return false;
 return ["tokens","window","cacheRead","cacheWrite","input","output"].every(k=>value[k]===null || typeof value[k]==="number" && Number.isFinite(value[k]) && value[k]>=0);
}
