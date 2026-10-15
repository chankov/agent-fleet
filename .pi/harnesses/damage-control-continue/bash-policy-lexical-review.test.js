// Independent hook-level regressions: shell continuations and comment boundaries.
// No command below is executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ resolve(specifier, context, nextResolve) {
 if (specifier === '@mariozechner/pi-coding-agent') return {
  url: 'data:text/javascript,export const isToolCallEventType = (name, event) => event.toolName === name;', shortCircuit: true,
 };
 return nextResolve(specifier, context);
} });
const install = (await import('./index.ts')).default;
const rules = readFileSync(new URL('../../damage-control-rules.yaml', import.meta.url), 'utf8');

async function blocked(t, command) {
 const cwd = mkdtempSync(join(tmpdir(), 'fleet-dc-lexical-review-'));
 t.after(() => rmSync(cwd, { recursive: true, force: true }));
 mkdirSync(join(cwd, '.pi'));
 writeFileSync(join(cwd, '.pi', 'damage-control-rules.yaml'), rules);
 const handlers = {};
 install({ on(name, handler) { (handlers[name] ??= []).push(handler); }, registerCommand() {}, getFlag() {}, appendEntry() {} });
 const saved = ['AGENT_HUB_ASK_ENDPOINT', 'AGENT_HUB_EXEMPTIONS_FILE', 'AGENT_HUB_AGENT_ID'].map(name => [name, process.env[name]]);
 for (const [name] of saved) delete process.env[name];
 t.after(() => { for (const [name, value] of saved) value === undefined ? delete process.env[name] : process.env[name] = value; });
 const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };
 for (const handler of handlers.session_start ?? []) await handler({ type: 'session_start' }, ctx);
 for (const handler of handlers.tool_call ?? []) {
  const result = await handler({ type: 'tool_call', toolCallId: 'lexical-review', toolName: 'bash', input: { command } }, ctx);
  if (result?.block) return true;
 }
 return false;
}

for (const command of [
 "printf '%s\\n' '.env' |\nxargs cat",
 "printf '%s\\n' '.env' | # pipeline continuation\nxargs cat",
 "printf ''#literal; cat .env",
 "printf ''#literal; rm -- README.md",
 "echo ''#literal; printf x > package-lock.json",
 './tools/cat package-lock.json',
 './tools/printf .env',
 './tools/find package-lock.json',
 'cat "<<\'EOF\'"\nrm -- README.md\nEOF',
 'cat \'<<"EOF"\'\nprintf x > package-lock.json\nEOF',
]) test(`shell syntax must preserve protection: ${JSON.stringify(command)}`, async t => {
 assert.equal(await blocked(t, command), true, command);
});
