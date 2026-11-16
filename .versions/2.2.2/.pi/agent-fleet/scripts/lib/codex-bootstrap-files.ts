import {constants,lstatSync,type Stats} from 'node:fs';
import {lstat,mkdir,open,rename,unlink,type FileHandle} from 'node:fs/promises';
import {isAbsolute,resolve,dirname,parse} from 'node:path';
import {randomUUID} from 'node:crypto';
export const privateFileIdentity=(s:Stats)=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeMs,s.ctimeMs].join(':');
const directoryIdentity=(s:Stats)=>[s.dev,s.ino,s.uid,s.mode].join(':');
const missing=(e:unknown)=>(e as any)?.code==='ENOENT';
export function canonicalPrivatePath(path:string){return typeof path==='string'&&path.length<=4096&&isAbsolute(path)&&resolve(path)===path&&!/[\u0000-\u001f\u007f]/.test(path);}
function check(signal?:AbortSignal,guard?:()=>void){if(signal?.aborted)throw Error('bootstrap_file_cancelled');guard?.();if(signal?.aborted)throw Error('bootstrap_file_cancelled');}
/** Explicit user-owned local POSIX directory; no mode repair or symlink walk. */
export async function privateDirectory(path:string,create=false){
 if(!canonicalPrivatePath(path)||path===parse(path).root||typeof process.getuid!=='function')throw Error('bootstrap_directory_unsafe');
 const chain:string[]=[];for(let p=path;;p=dirname(p)){chain.unshift(p);if(p===dirname(p))break;}
 for(const p of chain){let s:Stats;try{s=await lstat(p);}catch(e){if(!create||!missing(e))throw e;try{await mkdir(p,{mode:0o700});}catch(x){if((x as any)?.code!=='EEXIST')throw x;}s=await lstat(p);}
  if(!s.isDirectory()||s.isSymbolicLink()||(s.uid!==0&&s.uid!==process.getuid())||((s.mode&0o022)!==0&&!(s.uid===0&&(s.mode&0o1000)!==0))||(p===path&&(s.uid!==process.getuid()||(s.mode&0o077)!==0)))throw Error('bootstrap_directory_unsafe');
 }
 return directoryIdentity(await lstat(path));
}
export function directoryCurrent(path:string,expected:string){try{const s=lstatSync(path);return s.isDirectory()&&!s.isSymbolicLink()&&directoryIdentity(s)===expected;}catch{return false;}}
function safe(s:Stats,max:number){if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||s.nlink!==1||(s.mode&0o077)!==0||s.size<1||s.size>max)throw Error('bootstrap_file_unsafe');}
export async function readPrivateJson(path:string,max=32768,signal?:AbortSignal):Promise<{value:any;identity:string}|null>{
 if(!canonicalPrivatePath(path)||!Number.isSafeInteger(max)||max<1||max>65536)throw Error('bootstrap_file_invalid');let file:FileHandle|undefined;
 try{
  check(signal);const parent=await privateDirectory(dirname(path)),before=await lstat(path);safe(before,max);file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);const held=await file.stat();safe(held,max);if(privateFileIdentity(held)!==privateFileIdentity(before))throw Error('bootstrap_file_changed');
  const bytes=Buffer.alloc(held.size+1);let offset=0;while(offset<bytes.length){check(signal);const read=await file.read(bytes,offset,bytes.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
  if(offset!==held.size||privateFileIdentity(await file.stat())!==privateFileIdentity(held)||privateFileIdentity(await lstat(path))!==privateFileIdentity(held)||!directoryCurrent(dirname(path),parent))throw Error('bootstrap_file_changed');
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,offset)));await file.close();file=undefined;check(signal);return {value,identity:privateFileIdentity(held)};
 }catch(e){if(missing(e))return null;throw e;}finally{await file?.close();}
}
/** Owned temporary file + CAS publication. Unknown after rename is not rollback.
 * guard is trusted synchronous scope/epoch/lease validation immediately before
 * publication, never a model boolean. No repair/foreign replacement cleanup. */
export async function writePrivateJson(path:string,value:unknown,options:{signal?:AbortSignal;guard?:()=>void;expected?:string|null;createParent?:boolean}={}){
 const encoded=JSON.stringify(value);if(typeof encoded!=='string')throw Error('bootstrap_file_invalid');const bytes=Buffer.from(encoded+'\n');if(bytes.length>32768||!canonicalPrivatePath(path))throw Error('bootstrap_file_limit');
 const {signal,guard,expected:requestedExpected,createParent}=options;check(signal,guard);const parent=await privateDirectory(dirname(path),createParent===true);check(signal,guard);
 const at=async()=>{try{const s=await lstat(path);safe(s,32768);return privateFileIdentity(s);}catch(e){if(missing(e))return null;throw e;}};
 const expected=requestedExpected===undefined?await at():requestedExpected,temp=path+'.tmp-'+randomUUID();let file:FileHandle|undefined,owned:Stats|undefined,staged:string|undefined,renamed=false;
 try{
  check(signal,guard);file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);owned=await file.stat();await file.writeFile(bytes);await file.sync();staged=privateFileIdentity(await file.stat());await file.close();file=undefined;
  if(!directoryCurrent(dirname(path),parent)||await at()!==expected)throw Error('bootstrap_file_changed');check(signal,guard);
  const pending=lstatSync(temp);safe(pending,32768);if(privateFileIdentity(pending)!==staged||!directoryCurrent(dirname(path),parent))throw Error('bootstrap_file_changed');
  await rename(temp,path);renamed=true;const dir=await open(dirname(path),constants.O_RDONLY|constants.O_DIRECTORY);try{await dir.sync();}finally{await dir.close();}
  check(signal,guard);if(!directoryCurrent(dirname(path),parent))throw Error('bootstrap_file_changed');const result=await readPrivateJson(path,32768,signal);if(!result||JSON.stringify(result.value)+'\n'!==bytes.toString('utf8'))throw Error('bootstrap_file_changed');check(signal,guard);return result.identity;
 }catch(e){if(renamed)throw Error('bootstrap_file_publication_unknown');throw e;}
 finally{try{await file?.close();}finally{if(!renamed&&owned){try{const s=await lstat(temp);if(s.dev!==owned.dev||s.ino!==owned.ino||!s.isFile()||s.uid!==process.getuid?.()||(staged!==undefined&&privateFileIdentity(s)!==staged))throw Error('bootstrap_file_cleanup_unsafe');await unlink(temp);}catch(e){if(!missing(e))throw e;}}}}
}
