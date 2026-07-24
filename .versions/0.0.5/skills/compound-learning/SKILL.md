---
name: compound-learning
description: Captures a finished session's lessons into the project's own rules and docs — extracts candidate lessons from session evidence, dedupes them against the existing rule tree, and lands them as minimal diffs on existing files. Use when a session ends with user corrections, recurring review findings, or debugging root causes worth keeping, when the user says "compound" or "capture the lessons", or as the documenter's process for a /compound dispatch.
---

# Compound Learning

## Overview

Every session produces knowledge that is more durable than the diff: corrections the user had to make twice, review findings that keep recurring, root causes that took an hour to find, assumptions that turned out wrong. When the session ends, that knowledge evaporates — and the next session pays for it again.

This skill is the **compound step**: it converts session evidence into small, deduplicated updates to the project's own rule tree (HOW — compliance) and documentation (WHAT/WHY — orientation), so each session makes the next one better.

The enemy is not missing lessons — it is **bloat**. A rule tree that grows by five generic rules per session becomes noise that future sessions skim past. Every part of this process is biased toward *fewer, sharper* updates on *existing* files: the default verdict for any candidate lesson is "not worth keeping".

## When to Use

- A session is wrapping up and it contained at least one correction, recurring finding, or hard-won discovery.
- The user says "compound", "capture the lessons", "update the rules from this session", or runs a `/compound` command.
- You are the `documenter` persona dispatched with a compound task by the agent-hub dispatcher.
- Periodically, as a **consolidation pass** over a rule tree that has accumulated additions (see Step 8).

**When NOT to use:** mid-task (finish the work first — compounding interrupts flow and the evidence isn't complete); after a trivial session with nothing corrected or discovered; to document what the code or git history already records.

## Where Evidence and Targets Live

**Evidence** — read what exists, skip what doesn't:

| Source | Where |
|--------|-------|
| Session conversation | User corrections, "no, do it this way", decisions, rejected approaches |
| Session diff | `git diff` / `git log` for the session's commits |
| agent-hub artifacts | `.pi/agent-sessions/artifacts/{returns,reviews,plans,inventories,evidence}/` — specialist returns and review findings |
| agent-hub assertion ledger | `.pi/agent-sessions/assertions.json` — which assertions failed first and why |
| Dispatch brief | A `/compound` dispatch carries a candidate-lessons brief composed by the dispatcher — treat it as *candidates*, not conclusions |

**Targets** — from `.ai/agent-fleet-overrides.md`, section `## agent-hub` (legacy `## agent-team`):

- `rules:` — repo-relative rule folders. Resolve index-first: a top-level `README.md`/`index.md` is the loading manifest and also the registry any new file must be added to.
- `docs:` — repo-relative documentation entry points.

If the keys are absent, look for an existing `.ai/rules/` or docs tree and confirm the target with the user. **Never invent a new rules/docs tree** for a project that doesn't have one — propose the lessons in your response instead and let the user decide where they live.

## Process

### 1. Gather evidence

Collect the sources above. List the session's concrete friction points: what was corrected, what failed review, what broke, what took disproportionate time to figure out.

### 2. Extract candidate lessons

A candidate lesson is one sentence naming a behavior change for future sessions. Strong signals, in descending order of value:

- **Repeated correction** — the user (or a reviewer) had to fix the same class of mistake more than once.
- **Wrong assumption** — an agent assumed X, the codebase does Y, and the mismatch cost rework.
- **Hidden constraint** — a convention, ordering, or invariant that exists only in someone's head and was violated.
- **Root cause** — a debugging session ended in "the real cause was Z" where Z will recur.
- **Missing WHAT/WHY** — the session changed architecture, commands, or structure that the docs still describe the old way.

One-off typos, task-specific facts, and anything a test now guards are not lessons.

### 3. Classify each candidate: rule, doc, or neither

- **Rule (HOW)** — a repeatable implementation constraint future work must comply with. Goes to the `rules:` tree.
- **Doc (WHAT/WHY)** — the codebase's shape or rationale changed and the docs are now stale. Goes to the `docs:` targets.
- **Neither** — the default. Drop it when: the code or tests now make the mistake impossible, git history already records it, it's specific to this one task, or it restates something the rules already say.

The bar for keeping: *would a future session, reading this line, act differently?* If not, drop it.

### 4. Dedupe and locate the target file

For every surviving lesson:

1. Resolve the rules tree index-first (read the `README.md`/`index.md` manifest, then the files it maps to the lesson's area).
2. Search the tree for existing coverage (`grep` for the key terms).
3. If a rule already covers it → either drop the lesson, or sharpen the existing rule *in place* if the session proved it too vague to prevent the mistake.
4. Otherwise pick the **existing** file whose scope contains the lesson. A new file is the exception, allowed only when no existing file's scope fits, and it must be registered in the tree's index in the same change.

### 5. Draft minimal diffs

Each lesson lands as the smallest edit that changes future behavior — typically 1–5 lines added to an existing section, matching the target file's format and style. In the *proposal* (Step 6), every lesson carries:

```
Lesson: <imperative, one sentence>
Target: <existing file + section>   (or: NEW FILE <path> + index update)
Why:    <the failure this prevents — one line>
Evidence: <what happened this session — one line>
Diff:   <the exact lines to add/change>
```

`Why` and `Evidence` are mandatory in the proposal so the human can judge value. In the landed text, follow the target file's house style — include the why when the format has room for it; do not stamp session dates into curated rule files unless the project already does that.

**Caps per pass:** at most **5 lessons**, at most **1 new file**. More candidates than the cap → keep the highest-value ones and say what was dropped.

### 6. Propose — the approval gate

Present the drafted lessons (format above) and wait for approval before writing. The human filters: they know which corrections were preferences of the moment versus durable policy. Skip the gate only when the user has explicitly pre-authorized applying ("compound and apply", a standing instruction, or a dispatch that says so) — and even then, report exactly what was written.

### 7. Apply and verify

Apply the approved diffs. Then check: every touched file still parses/renders, internal links resolve, any new file is reachable from the tree's index, no duplicated content was introduced, and the caps were respected. Report the landed changes as a file-by-file list.

### 8. Consolidation pass (periodic)

Compounding adds; nothing else subtracts. Every ~10 sessions, or when a rules dir noticeably bloats, run this skill in reverse: read the whole tree, merge near-duplicate rules, delete rules the codebase now enforces mechanically (lint, types, tests), and verify each survivor against the current code before keeping it. Stale rules are worse than no rules — agents comply with them faithfully.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "This lesson is obviously worth keeping — no need to check for duplicates" | Duplicate rules are how trees rot. The grep in Step 4 costs seconds; a contradicting near-duplicate costs every future session. |
| "It deserves its own file — cleaner than editing an existing one" | New files skip the index, fragment discovery, and grow the tree. The lesson belongs in the file whose scope already covers it. |
| "More lessons captured = more value" | Five sharp rules get followed; twenty generic ones get skimmed. Past the cap, you are diluting the tree, not enriching it. |
| "I'll apply directly — asking for approval is friction" | The human knows which corrections were one-off preferences. Unapproved rule writes turn a preference of the moment into permanent policy. |
| "The session went fine, but I should still write something" | No friction, no lesson. Compounding a smooth session produces filler that buries the real rules. |
| "The code changed, but updating the docs is a separate task" | Stale WHAT/WHY docs mislead every future session. If the session invalidated a doc, the doc update is part of this pass. |
| "This project has no rules tree — I'll create one" | Inventing structure is the project owner's call. Propose the lessons and the location; let them decide. |

## Red Flags

- A compound pass that only ever *adds* — no lesson was dropped, no existing rule sharpened instead.
- Rules written from memory of the session instead of from the evidence sources.
- A lesson without a concrete failure behind it ("agents should be careful with X").
- New files created without an index update, or a pass that exceeds the 5-lesson / 1-new-file caps.
- Session-specific detail (task names, ticket numbers, dates) baked into curated rule text.
- Writing into `rules:`/`docs:` targets that came from guesswork rather than the overrides file or the user.

## Verification

Before reporting the pass complete:

- [ ] Every landed lesson traces to named session evidence (correction, finding, root cause).
- [ ] Every candidate was grepped against the existing tree; duplicates were dropped or merged in place.
- [ ] Each diff is minimal, matches the target file's style, and lands in an existing file (or the one allowed new file, registered in the index).
- [ ] The proposal gate ran — or explicit pre-authorization to apply is on record.
- [ ] Caps respected: ≤ 5 lessons, ≤ 1 new file.
- [ ] Touched docs/rules still render, links resolve, and the final response lists every file changed.
