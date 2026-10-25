// Runner adapter for non-Pi peers. Fleet resources stay in af; the coding
// backend retains its own permissions and runs in the explicit checkout.
import {spawnSync} from 'node:child_process';
import {sessionRootsFromEnv,targetEnvironment} from '../../harnesses/lib/workspace-context.ts';
try{
 const [command,...args]=process.argv.slice(2);if(!command)throw Error('Missing backend command');
 const roots=sessionRootsFromEnv();
 const result=spawnSync(command,args,{cwd:roots?.executionRoot??process.cwd(),env:roots?targetEnvironment(roots):process.env,stdio:'inherit'});
 if(result.error)throw result.error;process.exitCode=result.status??1;
}catch(error){console.error(`fleet backend: ${error instanceof Error?error.message:String(error)}`);process.exitCode=1;}
