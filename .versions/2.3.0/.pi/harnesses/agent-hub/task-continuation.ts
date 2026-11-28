/** Closed control grammar (an optional bare ok/окей/добре prefix is still pure continuation). Yes/No and any extra instruction remain task input. */
export function isTaskContinuation(text:string):boolean {
 return /^(?:(?:ok|okay|окей|добре)[,.!]?\s+)?(?:continue|resume|continue please|please continue|продължи|продължавай|продължете|моля,?\s+(?:те,?\s+)?продължи)[.!]*$/iu.test(text.trim());
}

export const TASK_INPUT_ENTRY_TYPE = "agent-hub-task-input";
/** Larger inputs are not journaled; after a resume they simply are not restored. */
export const TASK_INPUT_MAX_CHARS = 32_000;

/** The task input the session was working on before it was closed. A resumed session starts with no
 * task text, so without this the first bare "continue" became the task itself: it was triaged, bound
 * as the approval scope and judged by the watchdog in place of the real request. */
export function latestAcceptedTaskInput(entries: readonly unknown[]): string | undefined {
 for (let i = entries.length - 1; i >= 0; i--) {
  const row = entries[i] as any;
  if ((row?.customType ?? row?.type) !== TASK_INPUT_ENTRY_TYPE) continue;
  const text = row?.data?.text;
  return typeof text === "string" && text.trim() && text.length <= TASK_INPUT_MAX_CHARS ? text : undefined;
 }
 return undefined;
}
