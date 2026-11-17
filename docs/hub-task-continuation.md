# Continue an interrupted Hub task

Use `recover_task` with the operation and latest attempt reported by a no-progress refusal, or run:

```text
/af-recover continue <operationId> <attemptId>
```

The tool appears in the active catalog only while there is a recoverable operation. Fresh sessions keep their normal prompt budget. A refusal before launch does not spend a continuation forever: correct its prerequisite and request fresh analysis and approval for the latest attempt.

This is an explicit request to finish the same task and plan step. A separate `researcher` uses the existing read-only research runtime to inspect the original assignment, partial files and available evidence. It returns completed, partial, remaining and unknown findings. Uncertain external effects block continuation until resolved.

The Hub retains that report and presents it before one correlated human decision. If runtime settlement is unavailable, the affirmative option explicitly states that the operator verified the old execution is stopped. The ledger records this as `operator_attested`; it does not invent runtime settlement or declare the old attempt successful. Do not confirm while the old execution can still write to the project.

After approval, the original specialist role starts a new attempt under the same operation and task. Its prompt retains the original assignment, inputs, scope, deliverables and acceptance criteria, and adds the research findings so it can focus on finishing and verifying the work. The researcher's claims do not automatically satisfy acceptance.

The analysis is not subject to the `spawn_research` no-progress fence: a crashed or incomplete analysis names its cause and may simply be requested again. Absolute in-workspace dispatch scope is mapped to repository-relative read scope for the researcher; the specialist keeps the original scope. A recorded parallel instance such as `builder--p2` is re-created from its base persona before analysis; if the original specialist cannot be made available, the request is refused before any research or question. The approved dispatch may repeat a same-turn watchdog-stopped task without a duplicate refusal, because it is the human-confirmed repeat of that attempt. When the command runs a continuation, its outcome is also added to the conversation so the dispatcher does not re-dispatch finished work.

Sessions are not locked. If a second Pi process restores the session while the original attempt is still running, that attempt is recorded as interrupted and unsettled; an outcome the original owner appends later is kept as `lateOutcome` for inspection and never turns the uncertainty into settlement or completion. A history that cannot be restored keeps dispatch refused without aborting the rest of session start.

Changed project inputs, changed task context, a changed report, a busy executor, failed research, denial or cancellation leave the operation fenced. The original budgets and safety gates still apply. An in-memory permit is consumed once and is never recreated by session replay. Another crash requires fresh research and another explicit human decision.

`/af-recover inspect` exposes the continuation audit records, report reference and settlement basis. The existing `retry`, `reconcile` and `abandon` actions keep their separate behavior; continuing does not abandon the task or reset its obligations.
