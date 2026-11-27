---
name: debate
description: Guides the Hub operator through a model-panel Debate — choosing it over research or a Poll, framing one self-contained decision question, invoking `debate_panel` or `/af-debate`, reading final positions, changes and open disagreements from the structured result, and recording or escalating the operator's own decision. Use when a known objection could change a choice between viable alternatives, when a Poll surfaced material disagreement, or when a debate result has to become a recorded decision.
---

# Debate — cross-examine a decision before the operator makes it

## Overview

A Debate asks every voice of a model panel the same decision question and then, for 2–5 rounds, gives each voice the other voices' labelled positions so a decision-changing objection is tested instead of averaged away. The harness mediates every round: voices never message each other, never write, and nobody judges. The result says where each voice ended, who moved and on what evidence, and what is still disputed. The decision stays with the operator, and with the human where policy reserves it.

This skill is operator guidance. It confers no tool, permission or capability, and it is not a practice: the practice catalogue stays at eleven and role delegates do not start debates.

## When to Use

- Two or more viable alternatives exist and a **known objection** could change which one wins. Debate directly; a prior Poll is optional.
- A Poll (`poll_panel` / `/af-poll`) returned material disagreement and the positions need cross-examination before the operator chooses.
- A review produced incompatible remedies for one finding. Debate the remedies; the review verdict stays with the reviewer.

**When NOT to use:**

- A fact is missing (who calls X, what a dependency does, whether a test passes). Research it with `spawn_research` or run the check. Never debate facts.
- Several options look viable but no specific objection is known. A Poll collects independent theses at lower cost.
- A routine technical choice inside approved scope, or anything that needs acceptance evidence. A debate is not a test, a runtime observation or an independent review.

**Proposals from delegates.** A delegate with the planning, architecture, independent-review or security practice never starts a Poll or a Debate. It may propose one with a `DECISION_QUESTION:` line, which the dispatch or research result shows as a notice with the tool and a ready question (details in `details.decisionQuestions`). A proposal never blocks or accepts the run. Treat it as step 2 already drafted: check it against step 1, then run it, run the other method, or decline with a reason in the Operator notes.

## Process

1. **Choose the method.** Research establishes missing facts. Poll collects independent theses when several options are viable. Debate tests a known objection, or the disagreement a Poll surfaced. Independent work continues in parallel under the existing dependency and write-isolation rules; only work that depends on this decision waits for it.

2. **Frame one self-contained decision question.** Voices see the question and the checkout, nothing else from the session. Write, in this order:
   - **Decision** — one sentence naming what is being chosen.
   - **Alternatives** — the viable options, labelled (A), (B), …
   - **Objection to test** — the specific claim that would flip the choice.
   - **Evidence** — repository paths and earlier Poll, research or review artifact paths. Paths, never pasted bodies.
   - **Constraints** — scope, compatibility, cost or deadline limits already decided.

   One decision per debate. Split a compound question; settle factual sub-questions first.

3. **Invoke it.** Use the typed tool `debate_panel` with `question` (required), `panel`, `persona` and `rounds` (all optional). The manual command is `/af-debate [--panel NAME] [--persona researcher|reviewer] [--rounds N] <question>`; the question is all non-flag text, and `"…"` or `'…'` quoting is accepted. Both entry points run the same path:
   - **Panel.** An explicit name wins, then the configured panel (the active model profile's, else `poll-panel:` in `## agent-hub` of `.ai/agent-fleet-overrides.md`), then a panel named `default` if `.pi/agents/voices.yaml` defines one. An unknown explicit name fails even when a fallback exists; while a complete model profile is active, its panel is the only one.
   - **Persona.** `researcher` (default) for design and approach questions; `reviewer` when the voices assess a named revision or review finding. Voices are always read-only; `editor` and retired persona names are refused.
   - **Rounds.** An integer 2–5, default 3. Two rounds test one objection and one reply; use 4–5 only when positions are still moving. Every round costs one model run per surviving voice.
   - **Git target.** Voices inspect the session's assigned checkout. From a non-Git Fleet workspace, start the session with `just fleet --worktree <path>`; nothing is guessed. Any preflight refusal (question, persona, rounds, panel, target) starts no voice: correct the named input and call again.

   Minimal tool call:

   ```json
   {
     "question": "Decision: where should the export retry limit live? Alternatives: (A) one default in the shared HTTP client, src/http/client.ts; (B) a per-job setting in src/export/job.ts. Objection to test: a client-wide default would also retry the non-idempotent POST in src/billing/charge.ts and could charge twice. Evidence: src/http/client.ts, src/export/job.ts, src/billing/charge.ts, docs/adr/0007-retries.md. Constraints: no public API change; keep the current timeouts."
   }
   ```

   Tool call with panel, persona and rounds:

   ```json
   {
     "question": "Decision: which remedy closes review finding F2 (stale permissions after a role change) at HEAD? Alternatives: (A) invalidate the session cache in src/auth/roles.ts on every role update; (B) cut the cache TTL in src/auth/cache.ts to 30 seconds. Objection to test: (A) adds a write per role update, and the bulk import in src/admin/import.ts updates thousands of roles in one run. Evidence: .pi/agent-sessions/artifacts/returns/reviewer-run1.md, src/auth/roles.ts, src/auth/cache.ts, src/admin/import.ts. Constraints: no schema migration; the reviewer keeps the verdict.",
     "panel": "default",
     "persona": "reviewer",
     "rounds": 4
   }
   ```

   Manual commands:

   ```text
   /af-debate --rounds 2 "Decision: keep the nightly export on cron or move it to the queue worker? Alternatives: (A) keep the cron entry in deploy/cron.yaml; (B) enqueue it from src/jobs/scheduler.ts. Objection to test: the queue worker takes no exclusive lock, so two workers could export the same day twice. Evidence: deploy/cron.yaml, src/jobs/scheduler.ts, src/queue/worker.ts. Constraints: no new infrastructure."
   ```

   ```text
   /af-debate --panel default --persona researcher --rounds 3 Decision: version the public events API by URL path or by header? Alternatives: (A) /v2/events routes in src/api/routes.ts; (B) an Accept-Version header read in src/api/middleware.ts. Objection to test: the CDN rules in deploy/cdn.yaml cache by path only, so header versioning could serve v1 bodies to v2 clients. Evidence: src/api/routes.ts, src/api/middleware.ts, deploy/cdn.yaml, docs/api/versioning.md. Constraints: v1 clients keep working unchanged.
   ```

4. **Inspect the result.** Round 1 forms each voice's position independently and in parallel; in later rounds each voice receives the other successful voices' labelled positions from the round before. A failed voice drops out, and the debate stops early when fewer than two voices succeed in a round; fewer than two successes in round 1 is a failed debate (`DEBATE FAILED`) with nothing to weigh. A result starts with `DEBATE RESULT (panel NAME, R of N rounds, complete)` or `…, stopped: <reason>)`. Read, in order:
   - **Final positions** — each voice's last position.
   - **Changes** — `changed: round K — moved by: …` names the evidence that moved a voice; `changed: no` means it held. A move with no evidence given is persuasion, not evidence.
   - **Open disagreements** — each voice's final-round refutations, attributed as `- voice: statement`, or none reported.
   - **Failed voices and incomplete rounds** — a failed voice shows its last position, which is not a final one; `stopped:` means fewer rounds ran than were asked.
   - **Artifacts** — the round directories and `Full debate: <path>`, one report per voice per round under `.pi/agent-sessions/artifacts/polls/<runId>/debate/round-<n>/` at the Fleet workspace. Open a report only when the digest cannot answer a specific question, and cite its path; never paste voice bodies into the session.

5. **Decide and record.** There is no judge and no binding verdict. The operator owns the decision:
   - Weigh positions by their evidence and the objection's outcome, not by vote count. Keep dissent visible.
   - Record the decision, its reason, the evidence paths and any unresolved dissent in the task brief's **Operator notes**.
   - Refer a reserved or material decision to the human with `ask_user`: changed requirements, a public compatibility contract, new cost or exposure, destructive effects, or conflicting authoritative instructions. Offer one option per surviving position with its evidence, plus the operator's recommendation and reason.
   - Model consensus is never permission. A debate never replaces an independent reviewer's verdict or the acceptance evidence defined by `orchestration-verification`.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The panel agreed, so the choice is made." | Agreement is input. The operator decides, and a reserved decision still goes to the human. |
| "Let the voices settle what the code does." | That is a fact. Research it or run the check; debating it produces confident guesses. |
| "Paste the files so the voices have context." | Voices read the checkout. Give paths; pasted bodies bloat every round and go stale. |
| "Always poll first, then debate." | A prior Poll is optional. With a known objection, debate directly. |
| "Five rounds is the thorough choice." | Rounds cost one run per voice each. Use the fewest that can test the objection. |
| "The debate approved the fix, so review is done." | A debate is not a review. The independent reviewer's verdict and the acceptance evidence still close the work. |
| "Everything waits until the debate ends." | Only dependent work waits. Independent work continues under the dependency and write-isolation rules. |

## Red Flags

- The question has no named objection, no alternatives, or bundles several decisions.
- The question pastes file bodies or session transcript instead of paths.
- A debate is used to establish a fact, or started with `persona: "editor"`.
- A failed or `stopped:` debate is reported as if it reached a final position.
- A voice "changed" with no evidence given, and that change decides the outcome.
- The operator's decision is not in the task brief's Operator notes, or dissent was dropped from it.
- A reserved decision is acted on from the debate result without `ask_user`.
- A debate result is cited as review approval or acceptance evidence.
- Full voice reports are pasted into the session instead of cited by path.

## Verification

- [ ] The method was chosen for a reason: facts were researched first; a debate tested a named objection or a Poll's disagreement.
- [ ] The question named the decision, the alternatives, the objection, evidence paths and constraints.
- [ ] The call used `debate_panel` or `/af-debate` with a valid panel, a read-only persona and 2–5 rounds, and any preflight refusal was corrected before retrying.
- [ ] The result header was checked for `complete` or `stopped:`, and failed voices were treated as non-final.
- [ ] Changes were read with the evidence that moved them, and open disagreements were kept with their voices.
- [ ] The decision, reason, evidence paths and dissent are recorded in the task brief's Operator notes.
- [ ] A reserved or material decision went to the human with `ask_user`.
- [ ] Review verdicts and acceptance evidence came from their own sources, not from the debate.
