# Ask System 1 consultation

The shared rule for the optional Ask System 1 notes in the research, planning,
independent-review and security practices and their skills. Ask System 1
(`ask_system1`) answers a small typed question about bounded candidates. It is
advice: it never runs anything, grants nothing and proves nothing.

## Who may ask

- **Only the parent Hub operator calls `ask_system1`**, at its own discretion,
  and only when the tool is active in its catalog: the workspace has
  `consumers.agenticAsk.mode: on` with `remoteContextApproved: true`, and System 1
  is ready. Delegated workers, peers and child sessions never have the tool.
- **A delegated worker may suggest a question.** It ends its report with at most
  two lines:

  ```text
  SYSTEM1_QUESTION: {"uncertainty":"Which file enforces the export rule?","input":{"paths":[{"path":"src/export/policy.ts"},{"path":"src/export/job.ts"}],"questions":[{"id":"policy","type":"ordinal","instructions":"How likely is src/export/policy.ts to contain the check that enforces the export rule?","levels":["low","medium","high"]},{"id":"job","type":"ordinal","instructions":"How likely is src/export/job.ts to contain the check that enforces the export rule?","levels":["low","medium","high"]}]},"verify":"Read the highest-ranked file and trace its caller to the enforcing check; continue with the other file if that is inconclusive."}
  ```

  `input` is exactly the `ask_system1` arguments. The Hub validates it with the
  tool's own validator and shows the operator a ready input when the tool is
  active; otherwise its notice says to continue with the verification. A
  suggestion never calls anything and never waits for an answer.

## When a question helps

Ask only about **one specific uncertainty** that blocks the next step, over a
**few bounded candidates** you have already named: files, dependency IDs,
criterion IDs or data flows. Use `choice` (with an `other` or `unknown` option),
`predicate` or `ordinal` questions. Do not ask for facts you can look up, read or
run; do not ask instead of reading code before you change it.

## What goes in

Only context already approved for the consumer: repo-relative paths inside its
`include` scope, or minimal non-secret state. Never secrets, pasted file bodies or
tool output. A refusal (`source_denied`, `not_approved`, a budget limit) is
final for that call: do not copy the content into state, widen the scope or
retry unchanged.

## What comes out

Every answer carries `advisory: true`. It guides **the next verification step**
and nothing else:

- It never counts as evidence, a review verdict, a security finding or an
  acceptance check, and it never settles a decision. The independent reviewer
  still owns the verdict; the operator still owns decisions and refers reserved
  ones to the human.
- Whatever the answer, do the verification the question named. If the answer is
  unavailable, inconclusive or stale, do that verification directly.
- Prompt loading, enabling the setting and a worker's suggestion cause zero
  calls; only an explicit operator call does, within the consumer's budget.
