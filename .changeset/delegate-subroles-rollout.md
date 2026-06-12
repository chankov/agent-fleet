---
"@chankov/agent-skills": minor
---

agent-hub: delegate sub-roles rolled out to five more personas, on an OpenAI-first model ladder

- `planner`, `plan-reviewer`, `builder`, `test-engineer`, and `security-auditor` now declare `subagents:` sub-roles and a "Delegation pre-pass" prompt section, so each can fan out read-only helpers mid-turn via the `delegate` tool (within the existing budgets: 4 children per dispatch, depth 1, parallel children read-only).
  - `planner` — `scout` + `rules` (spark) map the codebase and project rules in parallel before drafting; `risk` (gpt-5.4) optionally challenges the draft breakdown.
  - `plan-reviewer` — `feasibility` (gpt-5.4) verifies plan claims against the codebase; `deps` (spark) checks dependency ordering and file overlap.
  - `security-auditor` — solo `recon` (spark) maps the attack surface first, then `input-sweep` (gpt-5.4) and `secrets-sweep` (spark) fan out; exploit reasoning stays with the parent.
  - `builder` — `recon` (spark) maps call sites before edits; `verifier` (spark) is the single `allow_write: true` child that runs the test suite after them. Implementation is never delegated.
  - `test-engineer` — `coverage-scout` + `conventions` (spark) inventory coverage gaps and test patterns; test writing is never delegated.
- Model ladder is OpenAI-first: `openai-codex/gpt-5.3-codex-spark` for recon/mechanical sweeps, `openai-codex/gpt-5.4` for analysis sweeps, `openai-codex/gpt-5.5` (xhigh) parents reserved for synthesis and verdicts.
- `code-reviewer` sub-roles rerouted accordingly: `quality`/`perf` move from sonnet to `gpt-5.4`, `docs` from haiku to spark; `gpt-5.4` and spark join its candidate list. The parent stays on opus 4.8.
- `plan-reviewer`'s parent model switches from opus 4.8 to `openai-codex/gpt-5.5` with `thinking: xhigh`; candidates are `gpt-5.4` and spark.
- The personas gaining sub-roles also gain `models:` candidate lists (`gpt-5.4`, spark), so `/agent-model <persona>` and `/agent-model <persona>.<role>` have switch targets.
- `.pi/agents/model-profiles.yaml`: `max` and `budget` profiles now cover `planner`, `plan-reviewer`, `security-auditor`, and `test-engineer`; `budget` moves `code-reviewer` from sonnet to `gpt-5.4`.
