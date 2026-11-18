import type { AcceptanceRequirement, VerificationCheckInput } from './acceptance.ts';
import type { RuntimeTestRecord } from './runtime-test-check.ts';

/** Explain missing exact receipts without treating command text or model claims
 * as evidence. Never unwrap shell scripts: a trailing echo can mask a failure. */
export function verificationDiagnostics(requirements: AcceptanceRequirement[], observations: Pick<RuntimeTestRecord, 'command'>[], checks: VerificationCheckInput[]) {
 const observed = new Set(observations.map(record => record.command));
 const recorded = new Set(checks.filter(check => check.producer === 'runtime' && check.command.length === 1).map(check => check.command[0]));
 const missing = new Map<string, string[]>();
 for (const requirement of requirements) {
  if (!['test', 'code-grep'].includes(requirement.tag) || !requirement.source) continue;
  for (const command of new Set([requirement.testCommand, requirement.compilerCommand].filter((value): value is string => !!value))) {
   if (observed.has(command) || recorded.has(command)) continue;
   missing.set(command, [...new Set([...(missing.get(command) ?? []), requirement.id])]);
  }
 }
 return { observedCommandCount: observed.size, missingExactCommands: [...missing].map(([command, requirementIds]) => ({command, requirementIds})) };
}

export function verificationDiagnosticNotice(diagnostic: ReturnType<typeof verificationDiagnostics>): string | null {
 if (!diagnostic.missingExactCommands.length) return null;
 return `Exact declared verification commands were not observed (${diagnostic.observedCommandCount} distinct bash commands captured). Wrapped or chained commands do not match and their final exit code can hide test failure. Missing commands: ${JSON.stringify(diagnostic.missingExactCommands)}. In a separately authorized verification attempt, run these commands unchanged, one bash call per command, sequentially with no overlapping tool calls. Do not append echo, pipe, redirect, or wrap them. Runtime records exit codes; report prose is not a receipt. No retry was started.`;
}
