// Test-only SDK selection. Never infer a global installation from process.execPath.
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';

export function inspectPiRuntime(root,source='explicit') {
 const canonical=realpathSync(root),metadata=JSON.parse(readFileSync(join(canonical,'package.json'),'utf8'));
 if(!['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent'].includes(metadata.name)||typeof metadata.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(metadata.version))throw Error(`Invalid Pi SDK metadata: ${canonical}`);
 const cli=join(canonical,'dist/bundle/cli.js');if(!existsSync(cli))throw Error(`Pi bundled CLI missing: ${cli}`);
 return {root:canonical,cli,version:metadata.version,name:metadata.name,source};
}
export function resolvePiTestRuntime({root,env=process.env}={}) {
 if(env.CONTEXT_CONTINUITY_PI_RUNTIME)return inspectPiRuntime(resolve(env.CONTEXT_CONTINUITY_PI_RUNTIME),'explicit');
 if(root){
  for(const name of ['@earendil-works/pi-coding-agent','@mariozechner/pi-coding-agent']){
   // Read the exact repository dependency (including managed package symlinks),
   // not an ancestor/global package or an unexported CommonJS condition.
   for(const modules of [join(resolve(root),'node_modules')]){const candidate=join(modules,name);if(existsSync(join(candidate,'package.json'))){
    const runtime=inspectPiRuntime(candidate,'repository_dependency');
    const declared=JSON.parse(readFileSync(join(resolve(root),'package.json'),'utf8')).devDependencies?.[name];
    if(typeof declared==='string'&&/^\d+\.\d+\.\d+$/.test(declared)&&runtime.version!==declared)throw Error(`Repository Pi SDK mismatch: declared ${declared}, installed ${runtime.version}`);
    return runtime;
   }}
  }
 }
 const managed=env.PI_MANAGED_INSTALL_ROOT??join(env.HOME??homedir(),'.pi/agent/install'),current=join(managed,'current-version');
 if(existsSync(current)){
  const version=readFileSync(current,'utf8').trim();if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)||version==='..')throw Error('Invalid managed Pi version');
  return inspectPiRuntime(join(managed,'releases',version,'node_modules/@earendil-works/pi-coding-agent'),'managed_install');
 }
 throw Error('Pi test SDK unavailable: install the repository devDependencies or set CONTEXT_CONTINUITY_PI_RUNTIME explicitly');
}
