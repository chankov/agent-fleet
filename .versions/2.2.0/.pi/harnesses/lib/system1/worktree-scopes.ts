import * as runtime from './worktree-scopes.js';
import type { SessionRoots } from '../workspace-context.ts';
export interface WorktreeScopePreview {
 readonly version:1;readonly consumer:string;readonly targetId:string;readonly workspaceRoot:string;readonly executionRoot:string;readonly repositoryRoot:string;
 readonly provider:string;readonly model:string;readonly apiKeyEnv:string;readonly configurationHash:string;readonly scope:unknown;readonly effectiveScope:unknown;
 readonly policy:{readonly configurationHash:string;readonly roots:readonly {role:string;path:string;kind:string;device:string;inode:string}[]};readonly digest:string;
}
export const worktreeScopePreview=runtime.worktreeScopePreview as (document:any,consumer:string,binding?:SessionRoots)=>WorktreeScopePreview|undefined;
export const worktreeScopeApproved=runtime.worktreeScopeApproved as (document:any,consumer:string,binding?:SessionRoots)=>boolean;
export const approveWorktreeScope=runtime.approveWorktreeScope as (options:{consumer:string;readDocument:()=>any;ask?:(preview:WorktreeScopePreview)=>Promise<boolean>;binding?:SessionRoots})=>Promise<{status:string;reason?:string;digest?:string}>;
export const gateWorktreeConsumer=runtime.gateWorktreeConsumer as (document:any,consumer:string,section:any,binding?:SessionRoots)=>any;
export const projectWorktreeDocument=runtime.projectWorktreeDocument as (document:any,binding?:SessionRoots)=>any;
export const gateWorktreeSnapshot=runtime.gateWorktreeSnapshot as (snapshot:any,binding?:SessionRoots)=>any;
