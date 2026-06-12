---
"@chankov/agent-skills": minor
---

Reorganize agent-hub team sets around SDD gates: `default` gains `test-engineer` as the verify gate and drops the always-on `security-auditor` and `bowser`; `debug` is rebuilt around the Prove-It pattern (test-engineer, builder, code-reviewer); `frontend` gains a `code-reviewer` merge gate; new `security` (conditional audit cycle), `hotfix` (minimal builder + reviewer pair), and `release` (releaser + documenter — releaser was previously unreachable via dispatch) teams.
