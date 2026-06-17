---
name: orchestration-verification
description: Defines the Verification Contract that keeps a multi-agent run honest — dispatcher-owned acceptance assertions, a parity/touchpoint inventory for "behave like X" requests, structured upward returns, and a requirement-regression reset. Use when orchestrating specialists through a dispatcher (agent-hub), when a "make X behave like Y" change risks shipping the exemplar while its siblings are missed, or when a clearly stated requirement keeps coming back wrong.
---

# Orchestration Verification — the Verification Contract

## Overview

Multi-agent runs drop clearly stated requirements silently. The dispatcher relays the requirement as *prose*, specialists return *prose* summaries ("approved", "verification passed"), and the feature ships broken anyway. Propagation is rarely the problem — the requirement is usually right there in the dispatch text. **Verification is the problem:** nothing exercised the requirement and refused "done" until it passed.

This skill defines the four artifacts that replace prose-as-truth with **checkable assertions and named evidence**. It is the single canonical source for their formats — orchestrator and specialist personas reference this skill by name instead of restating the schema.

1. **Acceptance assertions** — the dispatcher converts the request into numbered, individually checkable statements before any builder runs.
2. **Parity / touchpoint inventory** — for "make X behave like existing Y", an exhaustive list of every site where the exemplar is special-cased; each becomes an assertion.
3. **Structured upward return** — specialists report assertion *status with evidence*, never a prose verdict.
4. **Requirement-regression reset** — on "it's wrong again", stale summaries are invalidated and the assertion set rebuilt from the latest correction before re-dispatch.

## When to Use

- Orchestrating specialists through a dispatcher (e.g. the `agent-hub` harness) on anything beyond a trivial single read.
- A **"make X behave like existing Y"** request — the parity failure (exemplar implemented, siblings missed) is the dominant multi-agent defect this skill targets.
- UI / visibility / placement work, where a static review can approve a runtime that is actually broken.
- A requirement that has already shipped wrong once — trigger the regression reset before dispatching again.

**When NOT to use:** single-agent trivial changes, pure reconnaissance, or conversational tasks with no implementation.

## Process

The dispatcher runs this loop; the four artifacts below define the formats each step uses.

1. **Build the acceptance assertions first** (Artifact 1). Before any builder is dispatched, convert the request into a numbered, tagged list of checkable pass conditions. No dispatch goes out before the assertions exist.
2. **If the request is "make X behave like existing Y", run the parity inventory first** (Artifact 2). Commission a `deep-researcher` pass that enumerates every site where the exemplar is special-cased, and turn each site into an assertion covering the whole set.
3. **Dispatch in vertical micro-slices, assertions passed verbatim.** Each dispatch carries the relevant assertions word-for-word — never a paraphrase — and ends at a named gate.
4. **Accept only structured returns** (Artifact 3). Specialists report assertion *status with named evidence*, not a prose verdict. Demote any "proven" claim without evidence to unproven.
5. **Gate each slice on proven assertions.** Advance only on assertions that came back proven; `unproven` and `failed` both mean not done and feed the next dispatch. A `runtime-ui` assertion is closed only by an actual runtime observation, never a static review.
6. **On "wrong again", run the regression reset** (Artifact 4). Invalidate stale summaries, rebuild the affected assertions from the latest correction (re-running the parity inventory for "behave like" cases), then re-dispatch.
7. **Recover the ledger after compaction.** If the running context is summarized, re-read the full assertion text and evidence (e.g. `get_assertions` in the agent-hub harness) before re-dispatching or reporting done — a counts-only status line is not enough to gate on.

## Artifact 1 — Acceptance assertions (dispatcher-owned, built first)

Before dispatching any builder, the dispatcher turns the request into a numbered list of assertions. Each assertion is:

```
A<N> `<tag>`: <single checkable pass condition>
```

- **`A<N>`** — stable id (`A1`, `A2`, …) so every downstream dispatch and return can reference it verbatim.
- **`<tag>`** — how it will be proven. Exactly one of:
  - `test` — a passing automated test exercises it.
  - `runtime-ui` — observed in a running UI (DOM / screenshot / network), via `browser-testing-with-devtools`. **Required** for any visibility / placement / "appears in the table" assertion — static review does not satisfy it.
  - `code-grep` — proven by the presence/absence of a code pattern (e.g. "no exemplar-only branch remains without a sibling counterpart").
  - `manual` — a human must confirm; carries a `requires_user_decision` until they do.
- **Pass condition** — one observable fact, true or false. Split compound requirements into separate assertions so each can pass or fail independently.

Each dispatch receives the **relevant assertions verbatim** — never a paraphrase. The dispatcher advances only on assertions that are *proven* (see Artifact 3); anything unproven is treated as not done.

### Worked example — "Retired/Disqualified behave like Walkover"

A request to make detailed scoring behave the same for all cancellation types (Walkover, Retired, Disqualified; excluding NotPlayed) becomes:

```
A1 runtime-ui: exactly one "detailed result" checkbox appears when any cancellation is
   selected, positioned below the winner selection.
A2 runtime-ui: A1 holds identically for Walkover, Retired, and Disqualified; excluded
   for NotPlayed.
A3 runtime-ui: a cancelled match with a detailed score entered shows that result in the
   standings table — for all three types.
A4 runtime-ui: the same match shows NO result in the round-robin / elimination view —
   for all three types.
A5 test: validation fires only when ≥1 detailed input is filled, then requires all
   companion fields.
A6 code-grep: no walkover-specific branch remains in display/validation without a
   Retired/Disqualified counterpart.
```

A2/A3/A4 are deliberately *per-type* — "works for Walkover" proves one third of each, never the whole. This is what stops the exemplar-only ship.

## Artifact 2 — Parity / touchpoint inventory

For any "make X behave like existing Y" request, the exemplar (`Y`) is almost always special-cased in more than one place. Patch one site and the siblings stay broken — the run reports "done" and the user re-asks. To kill this:

1. **Run a parity pass first** — a `deep-researcher` recon that enumerates **every** site where the exemplar is special-cased: feature flags, branches, display logic, validation, translations, fixtures, tests.
2. **Turn each site into an assertion** — every listed site must be generalised to the whole set, and gets an assertion (usually `code-grep` for "no exemplar-only branch remains" plus a `runtime-ui`/`test` for the behaviour).
3. **Re-run the proof across every member of the set** — the verification for member A is repeated for B and C. A proof that only covers the exemplar does not close the assertion.

The inventory is **dispatcher-owned**: the dispatcher commissions it and converts it into assertions. Downstream specialists **consume** the inventory (confirm each listed site is covered) rather than independently re-deriving the call sites — re-derivation is exactly where sites get missed.

```
Parity inventory checklist
- [ ] Every exemplar special-case site enumerated (flags, branches, display, validation,
      translations, fixtures, tests) — by a deep-researcher pass, not a guess.
- [ ] Each site mapped to an assertion that covers the WHOLE set, not just the exemplar.
- [ ] The verification plan re-runs the same proof for every member of the set.
- [ ] A `code-grep` assertion guards against any exemplar-only branch surviving.
```

## Artifact 3 — Structured upward return

Specialists end their work with a structured object, **not** prose-as-truth. Free-form "looks good / approved" summaries are what reported success over a broken feature; they are not accepted.

```
changed_files:        [path:line — 3–6 word note, …]
assertions_proven:    [A2: standings shows for Retired ✓ — evidence: <test name | screenshot | grep result>, …]
assertions_unproven:  [A4: round-robin hidden for Disqualified — NOT checked, …]
assertions_failed:    [A3: standings empty for Retired — evidence: <runtime observation>, …]
tests_run:            [command → result, …]
open_risks:           [non-blocking concerns, assumptions made, …]
requires_user_decision:[questions only a human can resolve, …]
```

Rules:
- An assertion may be listed under `assertions_proven` **only if its evidence is named** (test name, command output, file:line, or runtime observation). No evidence → it belongs in `assertions_unproven`.
- `assertions_unproven` and `assertions_failed` are reported **honestly** — never re-labelled as success to look finished. Half-done is more useful stated than hidden.
- The dispatcher advances only on `assertions_proven`. `unproven` and `failed` both mean *not done* and feed the next dispatch.

## Artifact 4 — Requirement-regression reset

When the user says a delivered requirement is **wrong again**, the prior upward summaries are now known to be unreliable — do not build on them. Before any new dispatch:

1. **Invalidate stale summaries** — treat earlier "proven/approved" claims for the affected area as unverified.
2. **Rebuild the assertion set from the latest correction** — the newest user message is the source of truth; re-derive the affected assertions from it (a reversed instruction replaces, it does not append).
3. **Re-run the parity inventory** if the regression is a "behave like" case — the missed siblings usually live in a site the first inventory skipped.
4. **Only then dispatch**, with the rebuilt assertions passed verbatim.

## How the artifacts connect

```
request ──→ [A1] build acceptance assertions (dispatcher)
   │            │
   │            └─ "behave like Y"? ──→ [A2] parity inventory (deep-researcher) ──→ more assertions
   ▼
dispatch builder (assertions verbatim) ──→ [A3] structured return (status + evidence)
   │                                              │
   │            ┌── all relevant assertions proven? ──┐
   ▼            │                                     │
gate per slice ─┴── no ──→ re-dispatch unproven/failed
   │
   └── runtime-ui assertion? ──→ require browser proof, not static review
        │
   "wrong again" from user ──→ [A4] regression reset ──→ rebuild assertions ──→ re-dispatch
```

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The requirement is in the dispatch text, so it's covered." | Propagation isn't verification. The walkover incident had the requirement in 24 of 29 dispatches and still shipped wrong. Only an executed assertion closes it. |
| "Walkover works, the others are the same code path." | They are usually *not* — that assumption is the parity failure itself. Prove each member of the set separately, or it isn't proven. |
| "The reviewer approved it." | A prose "approved" over a `runtime-ui` assertion is not evidence. For visibility/placement, only a runtime observation counts. |
| "I'll inventory the call sites as I go." | Incremental discovery is how siblings get missed. Run the parity pass *first* and make it exhaustive, then build against the list. |
| "The summary said verification passed." | A summary without named evidence per assertion is prose-as-truth. Demote it to `unproven` until evidence is attached. |
| "It was proven last round, no need to recheck." | After a "wrong again", prior proofs are suspect. Reset the assertions from the latest correction before trusting anything. |
| "Splitting this into per-type assertions is overkill." | Per-type is the point. One combined assertion lets a one-third implementation read as done. |

## Red Flags

- A dispatch goes out before the acceptance assertions exist.
- A "behave like Y" request proceeds without a parity/touchpoint inventory.
- A specialist returns a prose verdict ("looks good", "approved") instead of the structured object.
- An assertion is marked proven with no named evidence.
- A `runtime-ui` assertion is closed on static review / a code reading alone.
- The same defect is re-asked and the next dispatch reuses the old assertions/summaries unchanged.
- "Works for the exemplar" is reported as the whole requirement done.
- Verification covers code mechanics and the exemplar path (which has fixtures) but not semantic parity across the set or the runtime UI.

## Verification

Before reporting an orchestrated task as done, confirm:

- [ ] A numbered acceptance-assertion list existed **before** the first builder dispatch, each with a tag and a single pass condition.
- [ ] Every "behave like Y" requirement produced a parity/touchpoint inventory, and each site became an assertion covering the whole set.
- [ ] Every specialist return was the structured object — `assertions_proven` entries each name their evidence.
- [ ] Every `runtime-ui` assertion carries an actual runtime observation (DOM / screenshot / network), not static approval.
- [ ] No assertion sits in `assertions_unproven` or `assertions_failed` at "done" — unproven means not done.
- [ ] On any "wrong again", the assertion set was rebuilt from the latest correction before re-dispatch.
