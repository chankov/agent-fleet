import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync,statSync} from 'node:fs';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {physicalTempRoot} from '../../../bin/test/helpers/test-temp.js';
import {join} from 'node:path';
import type {ExtensionAPI,ExtensionContext} from '@mariozechner/pi-coding-agent';
import {createCodexBootstrapControls} from '../../harnesses/agent-hub/codex-bootstrap.ts';
import {DesktopPreflightRegistry} from './lib/codex-desktop-preflight.ts';

const namespace={hostProfile:'desktop',principal:'synthetic-only',threadId:'11111111-1111-4111-8111-111111111111'};
const observation={namespace,hostInstance:'22222222-2222-4222-8222-222222222222',protocolVersion:'2025-06-18',clientInfo:{name:'synthetic',version:'not-desktop-version'},catalog:['synthetic_only']};
const owner={project:'af-test',peer:'synthetic',sessionId:'33333333-3333-4333-8333-333333333333',startedAt:'2026-11-12T00:00:00.000Z'};

/** Production UI action and mapping writer; only the attach boundary, UI and
 * /proc tree are synthetic. No live Fleet/Codex/socket or user files are used. */
function fixture(t:any,options:{onConfirm?:()=>unknown;inputs?:string[];confirmed?:boolean}={}){
 const root=mkdtempSync(join(physicalTempRoot(),'af-ui-preflight-')),procRoot=join(root,'proc'),processDir=join(procRoot,'123'),mappingRoot=join(root,'mappings'),executable=join(root,'SYNTHETIC-NEVER-EXECUTED');
 mkdirSync(processDir,{recursive:true,mode:0o700});writeFileSync(executable,'SYNTHETIC-BINARY',{mode:0o700});symlinkSync(executable,join(processDir,'exe'));
 const processStat=(ticks='55555')=>'123 (synthetic) '+['S',...Array(18).fill('0'),ticks].join(' ')+'\n';writeFileSync(join(processDir,'stat'),processStat(),{mode:0o600});
 const notices:{text:string;type:string}[]=[],inputs=options.inputs??['123','26.1106.51428',join(root,'daemon.sock'),join(root,'home'),''];let confirmations=0,captures=0,forbidden=0;
 const ctx={hasUI:true,ui:{input:async()=>inputs.shift(),notify:(text:string,type:string)=>notices.push({text,type}),confirm:async()=>{confirmations++;options.onConfirm?.();return options.confirmed!==false;}}} as unknown as ExtensionContext;
 const pi={registerCommand(){},on(){}} as unknown as ExtensionAPI;
 const previousPolicy=process.env.AF_CODEX_POLICY_ROOT;let controls:ReturnType<typeof createCodexBootstrapControls>;
 try{process.env.AF_CODEX_POLICY_ROOT=join(root,'policy');controls=createCodexBootstrapControls(pi,{owner:()=>owner,context:()=>ctx,changed(){}});}
 finally{if(previousPolicy===undefined)delete process.env.AF_CODEX_POLICY_ROOT;else process.env.AF_CODEX_POLICY_ROOT=previousPolicy;}
 const registry=new DesktopPreflightRegistry({root:mappingRoot,procRoot,confirm:async()=>ctx.ui.confirm('Synthetic mapping','Synthetic facts')});
 t.mock.method(controls.backend,'capturePreflight',async(_c:unknown,parameters:Parameters<DesktopPreflightRegistry['capture']>[1])=>{captures++;return registry.capture(observation,parameters,new AbortController().signal);});
 for(const [object,key]of [[controls.backend,'enable'],[controls.backend,'disable'],[controls.backend.coordinator,'prepare'],[controls.backend.coordinator,'commit']] as const)t.mock.method(object,key,async()=>{forbidden++;throw Error('forbidden live effect');});
 t.after(()=>{controls.backend.stop();controls.control.stop();rmSync(root,{recursive:true,force:true});});
 return {root,mappingRoot,processDir,processStat,notices,controls,ctx,run:()=>controls.action('preflight',namespace,ctx),get confirmations(){return confirmations;},get captures(){return captures;},get forbidden(){return forbidden;}};
}
function errorNotice(f:ReturnType<typeof fixture>,code:string){
 assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'error');assert.ok(f.notices[0].text.includes('Desktop preflight: '+code+'.'),f.notices[0].text);
 assert.match(f.notices[0].text,/не повтаряй сляпо/);assert.doesNotMatch(f.notices[0].text,/private-secret|SENSITIVE|Error:|\n\s+at /);assert.equal(f.forbidden,0);
}

test('UI exposes post-confirmation identity change without retry or a false mapping success',async t=>{
 let f:ReturnType<typeof fixture>;f=fixture(t,{onConfirm:()=>writeFileSync(join(f.processDir,'stat'),f.processStat('99999'))});
 await f.run();errorNotice(f,'desktop_preflight_changed');assert.equal(f.confirmations,1);assert.equal(f.captures,1);assert.equal(readdirSync(f.root).includes('mappings'),false);
});

test('UI exposes safe OS error code after confirmation without its path or message',async t=>{
 const f=fixture(t),open=promises.open;
 t.mock.method(promises,'open',async(...args:Parameters<typeof open>)=>{if(String(args[0]).startsWith(f.mappingRoot+'/mapping-')&&String(args[0]).includes('.tmp-'))throw Object.assign(Error('EACCES /private-secret/SENSITIVE'),{code:'EACCES'});return open(...args);});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await f.run();errorNotice(f,'preflight_io_EACCES');assert.equal(f.confirmations,1);assert.equal(f.captures,1);assert.deepEqual(readdirSync(f.mappingRoot),[]);
});

test('UI preserves publication uncertainty after rename and does not repeat capture',async t=>{
 const f=fixture(t),open=promises.open;
 t.mock.method(promises,'open',async(...args:Parameters<typeof open>)=>{const file=await open(...args);if(args[0]===f.mappingRoot)file.sync=async()=>{throw Error('private-secret directory fsync failed');};return file;});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 await f.run();errorNotice(f,'bootstrap_file_publication_unknown');assert.equal(f.confirmations,1);assert.equal(f.captures,1);
 const files=readdirSync(f.mappingRoot);assert.equal(files.length,1);assert.equal(JSON.parse(readFileSync(join(f.mappingRoot,files[0]),'utf8')).desktop.pid,123);assert.equal(statSync(join(f.mappingRoot,files[0])).mode&0o777,0o600);
 assert.doesNotMatch(f.notices[0].text,/не е записан|няма промени/i);
});

test('UI never reflects unknown exception messages, code suffixes or thrown values',async t=>{
 for(const error of [Error('private-secret SENSITIVE'),Error('desktop_preflight_changed SENSITIVE'),Object.assign(Error('private-secret'),{code:'EACCES SENSITIVE'}),'private-secret SENSITIVE',{message:'desktop_preflight_changed',code:'EACCES'}]){
  const f=fixture(t,{onConfirm:()=>{throw error;}});await f.run();errorNotice(f,'preflight_failed');assert.equal(f.confirmations,1);assert.equal(f.captures,1);assert.equal(readdirSync(f.root).includes('mappings'),false);
 }
});

test('PID/version whitespace still fails before confirmation with a safe input code',async t=>{
 const pid=fixture(t,{inputs:[' 123 ']});await pid.run();errorNotice(pid,'desktop_pid_invalid');assert.equal(pid.captures,0);assert.equal(pid.confirmations,0);
 const version=fixture(t,{inputs:['123','26.1106.51428 ','/tmp/synthetic.sock','/tmp/synthetic-home','']});await version.run();errorNotice(version,'desktop_preflight_inputs');assert.equal(version.captures,1);assert.equal(version.confirmations,0);
});

test('native decline has a distinct preflight code and creates no mapping',async t=>{
 const f=fixture(t,{confirmed:false});await f.run();errorNotice(f,'desktop_preflight_not_confirmed');assert.equal(f.confirmations,1);assert.equal(f.captures,1);assert.equal(readdirSync(f.root).includes('mappings'),false);
});

test('successful synthetic mapping retains the existing success message and one publication',async t=>{
 const f=fixture(t);await f.run();assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'info');assert.match(f.notices[0].text,/Desktop mapping policy е записана/);assert.equal(f.confirmations,1);assert.equal(f.captures,1);assert.equal(f.forbidden,0);assert.equal(readdirSync(f.mappingRoot).length,1);
});

test('other actions retain generic errors and do not expose preflight exception details',async t=>{
 const f=fixture(t);await f.controls.action('disable',namespace,f.ctx);assert.equal(f.notices.length,1);assert.equal(f.notices[0].type,'error');assert.match(f.notices[0].text,/Операцията е отказана/);assert.doesNotMatch(f.notices[0].text,/Desktop preflight:|forbidden live effect/);assert.equal(f.forbidden,1);assert.equal(f.captures,0);
});
