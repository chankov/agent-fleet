import {constants,lstatSync,type BigIntStats} from 'node:fs';
import {lstat,open,opendir,readlink,realpath} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {compareCodexVersions} from '../../../harnesses/lib/codex-compat.ts';
import {canonicalPrivatePath,privateDirectory} from './codex-bootstrap-files.ts';

export type AutomaticDesktopData={desktopPid:number;desktopVersion:string;socketPath:string;codexHome:string;binaryPath?:string};
export type DesktopPackageEvidence={version:string;path:string;fileIdentity:string};
export type DesktopDiscoveryOptions={codexHome:string;procRoot?:string;desktopExecutable?:string;socketRoot?:string;platform?:string};
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.uid,s.mode,s.nlink,s.size,s.mtimeNs,s.ctimeNs].join(':');
const fail=(code:string):never=>{throw Error('desktop_discovery_'+code);};
function check(signal:AbortSignal,until:number){if(signal.aborted)fail('cancelled');if(performance.now()>=until)fail('overdue');}
function safeStat(s:BigIntStats,executable=false){const uid=BigInt(process.getuid!());return s.isFile()&&!s.isSymbolicLink()&&(s.uid===uid||s.uid===0n)&&(s.mode&0o6022n)===0n&&s.nlink===1n&&(!executable||(s.mode&0o111n)!==0n);}
async function ancestors(path:string){
 for(let p=path;;p=dirname(p)){const s=await lstat(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.uid!==0&&s.uid!==process.getuid?.())||((s.mode&0o022)!==0&&!(s.uid===0&&(s.mode&0o1000)!==0)))fail('unsafe_parent');if(p===dirname(p))break;}
}
function ancestorsNow(path:string){
 for(let p=path;;p=dirname(p)){const s=lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||(s.uid!==0&&s.uid!==process.getuid?.())||((s.mode&0o022)!==0&&!(s.uid===0&&(s.mode&0o1000)!==0)))return false;if(p===dirname(p))return true;}
}
async function small(path:string,max:number,signal:AbortSignal,until:number){
 check(signal,until);const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const bytes=Buffer.alloc(max+1);let size=0;while(size<bytes.length){check(signal,until);const r=await f.read(bytes,size,bytes.length-size,null);if(!r.bytesRead)break;size+=r.bytesRead;}check(signal,until);if(size>max)fail('limit');return bytes.subarray(0,size);}finally{await f.close();}
}
/** Read only the bounded ASAR header and package.json from the selected Desktop's
 * installation. Never substitute SDK/UA/CLI claims for the real Desktop version. */
export async function readDesktopPackageVersion(executable:string,signal:AbortSignal):Promise<DesktopPackageEvidence>{
 if(!canonicalPrivatePath(executable)||typeof process.getuid!=='function')fail('unsupported');
 const path=join(dirname(executable),'resources','app.asar'),until=performance.now()+2000;await ancestors(dirname(path));check(signal,until);
 const before=await lstat(path,{bigint:true});if(!safeStat(before)||before.size<16n||before.size>2147483648n)fail('package_unsafe');
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  if(stamp(await f.stat({bigint:true}))!==stamp(before))fail('package_changed');
  const read=async(size:number,offset:number)=>{const b=Buffer.alloc(size);let n=0;while(n<size){check(signal,until);const r=await f.read(b,n,size-n,offset+n);if(!r.bytesRead)fail('package_invalid');n+=r.bytesRead;}return b;};
  const prefix=await read(8,0),size=prefix.readUInt32LE(4);if(prefix.readUInt32LE(0)!==4||size<8||size>8*1024*1024||8+size>Number(before.size))fail('package_invalid');
  const header=await read(size,8),length=header.readUInt32LE(4);if(length<2||length>size-8)fail('package_invalid');
  let entry:any;try{entry=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(header.subarray(8,8+length)))?.files?.['package.json'];}catch{fail('package_invalid');}
  if(!entry||entry.unpacked||typeof entry.offset!=='string'||!/^\d{1,12}$/.test(entry.offset)||!Number.isInteger(entry.size)||entry.size<2||entry.size>65536)fail('package_invalid');
  const at=8+size+Number(entry.offset);if(!Number.isSafeInteger(at)||at+entry.size>Number(before.size))fail('package_invalid');
  let pkg:any;try{pkg=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read(entry.size,at)));}catch{fail('package_invalid');}
  if(pkg?.name!=='openai-codex-electron'||typeof pkg.version!=='string'||pkg.version.length>256||compareCodexVersions(pkg.version,pkg.version)!==0)fail('package_version');
  if(stamp(await f.stat({bigint:true}))!==stamp(before)||stamp(await lstat(path,{bigint:true}))!==stamp(before))fail('package_changed');check(signal,until);
  return {version:pkg.version,path,fileIdentity:stamp(before)};
 }finally{await f.close();}
}
export function desktopPackageCurrent(evidence:DesktopPackageEvidence){try{return ancestorsNow(dirname(evidence.path))&&stamp(lstatSync(evidence.path,{bigint:true}))===evidence.fileIdentity;}catch{return false;}}
/** Trusted server composition only. No tool arguments, shell, process starts,
 * auth/profile reads, file repair, queue writes or default selection by recency. */
export class AutomaticDesktopDiscovery {
 private readonly options:DesktopDiscoveryOptions;
 constructor(options:DesktopDiscoveryOptions){this.options={...options};}
 async discover(signal:AbortSignal):Promise<AutomaticDesktopData>{
  try{return await this.#discover(signal);}catch(e){
   if(e instanceof Error&&/^desktop_discovery_[a-z_]{1,64}$/.test(e.message))throw e;
   const code=(e as NodeJS.ErrnoException)?.code;return fail(code==='ENOENT'?'unavailable':code==='EACCES'||code==='EPERM'?'io_denied':'failed');
  }
 }
 async #discover(signal:AbortSignal):Promise<AutomaticDesktopData>{
  if((this.options.platform??process.platform)!=='linux'||typeof process.getuid!=='function')fail('unsupported');
  const uid=process.getuid!(),proc=this.options.procRoot??'/proc',exe=this.options.desktopExecutable??'/usr/lib/chatgpt/ChatGPT',home=this.options.codexHome,root=this.options.socketRoot??'/tmp/codex-daemon-'+uid,until=performance.now()+5000;
  if(![proc,exe,home,root].every(canonicalPrivatePath))fail('options');check(signal,until);await ancestors(dirname(exe));
  const desktop=await lstat(exe,{bigint:true});if(!safeStat(desktop,true))fail('executable_unsafe');
  const pids:number[]=[],dir=await opendir(proc);let count=0;
  try{for await(const d of dir){check(signal,until);if(++count>16384)fail('limit');if(!/^\d{1,10}$/.test(d.name))continue;
   const path=join(proc,d.name);try{const owner=await lstat(path);if(!owner.isDirectory()||owner.isSymbolicLink()||owner.uid!==uid)continue;
    if((await small(join(path,'comm'),256,signal,until)).toString('utf8').trim()!=='ChatGPT')continue;
    const command=await small(join(path,'cmdline'),16384,signal,until);if(command.includes('--type=')||await readlink(join(path,'exe'))!==exe)continue;pids.push(Number(d.name));
   }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'||(e as NodeJS.ErrnoException).code==='ESRCH')continue;throw e;}
  }}finally{try{await dir.close();}catch{}}
  if(pids.length!==1)fail(pids.length?'process_ambiguous':'process_unavailable');
  const pkg=await readDesktopPackageVersion(exe,signal);check(signal,until);await ancestors(home);const homeStat=await lstat(home);if(homeStat.uid!==uid)fail('home_unsafe');
  await privateDirectory(root);const unix=(await small(join(proc,'net','unix'),1024*1024,signal,until)).toString('utf8');
  const listening=new Set(unix.split('\n').flatMap(line=>{const p=line.trim().split(/\s+/);return p.length===8&&(parseInt(p[3],16)&0x10000)!==0&&p[4]==='0001'?[p[7]]:[];}));
  const sockets:string[]=[],entries=await opendir(root);count=0;
  try{for await(const d of entries){check(signal,until);if(++count>64)fail('limit');if(!/^[a-f0-9]{64}$/.test(d.name))continue;const path=join(root,d.name),s=await lstat(path);if(s.isSocket()&&s.uid===uid&&(s.mode&0o077)===0&&listening.has(path))sockets.push(path);}}finally{try{await entries.close();}catch{}}
  // The official managed endpoint belongs to the configured Codex home. Keep
  // its checked one-hop alias so the existing RPC pin also detects retargeting.
  const alias=join(home,'app-server-control','app-server-control.sock');let socketPath:string|undefined,aliasSeen=false;
  try{const at=await lstat(alias);aliasSeen=true;if(at.uid!==uid||!at.isSymbolicLink()||alias.length>100)fail('daemon_alias_unsafe');await privateDirectory(dirname(alias));const target=resolve(dirname(alias),await readlink(alias));if(!sockets.includes(target))fail('daemon_alias_unsafe');socketPath=alias;}
  catch(e){if(aliasSeen)throw e;if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(!socketPath){if(sockets.length!==1)fail(sockets.length?'daemon_ambiguous':'daemon_unavailable');socketPath=sockets[0];}
  let binaryPath:string|undefined;try{binaryPath=await realpath(join(home,'packages','standalone','current','bin','codex'));const releases=join(home,'packages','standalone','releases');if(!binaryPath.startsWith(releases+'/'))fail('binary_unsafe');await ancestors(dirname(binaryPath));const s=await lstat(binaryPath,{bigint:true});if(!safeStat(s,true))fail('binary_unsafe');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  check(signal,until);return {desktopPid:pids[0],desktopVersion:pkg.version,socketPath,codexHome:home,...(binaryPath?{binaryPath}:{})};
 }
}
