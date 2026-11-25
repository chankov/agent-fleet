import type { AcceptanceRequirement, VerificationCheckInput } from './acceptance.ts';
import { missingRuntimeTestCli, type RuntimeTestRecord } from './runtime-test-check.ts';

/** Explain missing exact receipts without treating command text or model claims
 * as evidence. Never unwrap shell scripts: a trailing echo can mask a failure. */
export function verificationDiagnostics(requirements: AcceptanceRequirement[], observations: (RuntimeTestRecord | Pick<RuntimeTestRecord, 'command'>)[], checks: VerificationCheckInput[], diagnosticRevision?: string) {
 const observed = new Map(observations.map(record => [record.command, record]));
 const recorded = new Set(checks.filter(check => check.producer === 'runtime' && check.command.length === 1).map(check => check.command[0]));
 const missing = new Map<string, string[]>();
 const incomplete = new Map<string, string[]>();
 for (const requirement of requirements) {
  if (!['test', 'code-grep'].includes(requirement.tag) || !requirement.source) continue;
  for (const command of new Set([requirement.testCommand, requirement.compilerCommand].filter((value): value is string => !!value))) {
   if (recorded.has(command)) continue;
   const record = observed.get(command);
   if (record && (!('exitCode' in record) || record.exitCode !== null)) continue;
   const target = record ? incomplete : missing;
   target.set(command, [...new Set([...(target.get(command) ?? []), requirement.id])]);
  }
 }
 const unverifiedCommands = [...incomplete].map(([command, requirementIds]) => {
  const record = observed.get(command);
  const cli = diagnosticRevision && record && 'beforeRevision' in record && record.exclusive !== false &&
   record.beforeRevision === diagnosticRevision && record.afterRevision === diagnosticRevision ? missingRuntimeTestCli(record) : undefined;
  return cli ? { command, requirementIds, reason: 'missing_cli' as const, cli } : { command, requirementIds, reason: 'insufficient_execution_evidence' as const };
 });
 return { observedCommandCount: observed.size, missingExactCommands: [...missing].map(([command, requirementIds]) => ({command, requirementIds})),
  ...(unverifiedCommands.length ? { unverifiedCommands } : {}) };
}

export function verificationDiagnosticNotice(diagnostic: ReturnType<typeof verificationDiagnostics>): string | null {
 const notices = (diagnostic.unverifiedCommands ?? []).map(item => item.reason === 'missing_cli'
  ? `Declared check ${JSON.stringify(item.command)} was not run: required CLI '${item.cli}' was not found in the test shell.`
  : `Insufficient execution evidence for declared check ${JSON.stringify(item.command)}.`);
 if (diagnostic.missingExactCommands.length) notices.push(`Exact declared verification commands were not observed (${diagnostic.observedCommandCount} distinct bash commands captured). This is insufficient execution evidence. Wrapped or chained commands do not match and their final exit code can hide test failure. Missing commands: ${JSON.stringify(diagnostic.missingExactCommands)}. In a separately authorized verification attempt, run these commands unchanged, one bash call per command, sequentially with no overlapping tool calls. Do not append echo, pipe, redirect, or wrap them. Runtime records exit codes; report prose is not a receipt. No retry was started.`);
 return notices.length ? notices.join('\n') : null;
}
