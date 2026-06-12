---
"@chankov/agent-skills": minor
---

agent-hub: sub-role model switching, project rules, and a review preflight

- `/agent-model <persona>.<role>` switches a delegate sub-role's model among the role's declared default plus the parent persona's candidate list; applied via the delegate config on the persona's next dispatch (nested children inherit it). `/models` profiles still never touch sub-roles.
- New `rules:` key under `## agent-team` in `.ai/agent-skills-overrides.md`: comma-separated repo-relative folders of project rule files, each searched recursively through all subfolders. The harness injects a "Project rules" block into every dispatched specialist; missing folders warn at session start.
- The planner and code-reviewer personas resolve the `rules:` entry, validate their subject against the discovered rules, and pass the relevant rules on — cited in plan acceptance criteria (planner) or handed to the right delegate sub-reviewer (code-reviewer).
- code-reviewer gains a `preflight` sub-role (default `openai-codex/gpt-5.3-codex-spark`) that runs as the mandatory first delegate call: it studies the rules and the files under review and returns a summary that drives the rest of the fan-out.
- code-reviewer's `security` delegate sub-role is removed — deep security review is owned by the separate `security-auditor` persona, which the reviewer now recommends dispatching when it spots deeper risk.
