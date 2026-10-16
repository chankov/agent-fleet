#!/usr/bin/env node
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetSessionClient } from './lib/fleet-codex-session.ts';
import { clientCatalog, parseClientArguments } from './lib/fleet-codex-catalog.ts';
import { FleetClientOperations } from './lib/fleet-codex-operations.ts';

function readInstructionFile(filePath: string): string {
 const resolved = path.resolve(filePath);
 const stats = fs.lstatSync(resolved);
 if (stats.isSymbolicLink() || !stats.isFile() || (process.getuid && stats.uid !== process.getuid()) || (stats.mode & 0o077)) {
  throw Error('unsafe text file');
 }
 if (stats.size > 16000) throw Error('text file must contain at most 16000 bytes');
 const flags = fs.constants.O_RDONLY | (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0);
 const fd = fs.openSync(resolved, flags);
 try {
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.size > 16000 || (process.getuid && opened.uid !== process.getuid()) || (opened.mode & 0o077)) {
   throw Error('unsafe text file');
  }
  return fs.readFileSync(fd, 'utf8');
 } finally { fs.closeSync(fd); }
}

export async function runClient(argv:string[],env:NodeJS.ProcessEnv=process.env,emit:(value:unknown)=>void=()=>{}) {
 if(argv.length===1&&argv[0]==='--help')return clientCatalog();
 const {command,flags}=parseClientArguments(argv);
 const client=new FleetSessionClient({stateDir:flags['state-dir']??path.join(env.CODEX_HOME||path.join(os.homedir(),'.codex'),'fleet-client'),clientId:env.CODEX_THREAD_ID});
 const operations=new FleetClientOperations(client);
 switch(command){
  case 'describe':return operations.describe();
  case 'sessions':return client.sessions(flags.project);
  case 'select':return client.select(flags.project,flags.peer);
  case 'status':return operations.status();
  case 'doctor': {
   const dependency=(binary:string)=>{const r=spawnSync(binary,['--version'],{encoding:'utf8',timeout:3000,maxBuffer:4096});return {available:r.status===0,version:r.status===0?r.stdout.trim():null};};
   return {node:process.version,python:dependency('python3'),herdr:dependency('herdr'),identityAvailable:!!env.CODEX_THREAD_ID,selection:env.CODEX_THREAD_ID?client.status():null,scope:'local client; no service lifecycle or model changes'};
  }
  case 'detach':return client.detach();
  case 'activity':case 'summary':return operations.resync(true);
  case 'resync':return operations.resync();
  case 'replay':return operations.replay();
  case 'receipts':return operations.receipts();
  case 'questions':return operations.questions(flags.after);
  case 'answer':return operations.answerQuestion(flags.id,flags.question,JSON.parse(readInstructionFile(flags['answer-file'])));
  case 'cancel-question':return operations.answerQuestion(flags.id,flags.question,null);
  case 'send':
   return operations.send(flags.id,readInstructionFile(flags['text-file']),Number(flags['wait-ms']??1000));
  case 'watch': {
   const seconds=Number(flags.seconds);if(!Number.isInteger(seconds)||seconds<1||seconds>60)throw Error('watch seconds must be 1–60');
   const end=Date.now()+seconds*1000;let count=0;
   do {
    // A source poll, not a model invocation. SIGINT ends only this local observer.
    const start=Date.now();emit({type:'progress',...(await operations.resync(false,0))});count++;
    const delay=Math.min(2000-(Date.now()-start),end-Date.now());if(delay>0)await new Promise(r=>setTimeout(r,delay));
   }while(Date.now()<end);
   return {type:'watch-ended',reason:'window elapsed; Pi continues independently',snapshots:count};
  }
 }
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const emit=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
 try {emit(await runClient(process.argv.slice(2),process.env,emit));}
 catch(error){emit({error:error instanceof Error?error.message:'client failure'});process.exitCode=1;}
}
