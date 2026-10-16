import { worktreeRevision } from "./scope-gate.js";

export interface RuntimeTestRecord {
 producer: "agent-fleet.runtime-test/v1";
 command: string;
 exitCode: number | null;
 beforeRevision: string;
 afterRevision: string;
}

/** Observe the existing bash operation, never execute a second command or parse output. */
export function instrumentBash(createTool: any, operations: any, cwd: string, revision = () => worktreeRevision(cwd, []), options: any = {}) {
 return async (id: string, params: any, signal: any, update: any, ctx?: any) => {
  let record: RuntimeTestRecord | undefined;
  const tool = createTool(cwd, { ...options, operations: { ...operations, exec: async (...args: any[]) => {
   const beforeRevision = revision();
   const result = await operations.exec(...args);
   if (typeof args[0] === "string" && args[0] === (options.commandPrefix ? `${options.commandPrefix}\n${params.command}` : params.command)) record = { producer: "agent-fleet.runtime-test/v1", command: params.command, exitCode: result.exitCode, beforeRevision, afterRevision: revision() };
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
export function registerObservedBash(pi: any, api: any, cwd: string, options: any) {
 const tool = api.createBashToolDefinition(cwd, options);
 pi.registerTool({ ...tool, execute: instrumentBash(api.createBashToolDefinition, api.createLocalBashOperations({ shellPath: options.shellPath }), cwd, undefined, options) });
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
 registerObservedBash(pi, api, cwd, { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() });
}

/** Accept observer events only on the explicitly enabled native transport and a matching tool start. */
export function runtimeTestFromResult(enabled: boolean | undefined, startedCommand: string | undefined, toolName: string, result: any): RuntimeTestRecord | null {
 const record = result?.details?.runtimeTest;
 if (!enabled || toolName !== "bash" || record?.producer !== "agent-fleet.runtime-test/v1" || typeof record.command !== "string" || !record.command || startedCommand !== record.command || !Number.isInteger(record.exitCode) || !record.beforeRevision || !record.afterRevision || typeof record.beforeRevision !== "string" || typeof record.afterRevision !== "string") return null;
 return { producer: "agent-fleet.runtime-test/v1", command: record.command, exitCode: record.exitCode, beforeRevision: record.beforeRevision, afterRevision: record.afterRevision };
}
