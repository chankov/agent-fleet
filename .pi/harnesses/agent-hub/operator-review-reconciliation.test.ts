import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Agent, runToolCall } from '@earendil-works/pi-agent-core';
import { AgentSession, SessionManager, SettingsManager, createBashToolDefinition } from '@earendil-works/pi-coding-agent';

const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
const { createExtensionRuntime, loadExtensionFromFactory } = await import(new URL('./core/extensions/loader.js', sdk).href);
const { createEventBus } = await import(new URL('./core/event-bus.js', sdk).href);

// Negative feasibility probe, not proof of A8: do not run a replacement shell
// or exercise provider, Hub IPC, permission dialogs, or the live workspace.
for (const registerReplacement of [false, true]) {
 test(`real Pi guarded tool dispatch keeps builtin bash ownership only without re-registration (replacement=${registerReplacement})`, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'fleet-operator-shell-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = createExtensionRuntime();
  const calls: unknown[] = [];
  let replacementRan = false;
  const extension = await loadExtensionFromFactory((pi: any) => {
   pi.on('tool_call', (event: any, ctx: any) => {
    if (event.toolName !== 'bash') return;
    calls.push({ id: event.toolCallId, input: event.input, cwd: ctx.cwd });
    return { block: true, reason: 'operator shell feasibility probe: no execution' };
   });
   if (registerReplacement) {
    pi.registerTool({ ...createBashToolDefinition(cwd), execute: async () => {
     replacementRan = true;
     throw new Error('replacement must not run');
    } });
   }
  }, cwd, createEventBus(), runtime, 'operator-shell-probe');
  assert.ok(extension);
  const noProvider = () => { throw new Error('provider must not run'); };
  const modelRuntime: any = {
   getModels: () => [], getAvailableSnapshot: () => [], getModel: () => undefined, getError: () => undefined,
   getAuth: noProvider, stream: noProvider, resolveModel: noProvider,
  };
  const empty = () => ({ diagnostics: [] });
  const resourceLoader: any = {
   getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
   getSkills: () => ({ ...empty(), skills: [] }), getPrompts: () => ({ ...empty(), prompts: [] }),
   getThemes: () => ({ ...empty(), themes: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
   getSystemPrompt: () => 'Offline operator-shell diagnostic', getAppendSystemPrompt: () => [],
  };
  const call = { type: 'toolCall' as const, id: 'operator-shell-probe-1', name: 'bash', arguments: { command: 'node --version' } };
  const assistant: any = { role: 'assistant', content: [call] };
  const agent = new Agent({ streamFn: noProvider });
  const session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(), cwd, resourceLoader, modelRuntime, initialActiveToolNames: ['bash'] } as any);
  t.after(() => session.dispose());
  await session.bindExtensions({ onError: error => { throw Error(JSON.stringify(error)); } });
  const bash = session.getAllTools().find(tool => tool.name === 'bash');
  assert.ok(bash);
  assert.equal(bash.sourceInfo.source === 'builtin', !registerReplacement);
  const outcome = await runToolCall(call, { tools: agent.state.tools, assistantMessage: assistant, context: { messages: [assistant], tools: agent.state.tools }, beforeToolCall: agent.beforeToolCall, afterToolCall: agent.afterToolCall });
  assert.deepEqual(calls, [{ id: call.id, input: call.arguments, cwd }]);
  assert.match(JSON.stringify(outcome), /operator shell feasibility probe: no execution/);
  assert.equal(replacementRan, false);
 });
}
