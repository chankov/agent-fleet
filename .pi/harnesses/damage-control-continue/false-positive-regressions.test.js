// Regression reproductions for the original long-running Fleet session.
// These invoke the real tool hook but never execute shell commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionTrace, projectExecutionTrace, registerExecutionTrace } from '../agent-hub/execution-trace.ts';

registerHooks({
 resolve(specifier, context, nextResolve) {
  if (specifier === '@mariozechner/pi-coding-agent') return {
   url: 'data:text/javascript,export const isToolCallEventType = (name, event) => event.toolName === name;',
   shortCircuit: true,
  };
  return nextResolve(specifier, context);
 },
});
const install = (await import('./index.ts')).default;
const shippedRules = readFileSync(new URL('../../damage-control-rules.yaml', import.meta.url), 'utf8');

async function guard(t, { interactive = false, trace = false } = {}) {
 const cwd = mkdtempSync(join(tmpdir(), 'fleet-dc-false-positive-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 mkdirSync(join(cwd, '.pi'));
 writeFileSync(join(cwd, '.pi', 'damage-control-rules.yaml'), shippedRules);
 const handlers = {}, entries = [], uiAsks = [];
 const listeners = new Map();
 const api = {
  events: {emit:(name,value)=>{for(const fn of listeners.get(name)??[])fn(value);},on:(name,fn)=>{const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn);}},
  on: (name, handler) => { (handlers[name] ??= []).push(handler); },
  registerCommand() {}, getFlag() { return undefined; },
  appendEntry: (type, data) => entries.push({ type, data }),
 };
 install(api);
 if(trace)registerExecutionTrace(api,createExecutionTrace({identity:()=>({taskId:'test',inputRevision:'test'}),persist:data=>entries.push({customType:'agent-hub-execution-trace',data})}));
 const ctx = { cwd, hasUI: interactive, ui: {
  setStatus() {}, notify() {}, confirm: async () => false,
  select: async (...args) => { uiAsks.push(args); return 'Keep blocked'; },
 } };
 // Session loading must not use real hub escalation or session exemptions.
 const saved = ['AGENT_HUB_ASK_ENDPOINT', 'AGENT_HUB_EXEMPTIONS_FILE', 'AGENT_HUB_AGENT_ID']
  .map(name => [name, process.env[name]]);
 for (const [name] of saved) delete process.env[name];
 t.after(() => { for (const [name, value] of saved) value === undefined ? delete process.env[name] : process.env[name] = value; });
 for (const handler of handlers.session_start ?? []) await handler({ type: 'session_start' }, ctx);
 return {
  entries, uiAsks,
  call: async command => {
   const event = { type: 'tool_call', toolCallId: 'reproduction', toolName: 'bash', input: { command } };
   for(const handler of handlers.tool_execution_start??[])await handler({toolCallId:event.toolCallId,toolName:'bash',args:event.input},ctx);
   for (const handler of handlers.tool_call ?? []) {
    const result = await handler(event, ctx);
    if (result?.block) {
     for(const handler of handlers.tool_execution_end??[])await handler({toolCallId:event.toolCallId,toolName:'bash',result:{details:{}},isError:true},ctx);
     return result;
    }
   }
   return { block: false };
  },
 };
}

test('trace records the actual baseline denial and human wait without retaining the protected input',async t=>{
 const g=await guard(t,{interactive:true,trace:true});
 assert.equal((await g.call("printf '%s' example > package-lock.json")).block,true);
 const view=projectExecutionTrace(g.entries),tool=view.spans.find(s=>s.kind==='tool');
 assert.equal(tool?.status,'blocked');assert.equal(tool?.executionMs,null);
 assert.ok(view.spans.some(s=>s.kind==='approval'&&s.status==='denied'&&s.parentSpanId===tool.spanId));
 assert.ok(view.spans.some(s=>s.kind==='queue'&&s.status==='completed'&&s.parentSpanId===tool.spanId),'baseline dialog queueing must not be charged as human response time');
 assert.ok(view.spans.some(s=>s.kind==='policy'&&s.reason==='read_only'));
 assert.doesNotMatch(JSON.stringify(view),/package-lock|printf|example|Keep blocked/);
});

test('trace labels conservative handling of unsupported expanding shell syntax',async t=>{
 const g=await guard(t,{trace:true});
 assert.equal((await g.call("printf '%s' \"$(cat .env)\"")).block,true);
 const policy=projectExecutionTrace(g.entries).spans.find(s=>s.kind==='policy');
 assert.equal(policy?.analysis,'conservative_text');assert.equal(policy?.reason,'zero_access');
});

test('read-only repository test execution does not confuse ./bin/ with system /bin/', async t => {
 const g = await guard(t);
 const result = await g.call('node --import ./bin/test/helpers/system1-no-network.js --test .pi/harnesses/lib/system1/config-damage-guard.test.js');
 assert.equal(result.block, false, result.reason);
});

test('find and ls inspect a dist path without requesting modification permission', async t => {
 const g = await guard(t);
 const result = await g.call("find .pi/harnesses -mindepth 1 -maxdepth 1 -type d; ls -l .pi/harnesses/node_modules/@mariozechner/pi-coding-agent/package.json .pi/harnesses/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/runner.js; find .pi/harnesses -path '*/node_modules' -prune -o -iname '*filesystem*' -print");
 assert.equal(result.block, false, result.reason);
});

test('reading a lockfile does not count as modifying a read-only file', async t => {
 const g = await guard(t);
 const result = await g.call('cat package-lock.json');
 assert.equal(result.block, false, result.reason);
});

test('literal quoted heredoc source may mention secret paths and destructive examples', async t => {
 const g = await guard(t);
 const result = await g.call("cat >> .pi/harnesses/example.test.ts <<'EOF'\nconst fixture = '.env';\nconst deletionExample = 'rm -rf README.md';\nEOF");
 assert.equal(result.block, false, result.reason);
});

test('printing a quoted deletion example does not attempt to delete the mentioned path', async t => {
 const g = await guard(t);
 const result = await g.call("printf '%s\\n' 'rm README.md'");
 assert.equal(result.block, false, result.reason);
});

test('relative repository bin file writes do not target the protected system bin directory', async t => {
 const g = await guard(t);
 const result = await g.call("printf '%s\\n' 'example' > ./bin/test/example.txt");
 assert.equal(result.block, false, result.reason);
});

test('ordinary test output redirection keeps repository paths distinct from system paths',async t=>{
 const g=await guard(t);
 assert.equal((await g.call('node --import ./bin/test/helpers/system1-no-network.js --test test.ts > /tmp/result.log 2>&1')).block,false);
});

for (const command of ['npm run build', 'cargo build --release', 'go build ./...', 'make DESTDIR=build install', 'python3 -m venv .venv']) {
 test(`an unknown program's subcommand is not a read-only output directory: ${command}`, async t => {
  const g = await guard(t);
  const result = await g.call(command);
  assert.equal(result.block, false, result.reason);
 });
}

for (const command of [
 'rm -- README.md',
 'mv README.md docs/renamed.md',
 'rm -rf scratch',
 "printf '%s' example > package-lock.json",
 "printf '%s' example > /bin/fleet-example",
 'sed -i s/a/b/ package-lock.json',
 "cat <<'EOF' > package-lock.json\n{}\nEOF",
 'ls dist/; rm -- README.md',
 'ls "$(rm -- README.md)"',
 "printf '%s' \"$(cat .env)\"",
 "cat <<EOF > scratch.txt\n$(rm -- README.md)\nEOF",
 'cat .env',
 'command rm -- README.md',
 'env EXAMPLE=1 rm -- README.md',
 "printf '%s' 'rm -rf README.md' | bash",
 "printf '%s' '.env' | xargs cat",
 "cat <<'EOF' > scratch.sh\nrm -- README.md\nEOF\nsh scratch.sh",
 'rm docs/*.md',
 'sed -i s/a/b/ package-lock.json another.txt',
 'rm build',
 'cp a.js build/a.js',
 'node tools/build.js --out=dist/app.js',
]) test(`real protected operation stays blocked: ${command.split('\n')[0]}`, async t => {
 const g = await guard(t);
 assert.equal((await g.call(command)).block, true);
});

test('an explicit denial of a protected write remains effective on a repeated request', async t => {
 const g = await guard(t, { interactive: true });
 const command = "printf '%s' example > package-lock.json";
 assert.equal((await g.call(command)).block, true);
 assert.equal((await g.call(command)).block, true);
 assert.equal(g.uiAsks.length, 1);
 assert.ok(g.entries.some(entry => entry.data.action === 'blocked_by_user'));
});
