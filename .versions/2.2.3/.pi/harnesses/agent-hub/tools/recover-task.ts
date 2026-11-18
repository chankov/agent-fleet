import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import type { ToolExecutor } from './context.ts';
import type { RecoveryContinuationRequest } from '../recovery-continuation.ts';

export function registerRecoverTask(pi: ExtensionAPI, execute: ToolExecutor<RecoveryContinuationRequest>): void {
 pi.registerTool({
  name: 'recover_task', label: 'Recover Task',
  description: 'Analyse an interrupted specialist task with a read-only researcher, then request one human-approved continuation by its original role. Use only when the operator asks to continue that task. Never abandons or marks it complete.',
  parameters: Type.Object({
   operationId: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$', description: 'Recorded operation from the recovery refusal.' }),
   attemptId: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$', description: 'Latest interrupted attempt from the recovery refusal.' }),
  }),
  execute,
 });
}
