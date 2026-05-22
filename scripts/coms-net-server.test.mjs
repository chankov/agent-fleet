import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function waitForOutput(child, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) {
        cleanup();
        resolve({ match, output });
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Server exited before ${pattern} (code=${code}, signal=${signal}). Output:\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function startServer(env = {}) {
  const home = await mkdtemp(join(tmpdir(), 'coms-net-home-'));
  const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/coms-net-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PI_COMS_NET_HOST: '127.0.0.1',
      PI_COMS_NET_PORT: '0',
      PI_COMS_NET_LOG_QUIET: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  let output = '';
  const collect = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.once('exit', () => {
    exited = true;
  });
  const { match } = await waitForOutput(child, /listening on (http:\/\/127\.0\.0\.1:\d+)/);
  return {
    url: match[1],
    getOutput() {
      return output;
    },
    async stop() {
      if (!exited) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      child.stdout.off('data', collect);
      child.stderr.off('data', collect);
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function jsonFetch(url, path, token, options = {}) {
  return fetch(`${url}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

test('coms-net server starts under Node strip-types and responds to /health', async () => {
  const server = await startServer({ PI_COMS_NET_PROJECT: 'server-smoke-test' });
  try {
    const response = await fetch(`${server.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.server_id, 'string');
  } finally {
    await server.stop();
  }
});

async function registerAgent(server, token, project, agent) {
  const response = await jsonFetch(server.url, '/v1/agents/register', token, {
    method: 'POST',
    body: JSON.stringify({
      project,
      session_id: agent.session_id,
      name: agent.name,
      purpose: '',
      model: 'test-model',
      color: '#888888',
      cwd: process.cwd(),
      explicit: false,
    }),
  });
  assert.equal(response.status, 200);
}

test('message status endpoints only expose replies to the sender session', async () => {
  const token = 'test-token';
  const project = 'ownership-test';
  const server = await startServer({
    PI_COMS_NET_AUTH_TOKEN: token,
    PI_COMS_NET_PROJECT: project,
  });

  try {
    for (const agent of [
      { session_id: 'sender-session', name: 'sender' },
      { session_id: 'target-session', name: 'target' },
    ]) {
      await registerAgent(server, token, project, agent);
    }

    const sendResponse = await jsonFetch(server.url, '/v1/messages', token, {
      method: 'POST',
      body: JSON.stringify({
        project,
        sender_session: 'sender-session',
        target: 'target',
        target_session: null,
        prompt: 'hello target',
        conversation_id: null,
        response_schema: null,
        hops: 0,
      }),
    });
    assert.equal(sendResponse.status, 200);
    const sent = await sendResponse.json();

    const senderGet = await jsonFetch(
      server.url,
      `/v1/messages/${sent.msg_id}?project=${project}&requester_session=sender-session`,
      token,
      { method: 'GET', headers: { 'content-type': undefined } },
    );
    assert.equal(senderGet.status, 200);

    const targetGet = await jsonFetch(
      server.url,
      `/v1/messages/${sent.msg_id}?project=${project}&requester_session=target-session`,
      token,
      { method: 'GET', headers: { 'content-type': undefined } },
    );
    assert.equal(targetGet.status, 403);

    const targetAwait = await jsonFetch(
      server.url,
      `/v1/messages/${sent.msg_id}/await?project=${project}&requester_session=target-session&timeout_ms=1`,
      token,
      { method: 'GET', headers: { 'content-type': undefined } },
    );
    assert.equal(targetAwait.status, 403);
  } finally {
    await server.stop();
  }
});

test('message logs do not include prompt text by default', async () => {
  const token = 'test-token';
  const project = 'log-redaction-test';
  const server = await startServer({
    PI_COMS_NET_AUTH_TOKEN: token,
    PI_COMS_NET_PROJECT: project,
    PI_COMS_NET_LOG_QUIET: '0',
  });

  try {
    await registerAgent(server, token, project, { session_id: 'sender-session', name: 'sender' });
    await registerAgent(server, token, project, { session_id: 'target-session', name: 'target' });

    const secretPrompt = 'SECRET_TOKEN=abc123 should not appear in logs';
    const sendResponse = await jsonFetch(server.url, '/v1/messages', token, {
      method: 'POST',
      body: JSON.stringify({
        project,
        sender_session: 'sender-session',
        target: 'target',
        target_session: null,
        prompt: secretPrompt,
        conversation_id: null,
        response_schema: null,
        hops: 0,
      }),
    });
    assert.equal(sendResponse.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const output = server.getOutput();
    assert.match(output, /message/);
    assert.doesNotMatch(output, /SECRET_TOKEN=abc123/);
  } finally {
    await server.stop();
  }
});

test('oversized prompts are rejected before message storage', async () => {
  const token = 'test-token';
  const project = 'payload-limit-test';
  const server = await startServer({
    PI_COMS_NET_AUTH_TOKEN: token,
    PI_COMS_NET_PROJECT: project,
    PI_COMS_NET_MAX_PROMPT_CHARS: '32',
  });

  try {
    await registerAgent(server, token, project, { session_id: 'sender-session', name: 'sender' });
    await registerAgent(server, token, project, { session_id: 'target-session', name: 'target' });

    const response = await jsonFetch(server.url, '/v1/messages', token, {
      method: 'POST',
      body: JSON.stringify({
        project,
        sender_session: 'sender-session',
        target: 'target',
        target_session: null,
        prompt: 'x'.repeat(33),
        conversation_id: null,
        response_schema: null,
        hops: 0,
      }),
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error, 'prompt_too_large');
  } finally {
    await server.stop();
  }
});
