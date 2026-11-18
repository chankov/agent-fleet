// Hook-level policy tests: no shell commands are executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ resolve(specifier, context, nextResolve) {
 if(specifier==='@mariozechner/pi-coding-agent')return {url:'data:text/javascript,export const isToolCallEventType = (name, event) => event.toolName === name;',shortCircuit:true};
 return nextResolve(specifier,context);
} });
const install=(await import('./index.ts')).default;
const rules=readFileSync(new URL('../../damage-control-rules.yaml',import.meta.url),'utf8');
async function blocked(t:any,command:string){
 const cwd=mkdtempSync(join(tmpdir(),'fleet-heredoc-policy-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 mkdirSync(join(cwd,'.pi'));writeFileSync(join(cwd,'.pi','damage-control-rules.yaml'),rules);
 const handlers:Record<string,any[]>={};
 install({on(name:string,handler:any){(handlers[name]??=[]).push(handler);},registerCommand(){},getFlag(){},appendEntry(){}} as any);
 const saved=['AGENT_HUB_ASK_ENDPOINT','AGENT_HUB_EXEMPTIONS_FILE','AGENT_HUB_AGENT_ID'].map(name=>[name,process.env[name]]);
 for(const [name] of saved)delete process.env[name!];
 t.after(()=>{for(const [name,value] of saved)value===undefined?delete process.env[name!]:process.env[name!]=value;});
 const ctx={cwd,hasUI:false,ui:{notify(){},setStatus(){}}};
 for(const handler of handlers.session_start??[])await handler({type:'session_start'},ctx);
 for(const handler of handlers.tool_call??[]){const result=await handler({type:'tool_call',toolCallId:'heredoc-policy',toolName:'bash',input:{command}},ctx);if(result?.block)return true;}
 return false;
}

test('literal cat append body stays data when sed/rg trigger conservative fallback',async t=>{
 const command="cat >> test.ts <<'EOF'\nassert.equal(launches[0].env.VALUE, 1);\nrm -rf /\nEOF\nsed -n '1,20p' README.md; rg -n 'update|install' settings.json";
 assert.equal(await blocked(t,command),false);
});
test('literal tee body with unknown following command stays data',async t=>{
 assert.equal(await blocked(t,"tee test.ts <<'EOF'\n.env is only documentation here\nEOF\nsed -n '1p' README.md"),false);
});
for(const command of [
 "cat >> .env <<'EOF'\nhello\nEOF\nsed -n '1p' README.md",
 "cat > test.ts <<'EOF'\nhello\nEOF\ncat .env",
 "cat > test.ts <<'EOF'\nhello\nEOF\nrm -rf /",
 "cat > test.ts <<EOF\n$(cat .env)\nEOF",
 "sh <<'EOF'\ncat .env\nEOF",
 "cat <<'EOF' | sh\ncat .env\nEOF",
 "cat > test.ts <<'EOF'\nliteral\nEOF\nprintf x > package-lock.json",
 "cat > test.ts <<'EOF'\nliteral\nEOF\nrm README.md",
 ...['sh scratch.sh', 'FOO=1 sh scratch.sh', 'command sh scratch.sh', 'env sh scratch.sh', './scratch.sh', 'busybox sh scratch.sh', "sed -n 1p -e 'e sh scratch.sh' README.md", "sed -n 1p > /dev/null -e 'e sh scratch.sh' README.md", "sed -n 1p < README.md -e 'e sh scratch.sh'"].map(run => `cat <<'EOF' > scratch.sh\nrm -- README.md\nEOF\n${run}`),
])test(`real protected operations remain blocked: ${JSON.stringify(command)}`,async t=>{
 assert.equal(await blocked(t,command),true);
});

test('node script options ending in e do not become inline interpreter source',async t=>{
 assert.equal(await blocked(t,'node node_modules/typescript/bin/tsc --noEmit --module nodenext --strict src/example.ts'),false);
});
for (const command of ['node --eval "require(\'fs\').writeFileSync(\'/bin/x\', \'x\')"', 'node -e "require(\'fs\').writeFileSync(\'/bin/x\', \'x\')"', 'node script.js --output /bin/x']) test(`node protected writes remain blocked: ${command}`,async t=>{
 assert.equal(await blocked(t,command),true);
});

for (const command of [
 '/opt/az/bin/python3 -I -B -m unittest discover -s privatale/ptapi/tests/sync -p test_cosmos_probe_workflow.py',
 '/usr/bin/python3 -m unittest discover -s tests',
 // Any program named by path: its own directory is read/executed, never written.
 '/opt/az/bin/python3 script.py',
 '/opt/az/bin/python3 -I -B tests/sync/probe.py --dry-run',
 '.venv/bin/python -m pytest tests',
 '/home/example/.local/bin/uv run pytest',
 '/usr/bin/git status',
 '/usr/local/bin/node --version',
 '/home/example/Android/Sdk/platform-tools/adb devices -l',
 // Inline source keeps conservative text checks, which must respect path boundaries.
 '/opt/az/bin/python3 -I -B -c "import json; print(1)"',
]) test(`absolute interpreter execution is not a write to its executable directory: ${command}`, async t => {
 assert.equal(await blocked(t, command), false);
});
for (const command of [
 '/opt/az/bin/python3 -m unittest --output=/bin/example',
 '/opt/az/bin/python3 -m unittest > /bin/example',
 '/opt/az/bin/python3 -m unittest /etc/example',
 '/opt/az/bin/python3.14 -m unittest /etc/example',
 '/opt/az/bin/python3 -m unittest package-lock.json',
 '/opt/az/bin/python3 script.py --output /bin/example',
 '/opt/az/bin/python3 script.py > /bin/example',
 '/opt/az/bin/python3 -c "open(\'/bin/example\', \'w\')"',
 '/opt/az/bin/python3 -m unittest .env',
 '/opt/az/bin/python3 -m unittest; rm -- README.md',
 '/tmp/cat package-lock.json',
 '/tmp/printf .env',
 '/tmp/tool --output=/etc/example',
 '/opt/az/bin/tool --output /bin/example',
 '.venv/bin/python script.py > /etc/example',
 '/usr/bin/git -C /etc status',
 '/bin/rm -- README.md',
 '/usr/bin/env rm -- README.md',
 '/bin/bash -c "rm -- README.md"',
 '/bin/sh scratch.sh',
 '/usr/bin/sed -i s/a/b/ /etc/example',
 '/opt/az/bin/python3 -c "open(\'/usr/example\', \'w\')"',
 '.venv/bin/python -c "open(\'/bin/example\', \'w\')"',
]) test(`absolute executables retain protected operand and source checks: ${command}`, async t => {
 assert.equal(await blocked(t, command), true);
});
