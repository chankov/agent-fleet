import {TARGET_CAPABILITIES} from '../../../harnesses/lib/target-capabilities.js';
import {existsSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {readDamagePolicy} from '../../../harnesses/lib/damage-policy.ts';
import {loadSystem1Snapshot} from '../../../harnesses/lib/system1/config-loader.js';
import {resourceClosureGaps} from './resource-closure.js';
import {assertRuntimeDependencies} from './runtime-dependencies.js';
import {sessionRootsFromEnv,validateSessionRoots,targetProject,projectForSession,targetEnvironment,type SessionRoots} from '../../../harnesses/lib/workspace-context.ts';
export {targetProject,projectForSession,targetEnvironment};
const mandatory=['.pi/harnesses/damage-control-continue/index.ts','.pi/harnesses/agent-hub/index.ts','.pi/harnesses/agent-hub/delegate.ts','.pi/harnesses/ask-user-remote/index.ts','.pi/extensions/compact-and-continue/index.ts','.pi/extensions/btw/index.ts'];
function ownedResource(roots:SessionRoots,path:string){return [roots.workspaceRoot,roots.resourceRoot].some(root=>path.startsWith(root+'/'));}
export function targetReadiness(roots:SessionRoots){
 validateSessionRoots(roots);const gaps:string[]=resourceClosureGaps(roots.resourceRoot,mandatory.map(path=>join(roots.workspaceRoot,path)),[roots.workspaceRoot]);
 for(const path of ['justfile','.pi/harnesses/package.json','.pi/extensions/package.json','.pi/agent-fleet/scripts/package.json',...mandatory]){const full=join(roots.workspaceRoot,path);if(!existsSync(full))gaps.push(`missing_resource:${path}`);else if(!ownedResource(roots,realpathSync(full)))gaps.push(`foreign_resource:${path}`);}
 try{assertRuntimeDependencies(roots.workspaceRoot);}catch{gaps.push('missing_runtime_dependencies:run just fleet deps from af');}
 try{if(!readDamagePolicy(roots.executionRoot,roots))gaps.push('missing_workspace_damage_policy');}catch{gaps.push('invalid_workspace_damage_policy');}
 const snapshot=loadSystem1Snapshot(roots.executionRoot,roots);
 const consumers=Object.fromEntries(Object.entries(snapshot.consumers).map(([name,section]:[string,any])=>[name,{status:section.status,reason:section.reason,mode:section.config?.mode,providerChecked:false,applicabilityChecked:false}]));
 return {ready:gaps.length===0,gaps,workspaceRoot:roots.workspaceRoot,resourceRoot:roots.resourceRoot,executionRoot:roots.executionRoot,repositoryRoot:roots.repositoryRoot,targetId:roots.targetId,consumers,capabilities:TARGET_CAPABILITIES};
}
export function buildSessionLaunch(args:string[],env=process.env,cwd=process.cwd()){
 const roots=sessionRootsFromEnv(env);
 if(!roots||roots.mode!=='targeted')return {command:'pi',args,cwd,env};
 const readiness=targetReadiness(roots);if(!readiness.ready)throw Error(`Targeted launch refused: ${readiness.gaps.join('; ')}`);
 const boundary=args.indexOf('--'),end=boundary<0?args.length:boundary;
 const options=args.slice(0,end),tail=args.slice(end);
 if(options.includes('--approve')||options.includes('-a'))throw Error('Targeted sessions ignore project-local runtime configuration; remove --approve');
 if(!options.includes('--no-extensions'))throw Error('Targeted launch refuses automatic extension discovery; remove --all-extensions');
 if(options.some(arg=>arg==='--session-dir'||arg.startsWith('--session-dir=')))throw Error("Targeted sessions keep Pi's cwd-scoped history; remove --session-dir");
 const resolved:string[]=[],resources:string[]=[];let base=env.AF_TARGET_BASE_PROJECT??'default';
 for(let i=0;i<options.length;i++){
  const arg=options[i];
  if(arg==='--project'){const value=options[++i];if(!value||value.startsWith('-'))throw Error('--project requires a namespace');base=value;continue;}
  if(/^--(?:extension|skill|prompt-template)=/.test(arg))throw Error('Use separate resource option and workspace path');
  resolved.push(arg);
  if(['-e','--extension','--skill','--prompt-template'].includes(arg)){
   const value=options[++i];if(!value)throw Error(`${arg} requires a workspace resource`);
   const path=realpathSync(resolve(roots.workspaceRoot,value));if(!ownedResource(roots,path))throw Error(`Resource outside Fleet workspace: ${value}`);resolved.push(path);if(arg==='-e'||arg==='--extension')resources.push(path);
  }else if(arg==='--append-system-prompt'){
   const value=options[++i];if(value===undefined)throw Error('Missing system prompt');
   const candidate=resolve(roots.workspaceRoot,value);
   if(existsSync(candidate)){const canonical=realpathSync(candidate);if(!ownedResource(roots,canonical))throw Error('Persona is outside Fleet workspace');resolved.push(canonical);}else resolved.push(value);
  }
 }
 for(const path of mandatory.slice(0,1))if(!resolved.includes(realpathSync(join(roots.workspaceRoot,path))))throw Error('Missing mandatory Damage-Control extension');
 resolved.push('--no-approve','--no-mcp','--no-themes','--no-skills','--no-prompt-templates');
 for(const [flag,path] of [['--skill','.pi/skills'],['--skill','skills'],['--prompt-template','.pi/prompts']])if(existsSync(join(roots.workspaceRoot,path))){
  const canonical=realpathSync(join(roots.workspaceRoot,path));if(!ownedResource(roots,canonical))throw Error(`Foreign workspace resource: ${path}`);resolved.push(flag,canonical);
 }
 for(const name of ['AGENTS.md','CLAUDE.md']){const file=join(roots.workspaceRoot,name);if(existsSync(file)){const canonical=realpathSync(file);if(!ownedResource(roots,canonical))throw Error('Foreign workspace instruction resource');resolved.push('--append-system-prompt',canonical);break;}}
 const closure=resourceClosureGaps(roots.resourceRoot,resources,[roots.workspaceRoot]);
 if(closure.length)throw Error(`Incomplete workspace resource closure: ${closure.join('; ')}`);
 const project=projectForSession(base,roots,env);
 if(resolved.some(arg=>arg.endsWith('/agent-hub/index.ts')||arg.endsWith('/coms/index.ts')))resolved.push('--project',project.project);
 return {command:'pi',args:[...resolved,...tail],cwd:roots.executionRoot,env:{...targetEnvironment(roots,env),AF_TARGET_BASE_PROJECT:project.baseProject,AF_TARGET_EFFECTIVE_PROJECT:project.project}};
}
