// Independent safety review of static shell operand classification.
// Commands are analyzed through the real hook; no shell command is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const rules = readFileSync(new URL('../../damage-control-rules.yaml', import.meta.url), 'utf8');

async function blocked(t, command) {
 const cwd = mkdtempSync(join(tmpdir(), 'fleet-dc-safety-review-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 mkdirSync(join(cwd, '.pi'));
 writeFileSync(join(cwd, '.pi', 'damage-control-rules.yaml'), rules);
 const handlers = {};
 install({
  on(name, handler) { (handlers[name] ??= []).push(handler); },
  registerCommand() {}, getFlag() { return undefined; }, appendEntry() {},
 });
 const saved = ['AGENT_HUB_ASK_ENDPOINT', 'AGENT_HUB_EXEMPTIONS_FILE', 'AGENT_HUB_AGENT_ID']
  .map(name => [name, process.env[name]]);
 for (const [name] of saved) delete process.env[name];
 t.after(() => { for (const [name, value] of saved) value === undefined ? delete process.env[name] : process.env[name] = value; });
 const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };
 for (const handler of handlers.session_start ?? []) await handler({ type: 'session_start' }, ctx);
 for (const handler of handlers.tool_call ?? []) {
  const result = await handler({ type: 'tool_call', toolCallId: 'review-reproduction', toolName: 'bash', input: { command } }, ctx);
  if (result?.block) return true;
 }
 return false;
}

for (const command of [
 "sed -n 'w package-lock.json' source.txt",
 "sed -n '1w package-lock.json' source.txt",
 "sed -n 'e rm -- README.md' source.txt",
 "printf '%s\\n' 'rm -- README.md' | sed e",
 'grep -f.env source.txt',
 'rg -f.env source.txt',
 'sed -f.env source.txt',
 'file -m.env source.txt',
 'cat -- -.env',
 'file --compile --magic-file=package-lock.json',
 'file -Cm package-lock.json',
 'cp -t/etc/ source.txt',
 'install -t/etc/ source.txt',
 'mv -t/etc/ source.txt',
]) test(`static classification must preserve the prior protection: ${command}`, async t => {
 assert.equal(await blocked(t, command), true, command);
});
