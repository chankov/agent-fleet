/** One active human wait per process. Reset aborts authority but retains the tail until old UI closes. */
export function createApprovalWait(){
 let tail:Promise<unknown>=Promise.resolve(),generation=0;const controllers=new Set<AbortController>();
 return {
  run<T>(work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T|undefined>{
   const epoch=generation,controller=new AbortController(),abort=()=>controller.abort();controllers.add(controller);
   if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
   const result=tail.then(async()=>{if(controller.signal.aborted||epoch!==generation)return undefined;const value=await work(controller.signal);return controller.signal.aborted||epoch!==generation?undefined:value;});
   tail=result.catch(()=>{});
   return result.finally(()=>{controllers.delete(controller);signal?.removeEventListener('abort',abort);});
  },
  reset(){generation++;for(const controller of controllers)controller.abort();},
 };
}
export const sharedApprovalWait=createApprovalWait();
