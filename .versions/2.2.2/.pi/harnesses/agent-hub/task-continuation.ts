/** Closed control grammar. Yes/No and any extra instruction remain task input. */
export function isTaskContinuation(text:string):boolean {
 return /^(?:continue|resume|continue please|please continue|продължи|продължете|моля,?\s+продължи)[.!]*$/iu.test(text.trim());
}
