import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import registerDelegate from '../.pi/harnesses/agent-hub/delegate.ts';

function createFakePi(tmp) {
  const path = join(tmp, 'pi');
  writeFileSync(path, `#!/usr/bin/env node
const mode = process.env.FAKE_PI_MODE;
const event = e => process.stdout.write(JSON.stringify(e) + '\\n');
if (mode === 'hang') {
  event({ type: 'tool_execution_start', toolCallId: 'nested-read', toolName: 'read', args: { path: '/disk/nested' } });
  setInterval(() => {}, 1000);
} else if (mode === 'finish') {
  event({ type: 'tool_execution_start', toolCallId: 'nested-read', toolName: 'read', args: { path: '/disk/nested' } });
  setTimeout(() => { event({ type: 'tool_execution_end', toolCallId: 'nested-read', toolName: 'read' }); event({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'finished' } }); }, 60);
} else if (mode === 'cancel') {
  event({ type: 'tool_execution_start', toolCallId: 'nested-read', toolName: 'read', args: { path: '/disk/nested' } });
  setInterval(() => {}, 1000);
}
`);
  chmodSync(path, 0o755);
}

function delegateTool(tmp, timeoutMs, extraConfig = {}) {
  let tool;
  process.env.AGENT_HUB_DELEGATE_CONFIG = JSON.stringify({
    persona: 'builder', tag: 'root', roles: { recon: { model: 'fake/model' } },
    depth: 1, callBudget: 4, remainingSpawns: 4, parentTools: 'read,grep,find,ls',
    personaPrompt: '', eventDir: join(tmp, 'events'), delegateExt: join(tmp, 'delegate.ts'),
    reconSearchTimeoutMs: timeoutMs, cwd: tmp, ...extraConfig,
  });
  registerDelegate({ registerTool(def) { tool = def; } });
  assert.ok(tool, 'delegate extension must register its runtime tool');
  return tool;
}

async function withEnv(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await fn(); }
  finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('nested delegate runtime returns tool_timeout metadata and leaves running lifecycle', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-delegate-timeout-'));
  try {
    createFakePi(tmp);
    await withEnv({ PATH: `${tmp}:${process.env.PATH ?? ''}`, FAKE_PI_MODE: 'hang' }, async () => {
      const tool = delegateTool(tmp, 20);
      const result = await tool.execute('call-1', { role: 'recon', instruction: 'search' }, undefined, () => {});
      assert.equal(result.details.status, 'tool_timeout');
      assert.equal(result.details.termination.reason, 'tool_timeout');
      assert.equal(result.details.termination.tool.toolCallId, 'nested-read');
      assert.match(result.content[0].text, /tool_timeout/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('nested delegate preserves off/null instead of restoring the watchdog default', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-delegate-off-'));
  try {
    createFakePi(tmp);
    await withEnv({ PATH: `${tmp}:${process.env.PATH ?? ''}`, FAKE_PI_MODE: 'finish' }, async () => {
      const tool = delegateTool(tmp, null);
      const result = await tool.execute('call-2', { role: 'recon', instruction: 'search' }, undefined, () => {});
      assert.equal(result.details.status, 'done');
      assert.equal(result.details.termination, undefined);
      assert.match(result.content[0].text, /done/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('nested delegate propagates caller cancellation distinctly from tool_timeout', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-delegate-cancel-'));
  try {
    createFakePi(tmp);
    await withEnv({ PATH: `${tmp}:${process.env.PATH ?? ''}`, FAKE_PI_MODE: 'cancel' }, async () => {
      const tool = delegateTool(tmp, 1_000);
      const controller = new AbortController();
      const pending = tool.execute('call-3', { role: 'recon', instruction: 'search' }, controller.signal, () => {});
      setTimeout(() => controller.abort(), 30);
      const result = await pending;
      assert.equal(result.details.status, 'cancelled');
      assert.equal(result.details.termination.reason, 'cancelled');
      assert.match(result.content[0].text, /cancelled/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('nested delegate enforces the whole-run deadline even when the tool watchdog is off', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'agent-hub-delegate-turn-'));
  try {
    createFakePi(tmp);
    await withEnv({ PATH: `${tmp}:${process.env.PATH ?? ''}`, FAKE_PI_MODE: 'hang' }, async () => {
      const tool = delegateTool(tmp, null, { turnDeadlineMs: 400 });
      const result = await tool.execute('call-turn', { role: 'recon', instruction: 'search' }, undefined, () => {});
      assert.equal(result.details.status, 'turn_timeout');
      assert.equal(result.details.termination.reason, 'turn_timeout');
      assert.match(result.content[0].text, /turn_timeout/);
    });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
