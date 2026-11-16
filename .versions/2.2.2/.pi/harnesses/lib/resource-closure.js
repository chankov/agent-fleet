// Read-only health preflight for Fleet's workspace-owned local module closure.
// External package health is checked separately by runtime-dependencies.js.
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
export function resourceClosureGaps(workspace,entries,additionalRoots=[]){
 const root=realpathSync(workspace),allowed=[root,...additionalRoots.map(path=>realpathSync(path))],seen=new Set(),gaps=[];const queue=[...entries];
 while(queue.length){
  if(seen.size>1024){gaps.push('resource_closure_limit');break;}
  const input=queue.pop(),candidate=resolve(root,input);
  if(!existsSync(candidate)){gaps.push(`missing_resource:${input}`);continue;}
  const path=realpathSync(candidate);
  if(!allowed.some(owner=>path.startsWith(owner+'/'))){gaps.push(`foreign_resource:${input}`);continue;}
  if(seen.has(path))continue;seen.add(path);
  const stat=statSync(path);if(!stat.isFile()||stat.size>1024*1024){gaps.push(`invalid_resource:${input}`);continue;}
  if(!/\.[cm]?[jt]s$/.test(path))continue;
  const text=readFileSync(path,'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm,'');
  const imports=/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for(const match of text.matchAll(imports)){
   const specifier=match[1]??match[2];if(!specifier.startsWith('.')&&!isAbsolute(specifier))continue;
   let target=resolve(dirname(path),specifier);
   if(!existsSync(target))target=[target+'.ts',target+'.js',join(target,'index.ts'),join(target,'index.js')].find(existsSync)??target;
   queue.push(target);
  }
 }
 return [...new Set(gaps)].sort();
}
