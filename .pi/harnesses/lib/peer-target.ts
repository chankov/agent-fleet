import {join} from 'node:path';
import type {LayoutNode} from './herdr-client.ts';
import {sessionRootsFromEnv,validateSessionRoots,projectForSession,targetProject,type SessionRoots} from './workspace-context.ts';
export function peerTarget(project:string,baseProject?:string){
 const roots=sessionRootsFromEnv();if(roots?.mode!=='targeted')return undefined;
 if(baseProject&&targetProject(baseProject,roots)!==project)throw Error('peer_target_project_mismatch');
 return {roots,...(baseProject?{baseProject,project}:projectForSession(project,roots))};
}
export function targetPaneEnv(env:Record<string,string>|undefined,roots:SessionRoots,baseProject:string,project:string){
 validateSessionRoots(roots);
 if(targetProject(baseProject,roots)!==project)throw Error('peer_target_project_mismatch');
 const routing={AF_SESSION_ROOTS:JSON.stringify(roots),AF_TARGET_BASE_PROJECT:baseProject,AF_TARGET_EFFECTIVE_PROJECT:project};
 for(const [key,value] of Object.entries(env??{}))if(key.startsWith('GIT_')||key in routing&&value!==routing[key as keyof typeof routing])throw Error(`peer_context_override:${key}`);
 return {...env,...routing};
}
export function targetPeerCommand(command:string[],roots:SessionRoots){
 validateSessionRoots(roots);
 return command[0]==='just'?['just','--justfile',join(roots.workspaceRoot,'justfile'),'--working-directory',roots.workspaceRoot,...command.slice(1)]:command;
}
export function bindTargetLayout(node:LayoutNode,target:ReturnType<typeof peerTarget>):LayoutNode {
 if(!target)return node;
 if(node.type==='split')return {...node,first:bindTargetLayout(node.first,target),second:bindTargetLayout(node.second,target)};
 return {...node,cwd:target.roots.executionRoot,command:targetPeerCommand(node.command??[],target.roots),env:targetPaneEnv(node.env,target.roots,target.baseProject,target.project)};
}
