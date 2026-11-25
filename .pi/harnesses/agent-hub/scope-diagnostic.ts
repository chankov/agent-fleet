// These diagnostics describe the evidence boundary, not what a reviewer read or a test exercised.
export type ScopeDiagnostic = { checkedPaths: 'unknown'; nextStep: string } & (
 | { kind: 'unknown' }
 | { kind: 'observation_gap'; scopeEntry: number }
 | { kind: 'declared_scope_gap'; omittedCount: number }
 | { kind: 'omitted_task_entry'; entry: string }
);

export interface TaskDisplayScope {
 taskId: string;
 entries: readonly string[];
}

/** The registered-file gap is already established by admission. The task brief
 * supplies display labels only: never derive a printable path from the gap. */
export function earlyOperatorScopeDiagnostic(input: {
 taskId: string; prior?: TaskDisplayScope; registered: readonly string[];
 omitted: readonly string[]; declared: readonly string[];
}): ScopeDiagnostic {
 const followUp = 'Compare the registered task files with local Git status, add the exact workspace-relative changed files missing from the scope, and rerun the review with targeted checks.';
 const canonical = (path: string) => path.split('/').every(part => !!part && part !== '.' && part !== '..') && !/[\\\x00-\x1f\x7f]/.test(path);
 const within = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);
 if (input.taskId && input.prior?.taskId === input.taskId) {
  // Match raw canonical registered paths, not normalized aliases from checkScope.
  const gaps = new Set(input.omitted);
  const missing = input.registered.filter(path => gaps.has(path) && canonical(path));
  const entry = [...input.prior.entries].sort().find(label =>
   typeof label === 'string' && label.length <= 256 && label.split('/').every(part =>
    /^[A-Za-z0-9_]/.test(part) && !/[^A-Za-z0-9_.-]/.test(part)) &&
   !input.declared.some(path => within(path, label)) && missing.some(path => within(path, label)));
  if (entry) return { kind: 'omitted_task_entry', entry, checkedPaths: 'unknown',
   nextStep: `The declared review scope leaves out registered task work under the previously declared entry \`${entry}\`. ${followUp}` };
 }
 return { kind: 'unknown', checkedPaths: 'unknown', nextStep: followUp };
}

export function reviewScopeDiagnostic(omittedCount?: number): ScopeDiagnostic {
 if (omittedCount) return {
  kind: 'declared_scope_gap', checkedPaths: 'unknown', omittedCount,
  nextStep: `The declared review scope omits ${omittedCount} registered task file(s). Add the omitted task files to the review scope and run targeted checks for those changes at the same revision.`,
 };
 return {
  kind: 'unknown', checkedPaths: 'unknown',
  nextStep: 'Re-establish the changed-file list for the current task and revision from the worktree, declare those files, and re-run review with targeted checks for the changed surfaces.',
 };
}

export function formatScopeDiagnostic(diagnostic: ScopeDiagnostic): string {
 return `Actual checked paths are unknown. ${diagnostic.nextStep}`;
}
