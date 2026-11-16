import * as runtime from "./workspace-context.js";
export interface RootIdentity { readonly path: string; readonly device: string; readonly inode: string; readonly birthtime:string }
export interface SessionRoots {
 readonly version: 1; readonly mode: "legacy" | "targeted";
 readonly workspaceRoot: string; readonly resourceRoot: string; readonly executionRoot: string;
 readonly repositoryRoot?: string; readonly worktreeRoot?: string; readonly commonDir?: string; readonly gitDir?: string;
 readonly commonDirectoryIdentity?: RootIdentity; readonly gitDirectoryIdentity?: RootIdentity;
 readonly resourceIdentity:RootIdentity; readonly workspaceIdentity: RootIdentity; readonly executionIdentity: RootIdentity;
 readonly repositoryIdentity?: RootIdentity; readonly configBase: string; readonly targetId: string;
}
export interface WorktreeSelection { worktree: string; repository?: string }
export const resolveSessionRoots = runtime.resolveSessionRoots as (workspace: string, selection?: WorktreeSelection, execution?: string) => SessionRoots;
export const validateSessionRoots = runtime.validateSessionRoots as (binding: SessionRoots) => SessionRoots;
export const sessionRootsFromEnv = runtime.sessionRootsFromEnv as (env?: NodeJS.ProcessEnv) => SessionRoots | undefined;
export const workspaceRoot = runtime.workspaceRoot as (cwd: string, env?: NodeJS.ProcessEnv) => string;
export const executionRoot = runtime.executionRoot as (cwd: string, env?: NodeJS.ProcessEnv) => string;
export const sessionGitEnv = runtime.sessionGitEnv as (env?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
export const withSessionRoots=runtime.withSessionRoots as <T>(binding:SessionRoots,body:()=>T)=>T;
export const targetProject=runtime.targetProject as (base:string,roots:SessionRoots)=>string;
export const projectForSession=runtime.projectForSession as (base:string,roots:SessionRoots,env?:NodeJS.ProcessEnv)=>{baseProject:string;project:string};
export const targetEnvironment=runtime.targetEnvironment as (roots:SessionRoots,env?:NodeJS.ProcessEnv)=>NodeJS.ProcessEnv;
export const parseWorktreeSelection = runtime.parseWorktreeSelection as (args: string[]) => { rest: string[]; selection?: WorktreeSelection };
