import { randomUUID } from "node:crypto";
import { PRIVATE_CONFIG_ENV, privateConfigRevision, type PrivateConfigBinding } from './private-config-current-state.ts';
import { worktreeRevision } from "./scope-gate.js";

/** Set by the native dispatcher, never inferred from a command's shell cwd. */
export const RUNTIME_TEST_SCOPE_ENV = "AGENT_FLEET_RUNTIME_TEST_SCOPES";

export function runtimeTestRevision(cwd: string, rawScopes: string | undefined, rawPrivateConfig?: string): () => string {
 let scopes: string[];
 try {
  const parsed = rawScopes === undefined ? [] : JSON.parse(rawScopes);
  if (!Array.isArray(parsed) || parsed.some(scope => typeof scope !== "string" || !scope.trim())) throw new Error("Invalid runtime scope");
  scopes = [...parsed];
 } catch { return () => "unavailable"; }
 // Empty filtering scopes preserve whole-repository single-repo semantics.
 if (rawPrivateConfig !== undefined && rawPrivateConfig !== '') {
  let binding: PrivateConfigBinding;
  try { binding = JSON.parse(rawPrivateConfig); } catch { return () => 'unavailable'; }
  return () => privateConfigRevision(cwd, worktreeRevision(cwd, [], scopes), binding);
 }
 return () => worktreeRevision(cwd, [], scopes);
}

export interface RuntimeTestRecord {
 producer: "agent-fleet.runtime-test/v1";
 command: string;
 exitCode: number | null;
 notRunReason?: "missing_cli";
 beforeRevision: string;
 afterRevision: string;
 exclusive?: boolean;
 startedAt?: number;
 finishedAt?: number;
}

export const RUNTIME_TEST_COMMANDS_ENV = "AGENT_FLEET_RUNTIME_TEST_COMMANDS";

// Match the whole invocation: no substitutions, redirects, pipelines or arbitrary setup.
const simpleCheck = /^(?:(cd [a-zA-Z0-9_.][a-zA-Z0-9_./-]* && ))?(PATH="\$HOME\/\.cargo\/bin:\$PATH" )?(cargo|node|npm|pnpm|yarn|pytest|go|bun|deno|python3)((?: [a-zA-Z0-9_./:=@,-]+)*)$/;

function declaredChecks(): string[] {
 try {
  const value = JSON.parse(process.env[RUNTIME_TEST_COMMANDS_ENV] ?? '[]');
  return Array.isArray(value) && value.every(c => typeof c === 'string') ? value : [];
 } catch { return []; }
}

/** Observe the existing bash operation, never run a second test or infer its exit code from output. */
export function instrumentBash(createTool: any, operations: any, cwd: string, revision = () => worktreeRevision(cwd, []), options: any = {}) {
 return async (id: string, params: any, signal: any, update: any, ctx?: any) => {
  let record: RuntimeTestRecord | undefined;
  const tool = createTool(cwd, { ...options, operations: { ...operations, exec: async (...args: any[]) => {
   const beforeRevision = revision();
   const prefix = options.commandPrefix ? `${options.commandPrefix}\n` : '';
   const exact = typeof params.command === 'string' && args[0] === prefix + params.command;
   const check = exact && options.declaredChecks?.includes(params.command) && simpleCheck.exec(params.command);
   let reachedInvocation: boolean | undefined;
   let missingCli = false;
   if (check && check[0] === params.command) {
    const [, cd = '', path = '', cli, argv] = check;
    // One shell operation, after tool approval. The configured prefix runs only once.
    // A missing launch marker only invalidates evidence (including a prefix that exits
    // early or hides diagnostics). It never supplies the result or its exit code.
    reachedInvocation = false;
    const marker = `fleet-invoke-${randomUUID()}`;
    const missingMarker = `fleet-missing-${randomUUID()}`;
    const stream = args[2];
    let tail = '';
    args[2] = { ...stream, onData(chunk: Buffer) {
     const text = tail + chunk.toString();
     reachedInvocation ||= text.includes(marker);
     missingCli ||= text.includes(missingMarker);
     tail = text.slice(-Math.max(marker.length, missingMarker.length));
     stream.onData(chunk);
    } };
    args[0] = `${prefix}${cd}if ! fleet_cli=$(${path}command -v ${cli}); then printf '%s\\n' '${missingMarker}' >&2; exit 125; elif [ -f "$fleet_cli" ] && [ -x "$fleet_cli" ]; then printf '%s\\n' '${marker}' >&2; ${path}${cli}${argv}; else exit 125; fi`;
   }
   const result = await operations.exec(...args);
   if (missingCli && reachedInvocation === false) {
    record = { producer: "agent-fleet.runtime-test/v1", command: params.command, exitCode: null, notRunReason: "missing_cli", beforeRevision, afterRevision: revision() };
    throw new Error(`Declared check not run: required CLI '${check[3]}' was not found in the test shell.`);
   }
   if (reachedInvocation === false || missingCli) throw new Error('Declared check has insufficient execution evidence.');
   if (exact) record = { producer: "agent-fleet.runtime-test/v1", command: params.command, exitCode: result.exitCode, beforeRevision, afterRevision: revision() };
   return result;
  } } });
  try {
   const result = await tool.execute(id, params, signal, update, ctx);
   return { ...result, details: { ...result.details, runtimeTest: record } };
  } catch (error) {
   if (!record) throw error;
   return { content: [{ type: "text", text: String(error) }], isError: true, details: { runtimeTest: record } };
  }
 };
}

/** Use Pi's tool_result hook: agent-core ignores isError on resolved execute values. */
export function registerObservedBash(pi: any, api: any, cwd: string, options: any, revision = runtimeTestRevision(cwd, process.env[RUNTIME_TEST_SCOPE_ENV], process.env[PRIVATE_CONFIG_ENV])) {
 const tool = api.createBashToolDefinition(cwd, options);
 pi.registerTool({ ...tool, execute: instrumentBash(api.createBashToolDefinition, api.createLocalBashOperations({ shellPath: options.shellPath }), cwd, revision, options) });
 pi.on("tool_result", (event: any) => {
  if (event.toolName === "bash" && event.details?.runtimeTest?.producer === "agent-fleet.runtime-test/v1" && event.details.runtimeTest.exitCode !== 0)
   return { isError: true };
 });
}

/** Same tool name/schema retains damage-control approval and built-in rendering. */
export default async function runtimeTestCheck(pi: any) {
 const api = await import("@mariozechner/pi-coding-agent");
 const cwd = process.cwd();
 const settings = api.SettingsManager.create(cwd);
 registerObservedBash(pi, api, cwd, { shellPath: settings.getShellPath(), declaredChecks: declaredChecks(), commandPrefix: settings.getShellCommandPrefix() });
}

/** Accept observer events only on the explicitly enabled native transport and a matching tool start. */
export function runtimeTestFromResult(enabled: boolean | undefined, startedCommand: string | undefined, toolName: string, result: any): RuntimeTestRecord | null {
 const record = result?.details?.runtimeTest;
 if (!enabled || toolName !== "bash" || record?.producer !== "agent-fleet.runtime-test/v1" || typeof record.command !== "string" || !record.command || startedCommand !== record.command || record.notRunReason !== undefined || !Number.isInteger(record.exitCode) || !record.beforeRevision || !record.afterRevision || typeof record.beforeRevision !== "string" || typeof record.afterRevision !== "string") return null;
 return { producer: "agent-fleet.runtime-test/v1", command: record.command, exitCode: record.exitCode, beforeRevision: record.beforeRevision, afterRevision: record.afterRevision };
}

/** Only a bounded code-owned reason is transported; the CLI comes from the exact command. */
export function missingRuntimeTestCli(record: RuntimeTestRecord | undefined): string | undefined {
 if (record?.producer !== 'agent-fleet.runtime-test/v1' || record.exitCode !== null || record.notRunReason !== 'missing_cli') return;
 const check = simpleCheck.exec(record.command);
 if (check?.[0] === record.command) return check[3];
}

/** A real matched bash result with no usable receipt is an unknown observation,
 * not absence of evidence. It must supersede an older retained success. */
export function runtimeTestObservationFromResult(enabled: boolean | undefined, startedCommand: string | undefined, toolName: string, result: any): RuntimeTestRecord | null {
 const valid = runtimeTestFromResult(enabled, startedCommand, toolName, result);
 if (valid) return valid;
 if (!enabled || toolName !== 'bash' || !startedCommand) return null;
 const record = result?.details?.runtimeTest;
 if (record?.command === startedCommand && missingRuntimeTestCli(record) &&
     typeof record.beforeRevision === 'string' && record.beforeRevision && typeof record.afterRevision === 'string' && record.afterRevision) {
  return { producer: 'agent-fleet.runtime-test/v1', command: startedCommand, exitCode: null, notRunReason: 'missing_cli', beforeRevision: record.beforeRevision, afterRevision: record.afterRevision };
 }
 return { producer: 'agent-fleet.runtime-test/v1', command: startedCommand, exitCode: null, beforeRevision: 'unavailable', afterRevision: 'unavailable' };
}
