---
# release: keep-bump
"@chankov/agent-fleet": minor
---

Ask System 1 is a simple on/off setting, four practices say when a worker may suggest a question for it, and System 1's transport is now an explicit, documented decision.

- `consumers.agenticAsk.mode` takes `on` or `off`; a missing mode is `off`. The legacy `advisory` and `recommended` are read as `on` with consent, scope, limits and every other consumer unchanged, and setup never rewrites the section. When `ask_system1` is active the Hub shows the recommended guidance, and the operator decides whether to call it; enabling it, building the prompt or refreshing the catalog makes no call.
- `agent-fleet doctor` shows Ask System 1's canonical mode (naming a legacy value) and whether the tool is available, or the first missing prerequisite: the consumer off, no consent, root System 1 off, the feature not enabled, or System 1 not locally ready.
- `research`, `planning`, `independent-review` and `security` each name one optional Ask System 1 question and the verification to do next. A worker never calls the tool; it may end its report with at most two `SYSTEM1_QUESTION: {…}` lines, which the Hub validates with the tool's own validator and shows the operator as a ready input when `ask_system1` is active, or as the verification to do directly when it is not (`details.system1Questions`). The four skills' named sections point at the shared rule in the new `references/system1-consultation.md`.
- Every System 1 call keeps Fleet's direct TypeSafe adapter. Pi's native classifier was checked and is not used: its catalog has only `typesafe/jev-latest`, `models.json` cannot declare a classifier, and its results lack the returned model and ordinal distributions. Doctor shows `transport: direct` for an enabled configuration, and the configuration guide explains Fleet policy versus the credential.
