# Grilling (Internal Helper)

Use this helper in planning, specification and implementation, and when explicitly
asked to grill or stress-test a proposal. Inventory decisions; do not turn every
implementation choice into a human interview.

## Decision routing

1. **Already settled:** follow the current chat, approved plan/spec and applicable
   project rules. Do not re-confirm accepted decisions or scope.
2. **Discoverable fact:** inspect the repository, docs, tests or runtime evidence;
   use focused research when needed. Missing knowledge is not a user preference.
3. **Routine technical choice:** decide independently within approved scope and
   record the choice and reason in the plan or implementation summary. Examples:
   local helper names, equivalent existing code patterns, test fixtures, and
   reversible implementation details that preserve the public contract. Multiple
   valid approaches alone do not justify a question.
4. **Unresolved material decision:** ask the human before dependent work. Examples:
   changing requirements or acceptance criteria, public compatibility, consequential
   product/architecture trade-offs, new cost or external exposure, destructive
   effects requiring new permission, or conflicting authoritative instructions
   that research cannot reconcile. Explicit user boundaries remain binding even
   for a small edit. If you cannot establish that a choice is within the accepted
   scope, investigate first, then ask about the remaining uncertainty.

Do not infer permission from silence, model consensus or a specialist report.
Internal technical autonomy does not authorize a new dependency, public interface,
external action or scope expansion simply because it is easy to implement.

## Specialist → orchestrator → human

A specialist first uses its instructions and tools to resolve settled, factual and
routine questions. If it still cannot answer, it pauses dependent work and emits
`ASK_USER: <question>`, with evidence checked, options and a recommendation.
The marker is a handoff to the orchestrator, not a mandatory human interruption.
The orchestrator first checks the approved decisions and available evidence,
researches facts, and resolves routine choices itself. It asks the human only for
remaining material decisions or questions it still cannot answer.

Under Agent Hub, parent-resolved questions resume with `ORCHESTRATOR_ANSWER` using
the runtime's documented JSON format (all questions, answers, basis and evidence).
Use `USER_ANSWER` only for actual human answers; never relabel the orchestrator's
judgment as user consent. Clarification does not override permission gates or
cancellation. Without a dispatcher, the agent applies the same decision boundary
and asks the human directly when escalation is needed.

## How to ask

Use `ask_user` or the available structured question tool. If unavailable, ask in
chat and wait for an explicit reply. Ask one focused question with 2–4 concrete
options, a recommendation and its reason. Explain what remains undecided and why
it matters. Do not present a routine choice as a required preference.

Walk material decisions in dependency order; skip questions made irrelevant by
previous answers. Record accepted, rejected or deferred decisions and their source
in the relevant artifact. A deferred decision does not authorize dependent work.
If there are no unresolved material decisions, proceed without a ceremonial question.
Review findings require investigation first; only remaining material decisions
become grilling questions.
