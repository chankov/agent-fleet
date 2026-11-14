// The workspace owns configuration/resources; Pi's actual cwd is the selected checkout.
import {spawnSync} from 'node:child_process';
import {buildSessionLaunch} from './lib/session-launch.ts';
try{
 const launch=buildSessionLaunch(process.argv.slice(2));
 const result=spawnSync(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,stdio:'inherit'});
 if(result.error)throw result.error;
 process.exitCode=result.status??(result.signal==='SIGINT'?130:result.signal==='SIGTERM'?143:1);
}catch(error){console.error(`fleet: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}
