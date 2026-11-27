---
# release: keep-bump
"@chankov/agent-fleet": minor
---

The Hub operator can start a Debate itself, and a new Debate skill says when and how.

- New `debate_panel` tool (`question`, optional `panel`, `persona`, `rounds` 2–5, default 3). It and `/af-debate` share one path with Poll's panel precedence (an explicit name, the configured `poll-panel:` or active model profile, then a panel named `default`) and Poll's Git work context (the session's assigned checkout; a non-Git workspace needs `just fleet --worktree <path>`). An invalid request is refused once before any voice starts or any budget is charged.
- The result is structured and has no judge: each voice's final position, which voices changed position in which round and the evidence that moved them, failed voices, rounds that did not run, and each voice's final-round refutations as the open disagreements, with the round artifacts on disk. The operator owns the decision.
- `/af-debate` and `debate_panel` show one live block (resolved panel, round of the total, one row per voice) and deliver the outcome once, instead of a started message, one message per voice and a notification.
- Poll and Debate voices take the persona `researcher` (default) or `reviewer` only; `editor` is refused and a retired persona name shows its role mapping.
- `skills/debate` is operator guidance for framing a decision, choosing Poll or Debate, reading the result and recording or escalating the decision. The Hub requires it, like the three roles. It adds no role or practice.
- The operator prompt names `debate_panel` next to `poll_panel` and drops repeated rules to stay inside its size budget.
