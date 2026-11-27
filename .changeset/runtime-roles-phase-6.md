---
# release: keep-bump
"@chankov/agent-fleet": minor
---

Four practices say when a delegated worker should propose a Poll or a Debate, and the Hub hands a valid proposal to the operator ready to run.

- `planning`, `architecture`, `independent-review` and `security` each name their trigger: viable sequences, scopes or migration paths and a dependency or rollback objection; trade-offs with their assumptions and evidence; a substantial finding or incompatible remedies tied to the named revision; mitigations once the risk is established and a disputed threat-model assumption or residual risk. One shared paragraph per assignment gives the format and points at the `debate` skill.
- A worker never starts a Poll or a Debate. It ends its report with at most two `DECISION_QUESTION: {"method":"poll"|"debate",…}` lines. The Hub validates each one and adds a single notice to the dispatch or research result with `poll_panel` or `debate_panel` and a ready question (`details.decisionQuestions`); a rejected line is reported with its reason.
- A proposal starts nothing and never blocks, fails or accepts the run, and a reviewer's verdict stays its own. A worker that cannot continue without the decision still raises `ASK_USER`; facts still go to research.
- The planning skill's operator-only paragraph now covers Poll and Debate, and the Debate skill says how to treat a delegate's proposal.
