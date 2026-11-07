import { spawn } from "node:child_process";

/**
 * Start an MCP STDIO server exactly as Codex would and exchange the two
 * requests that prove the launcher works: `initialize` (protocol 2025-06-18)
 * and `tools/list`. No tool is called, so a Fleet server creates no policy
 * state. The child is always terminated before this resolves or rejects.
 */
export const PROBE_PROTOCOL = "2025-06-18";
const STDERR_LIMIT = 4096;
const TERMINATE_GRACE_MS = 2000;

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const kill = setTimeout(() => child.kill("SIGKILL"), TERMINATE_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
  });
}

export async function probeMcpServer({ command, args, expectedName, timeoutMs = 10000, cwd, env, clientVersion = "0" }) {
  const started = Date.now();
  let child;
  try {
    child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env });
  } catch (error) {
    throw new Error(`failed to start ${command}: ${error.message}`);
  }
  let stderr = "";
  let buffered = "";
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-STDERR_LIMIT);
  });
  child.stdin.on("error", () => {
    // A server that exits before reading makes stdin writes fail; the exit
    // path below reports that with the captured stderr.
  });
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");

  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ error: `probe timed out after ${timeoutMs} ms without a complete initialize/tools-list exchange` }), timeoutMs);
    const done = result => {
      clearTimeout(timer);
      resolve(result);
    };
    let serverInfo = null;
    let protocolVersion = null;
    child.on("error", error => done({ error: `failed to start ${command}: ${error.message}` }));
    child.on("close", (code, signal) => done({ error: `server exited before replying (code ${code}, signal ${signal})` }));
    child.stdout.on("data", chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message || typeof message !== "object") continue;
        if (message.id === 1) {
          if (message.error) return done({ error: `initialize failed: ${message.error.message ?? JSON.stringify(message.error)}` });
          serverInfo = message.result?.serverInfo ?? null;
          protocolVersion = message.result?.protocolVersion ?? null;
          if (!serverInfo || serverInfo.name !== expectedName) {
            return done({ error: `server identified itself as ${JSON.stringify(serverInfo?.name ?? null)} (serverInfo.name), expected ${JSON.stringify(expectedName)}` });
          }
          if (typeof protocolVersion !== "string") return done({ error: "initialize reply has no protocolVersion" });
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          if (message.error) return done({ error: `tools/list failed: ${message.error.message ?? JSON.stringify(message.error)}` });
          const tools = Array.isArray(message.result?.tools) ? message.result.tools : null;
          if (!tools) return done({ error: "tools/list reply has no tools array" });
          const toolNames = tools.map(tool => tool?.name).filter(name => typeof name === "string");
          if (toolNames.length === 0) return done({ error: `${expectedName} advertises no tools` });
          return done({ value: { serverInfo, protocolVersion, toolCount: toolNames.length, toolNames } });
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROBE_PROTOCOL, capabilities: {}, clientInfo: { name: "agent-fleet set-codex-mcp", version: clientVersion } },
    });
  });

  child.stdin.end();
  child.kill("SIGTERM");
  await waitForExit(child);

  if (outcome.error) {
    const detail = stderr.trim();
    throw new Error(`${expectedName} probe failed: ${outcome.error}${detail ? `\nstderr: ${detail}` : ""}`);
  }
  return { ...outcome.value, durationMs: Date.now() - started };
}
