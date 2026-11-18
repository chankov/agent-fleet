---
"@chankov/agent-fleet": patch
---

Damage-Control approvals reach the Codex permission relay in more cases. Zero-access requests (`.env` and similar) and the `read`, `grep`, `find`, `ls`, `filesystem` and `submit_result` tools now go to Codex as well, in the Hub and from child agents. Codex sees their complete input as JSON data, under the same screening for unsafe text and the same size limits. Machine decisions are still once-only.

A child agent's destructive `ask: true` bash pattern (for example `git stash drop`) now escalates to the Hub, and through it to Codex, as one exact call. Before, the child blocked it without asking anyone. It is never turned into an exemption.

When the relay cannot open a request, the local dialog still runs. Before, the Hub blocked the call without asking. A `relay_not_used` entry in `damage-control-log` now records why Codex was not asked (`unsafe_text`, `presentation_too_large`, `no_exact_action`, `no_owner`, and so on).
