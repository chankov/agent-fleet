import {createHash} from 'node:crypto';
import {constants,lstatSync,openSync,fstatSync,readSync,closeSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {parse} from 'yaml';
import {redactSecrets} from './fleet-transcript-store.ts';
export type AutoPolicyRule={id:string;decision:'deny'|'allow_once';source:'damage_control_path';category:'zero_access'|'read_only'|'no_delete';tool:'read'|'write'|'edit'|'bash';pattern:string;operation:'read'|'write'|'delete';expiresAt:string;reason:string};
export type DamageAutoPolicy={status:'disabled'|'valid'|'invalid';digest:string;rules:readonly AutoPolicyRule[]};
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const exact=(v:any,fields:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const safe=(v:any,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max&&redactSecrets(v)===v&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
/** User-owned opt-in only. No creation, installer ownership, global fallback or repair. */
export function loadDamageAutoPolicy(cwd:string):DamageAutoPolicy {
 let digest=sha('absent');
 try{
  const root=join(cwd,'.pi'),file=join(root,'damage-control-auto-policy.yaml');
  const stat=lstatSync(file); // A missing opt-in is disabled even in an ordinary shared checkout.
  const directory=lstatSync(root);if(directory.isSymbolicLink()||!directory.isDirectory()||directory.mode&0o022||directory.uid!==process.getuid?.()||realpathSync(root)!==resolve(root))throw Error('unsafe_directory');
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>32768||stat.mode&0o022||stat.uid!==process.getuid?.())throw Error('unsafe_policy');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text:string;
  try{
   const opened=fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.nlink!==1||!opened.isFile())throw Error('changed_policy');
   const buffer=Buffer.alloc(32769);const length=readSync(fd,buffer,0,buffer.length,0);if(length>32768)throw Error('oversize_policy');
   text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));
  }finally{closeSync(fd);}
  digest=sha(text);
  if(!text.trim())return {status:'disabled',digest,rules:[]};
  const parsed=parse(text,{uniqueKeys:true,maxAliasCount:0});
  if(!exact(parsed,['version','rules'])||parsed.version!==1||!Array.isArray(parsed.rules)||parsed.rules.length>64)throw Error('schema');
  const ids=new Set<string>();
  for(const r of parsed.rules){
   if(!exact(r,['id','decision','source','category','tool','pattern','operation','expiresAt','reason'])||!safe(r.id,96)||ids.has(r.id)||!['deny','allow_once'].includes(r.decision)||r.source!=='damage_control_path'||!['zero_access','read_only','no_delete'].includes(r.category)||!['read','write','edit','bash'].includes(r.tool)||!safe(r.pattern,2048)||!['read','write','delete'].includes(r.operation)||typeof r.expiresAt!=='string'||!Number.isFinite(Date.parse(r.expiresAt))||new Date(r.expiresAt).toISOString()!==r.expiresAt||!safe(r.reason,1000))throw Error('rule');
   if(r.category==='zero_access'&&r.decision==='allow_once')throw Error('zero_access_allow_forbidden');
   ids.add(r.id);
  }
  return {status:parsed.rules.length?'valid':'disabled',digest,rules:structuredClone(parsed.rules)};
 }catch(e){
  if((e as NodeJS.ErrnoException).code==='ENOENT')return {status:'disabled',digest,rules:[]};
  return {status:'invalid',digest:sha('invalid:'+digest),rules:[]};
 }
}
export function evaluateDamageAutoPolicy(policy:DamageAutoPolicy,input:{source:string;category:string;tool:string;pattern:string;analysis:'static_operands'|'conservative_text';operands:readonly {path:string;operation:'read'|'write'|'delete'}[];cwd:string;presentationSafe:boolean;d6Hold?:boolean},now=Date.now()){
 if(policy.status!=='valid'||!input.presentationSafe||input.d6Hold||input.analysis!=='static_operands'||input.operands.length!==1||!isAbsolute(input.operands[0].path))return null;
 const path=resolve(input.operands[0].path);
 // The policy can never authorize its own control plane or a D6 hold.
 const control=join(input.cwd,'.pi','damage-control-auto-policy.yaml');
 if(path===control||control.startsWith(path+'/'))return null;
 const matches=policy.rules.filter(r=>r.source===input.source&&r.category===input.category&&r.tool===input.tool&&r.pattern===input.pattern&&r.operation===input.operands[0].operation&&Date.parse(r.expiresAt)>now);
 if(matches.length!==1)return null;
 const rule=matches[0];if(rule.category==='zero_access'&&rule.decision==='allow_once')return null;
 return {decision:rule.decision,decisionSource:'auto_policy' as const,policyId:rule.id,policyDigest:policy.digest,reason:rule.reason};
}
