---
"@chankov/agent-fleet": patch
---

Stop the operator from re-binding `set_task_tier` in a loop, and stop reporting a recovered child run as failed.

- The hub system prompt is fixed for a whole agent run, so its "pending task transition" text stayed visible after `set_task_tier` had already bound the input and the operator kept re-binding (and sometimes reported itself blocked). The prompt now carries a start-of-turn notice that expires on the first `set_task_tier` result, the tool results say explicitly that nothing is pending, and consecutive no-op calls are called out as a loop.
- `Окей, моля те продължи`, `ok continue`, `Добре, продължавай` and similar bare continuations no longer open a task transition.
- A native child whose provider error was retried successfully by pi (or that continued after a compaction abort) and then finished cleanly is no longer turned into a failed dispatch; only an error on the last assistant message fails the run.
- Resuming a session keeps the declared task tier. A resumed `feature`/`project` task no longer falls back to `small` (10-minute child deadline, no delegation); `set_task_tier` now journals the new tier with its process entry.
- An operator-cancellation fence can be lifted again after the task changes: `/af-retry` and `/af-recover retry` no longer refuse it for belonging to the previous task, `/af-recover abandon` releases the agent identity, and resume does not resurrect an abandoned fence. The fence itself still needs the one-use human authorization.
- A bare "continue" as the first input after resuming a session now re-accepts the task the session was working on instead of becoming the task itself. Sessions recorded before this release have no journaled task input and behave as before.
- Esc during `dispatch_agent` now stops the running specialist (or abandons the coms wait) and its automatic research rounds, instead of leaving the hub busy until the child finished on its own. The Esc fence is lifted once by the next input the human types, so "Esc, then continue" needs no `/af-retry`; coms messages and automatic turns never lift it, and a kill from the fleet panel still needs `/af-retry`.
