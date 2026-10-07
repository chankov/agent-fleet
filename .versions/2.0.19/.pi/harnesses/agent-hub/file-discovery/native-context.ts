import type {DiscoverySpawnRegistration} from './owners.ts';
export interface NativeDiscoveryInput {ownerId:string;task:string;query:string;scope:readonly string[];tools:readonly string[];cwd:string;signal?:AbortSignal}
export interface NativeDiscoveryContext {manifest:unknown;registration?:DiscoverySpawnRegistration;current():boolean}
export type PrepareNativeDiscovery=(input:NativeDiscoveryInput)=>Promise<NativeDiscoveryContext|null>;
export interface ResearchAdmission {readScope?:readonly string[];admit?():boolean}
export function appendDiscoveryContext(prompt:string,context:NativeDiscoveryContext|null|undefined):string {
 return context?`${prompt}\n\n## File discovery context (advisory, separate from task/policy/scope/evidence)\n${JSON.stringify(context.manifest)}`:prompt;
}
