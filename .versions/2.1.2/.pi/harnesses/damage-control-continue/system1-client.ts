import {projectDamageResult,validDamageResultMetadata,damageResultGap,type DamageResultEvent,type DamageResultMetadata} from './result-screen.ts';
import {randomUUID} from 'node:crypto';
import {connect,type Socket} from 'node:net';
import {DAMAGE_FRAME_BYTES,exactKeys,decodeDamageFrame,validDamageAssignment,validDamageInput,damageAssessmentFrame,damageControlFrame,verifyDamageFrame,type DamageOutcome} from '../agent-hub/damage-guard-broker.ts';
export interface DamageClientResult {outcome:DamageOutcome;}
/** Transport only. No configuration discovery, providers, hooks, grants or effects.
 * A granted result is semantic evidence only: callers must revalidate their own
 * baseline authority. Lost replies never become an allow. No reconnect/retry.
 */
export function createDamageClient(assignment?:unknown,limits:{technicalMs?:number;humanMs?:number}={}){
 let trusted:Readonly<{path:string;capability:string}>|undefined;
 try{if(validDamageAssignment(assignment)&&process.platform!=='win32')trusted=Object.freeze({...assignment});}catch{/* Invalid trusted assignment is indeterminate. */}
 const validLimits=[limits.technicalMs,limits.humanMs].every(v=>v===undefined||Number.isSafeInteger(v)&&v>0);
 const technical=Math.min(2000,limits.technicalMs??2000),human=Math.min(600000,limits.humanMs??600000);
 const cancellations=new Set<()=>void>();let disposed=false;
 return {
  result(event:DamageResultEvent,options:{signal?:AbortSignal;deadlineAt?:number}={}):Promise<DamageResultMetadata>{
   if(disposed||options.signal?.aborted)return Promise.resolve(damageResultGap('cancelled'));
   if(!trusted||!validLimits)return Promise.resolve(damageResultGap('transport_unavailable'));
   const deadline=Math.min(performance.timeOrigin+performance.now()+technical,options.deadlineAt??Infinity),id=randomUUID();
   let frame:Buffer;
   try{const evidence=projectDamageResult(event);if(!evidence)return Promise.resolve(damageResultGap('unsupported_source'));frame=Buffer.from(JSON.stringify(damageControlFrame(trusted,id,'screen_result',{evidence,deadline}))+'\n');}catch{return Promise.resolve(damageResultGap('unsupported_source'));}
   if(frame.length>DAMAGE_FRAME_BYTES||performance.timeOrigin+performance.now()>=deadline)return Promise.resolve(damageResultGap('transport_unavailable'));
   return new Promise(resolve=>{
    let socket:Socket|undefined,buffer=Buffer.alloc(DAMAGE_FRAME_BYTES),used=0,terminal:DamageResultMetadata|undefined,settled=false;
    const finish=(metadata:DamageResultMetadata)=>{if(settled)return;settled=true;clearTimeout(timer);cancellations.delete(cancel);options.signal?.removeEventListener('abort',cancel);socket?.removeAllListeners();socket?.on('error',()=>{});socket?.destroy();resolve(metadata);};
    const fail=()=>finish(damageResultGap('transport_unavailable')),cancel=()=>finish(damageResultGap('cancelled'));
    const timer=setTimeout(fail,Math.max(0,deadline-performance.timeOrigin-performance.now()));cancellations.add(cancel);options.signal?.addEventListener('abort',cancel,{once:true});
    try{socket=connect(trusted.path);}catch{fail();return;}
    socket.once('connect',()=>{if(!settled)socket!.write(frame);});socket.on('error',fail);
    socket.on('data',(chunk:Buffer|string)=>{
     const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);if(terminal||used+bytes.length>DAMAGE_FRAME_BYTES||performance.timeOrigin+performance.now()>=deadline){fail();return;}
     bytes.copy(buffer,used);used+=bytes.length;const newline=buffer.subarray(0,used).indexOf(10);if(newline<0)return;
     if(newline!==used-1){fail();return;}let row:unknown;try{row=decodeDamageFrame(buffer.subarray(0,newline));}catch{fail();return;}
     if(!exactKeys(row,['v','id','result','auth'])||!verifyDamageFrame(row,trusted.capability)||row.v!==1||row.id!==id||!validDamageResultMetadata(row.result)){fail();return;}
     terminal=row.result;used=0;
    });
    socket.once('end',()=>{if(used||!terminal||performance.timeOrigin+performance.now()>=deadline)fail();else finish(terminal);});socket.once('close',()=>{if(!settled)fail();});if(options.signal?.aborted)cancel();
   });
  },
  assess(tool:string,input:unknown,options:{signal?:AbortSignal}={}):Promise<DamageClientResult>{
   if(disposed||options.signal?.aborted)return Promise.resolve({outcome:'cancelled'});
   if(!validLimits)return Promise.resolve({outcome:'indeterminate'});
   if(!trusted)return Promise.resolve({outcome:assignment===undefined?'unavailable':'indeterminate'});
   // Include cloning/encoding and transport in the same non-extendable budget.
   const technicalDeadline=performance.now()+technical;
   let frame:Buffer;const id=randomUUID();
   try{const exactInput=structuredClone(input);if(!validDamageInput(tool,exactInput))return Promise.resolve({outcome:'indeterminate'});frame=Buffer.from(JSON.stringify(damageAssessmentFrame(trusted,id,tool,exactInput,performance.timeOrigin+technicalDeadline))+'\n');}catch{return Promise.resolve({outcome:'indeterminate'});}
   if(frame.length>DAMAGE_FRAME_BYTES)return Promise.resolve({outcome:'indeterminate'});
   // Clock starts before connect/write, never restarts on connection or reply.
   return new Promise(resolve=>{
    let deadline=technicalDeadline;
    let socket:Socket|undefined,buffer=Buffer.alloc(DAMAGE_FRAME_BYTES),used=0,total=0,held=false,terminal:DamageOutcome|undefined,settled=false;
    const finish=(outcome:DamageOutcome)=>{
     if(settled)return;settled=true;clearTimeout(timer);cancellations.delete(cancel);options.signal?.removeEventListener('abort',cancel);
     socket?.removeAllListeners();socket?.on('error',()=>{});socket?.destroy();resolve({outcome});
    };
    const fail=()=>finish(held?'blocked':'indeterminate');
    const cancel=()=>finish(held?'blocked':'cancelled');
    let timer=setTimeout(fail,Math.max(0,deadline-performance.now()));cancellations.add(cancel);options.signal?.addEventListener('abort',cancel,{once:true});
    try{socket=connect(trusted.path);}catch{fail();return;}
    socket.once('connect',()=>{if(!settled)socket!.write(frame);});
    socket.on('error',fail);
    socket.on('data',(chunk:Buffer|string)=>{
     if(performance.now()>=deadline){fail();return;}
     const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=bytes.length;if(total>DAMAGE_FRAME_BYTES){fail();return;}bytes.copy(buffer,used);used+=bytes.length;
     for(let newline;(newline=buffer.subarray(0,used).indexOf(10))>=0;){
      let row:unknown;try{row=decodeDamageFrame(buffer.subarray(0,newline));}catch{fail();return;}buffer.copyWithin(0,newline+1,used);used-=newline+1;
      if(!exactKeys(row,['v','id','outcome','auth'])||!verifyDamageFrame(row,trusted.capability)||row.v!==1||row.id!==id||terminal){fail();return;}
      if(row.outcome==='held'){
       if(held){fail();return;}held=true;deadline=performance.now()+human;clearTimeout(timer);timer=setTimeout(fail,human);continue;
      }
      if(typeof row.outcome!=='string'||!['no_hold','unavailable','blocked','granted','cancelled','revoked','indeterminate'].includes(row.outcome)||row.outcome==='granted'&&!held||held&&['no_hold','unavailable','indeterminate'].includes(row.outcome)){fail();return;}
      terminal=row.outcome as DamageOutcome;
     }
    });
    // Commit only at clean EOF: duplicate/extra/partial replies cannot race an allow.
    socket.once('end',()=>{if(performance.now()>=deadline||used||!terminal)fail();else finish(terminal);});
    socket.once('close',()=>{if(!settled)fail();});
    if(options.signal?.aborted)cancel();
   });
  },
  dispose(){if(disposed)return;disposed=true;for(const cancel of [...cancellations])cancel();},
 };
}
