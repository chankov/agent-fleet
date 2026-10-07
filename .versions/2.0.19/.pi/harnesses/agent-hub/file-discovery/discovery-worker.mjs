// Actual pinned Pi find/ls, isolated from the parent environment. No custom traversal or installer.
import {readFileSync} from 'node:fs';
const entry=import.meta.resolve('@earendil-works/pi-coding-agent');
const pkg=JSON.parse(readFileSync(new URL('../package.json',entry),'utf8'));
if(pkg.version!=='0.84.2')throw Error('unsupported_pi_version');
const {createFindToolDefinition}=await import(new URL('./core/tools/find.js',entry));
const {createLsToolDefinition}=await import(new URL('./core/tools/ls.js',entry));
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>32768)throw Error('request_too_large');}
const {cwd,requests}=JSON.parse(input),controller=new AbortController();
process.on('SIGTERM',()=>controller.abort());
for(const args of requests){
 try {const tool=args.tool==='ls'?createLsToolDefinition(cwd):createFindToolDefinition(cwd);const result=await tool.execute('d9-discovery',args,controller.signal);process.stdout.write(JSON.stringify({args,ok:true,result})+'\n');}
 catch(error){process.stdout.write(JSON.stringify({args,ok:false,reason:controller.signal.aborted?'cancelled':String(error.message).includes('fd is not available')?'missing_executable':'unavailable'})+'\n');break;}
 if(controller.signal.aborted)break;
}
