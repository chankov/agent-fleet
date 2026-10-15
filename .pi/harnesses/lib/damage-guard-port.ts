export interface DamageCallEvent {toolName:string;toolCallId:string;input:unknown;}
export interface DamageCallContext {cwd:string;revalidateBaseline?():boolean;}
export interface DamageGuardPort {call(event:DamageCallEvent,ctx:DamageCallContext):Promise<{block:boolean;reason?:string}>;}
let port:DamageGuardPort|undefined;
/** Process-owned adapter only. Missing registration preserves standalone baseline, not a second provider. */
export function registerDamageGuard(next:DamageGuardPort){port=next;return ()=>{if(port===next)port=undefined;};}
export function assessDamageCall(event:DamageCallEvent,ctx:DamageCallContext){return port?port.call(event,ctx):Promise.resolve({block:false});}
