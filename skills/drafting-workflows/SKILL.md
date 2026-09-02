---
name: drafting-workflows
description: Drafts deterministic Agent Fleet workflows by adapting the nearest existing flow and proving the draft compiles and dry-runs. Use when creating or changing a `just flow` workflow or translating an operator request into agent phase prompts.
---

# Drafting Workflows

## Overview

Draft code-owned workflows by copying a proven flow shape, then edit only the decisions that actually require judgment. The operator owns intent; code owns phase order, retries, gates, permissions, and acceptance.

## When to Use

- Creating a new `scripts/workflows/wf-*.ts` flow.
- Changing a flow's phase order, gates, retries, or acceptance rule.
- Translating an operator request into a prompt for an agent phase.

Do not use this skill to improvise an interactive hub dispatch. `just fleet` remains a separate orchestration surface.

## Process

### 1. Map, list, and stop

Read the managed workflow map in `.pi/agent-fleet/docs/workflows.md`, then list every available `scripts/workflows/wf-*.ts` with exactly one line containing its name and `Phases:` shape. **Stop and wait for the operator to select or describe the desired flow.**

At this point:

- Do not open flow traces.
- Do not inventory the repository.
- Do not volunteer a dashboard or a guessed “current state.”

This discipline matters for three independent reasons: volunteered state is guessed state; reconnaissance spends context the real request will need; and a status dump is stale as soon as it is printed.

### 2. Preserve the request exactly

Translate the request into this four-line prompt:

```text
<the request — one imperative sentence, retaining their exact words wherever they were specific>
Where: <files/directories you actually checked>
Done means: <the observable outcome>
Out of scope: <the tempting addition you will not add>
```

**The intent is theirs. The precision is yours.** You may improve grammar, order, and verbosity. You may not silently omit a requirement, weaken a strong request (`rewrite` must not become `lightly refactor`), or invent an outcome.

Before running an agent phase, report the exact prompt you will send **verbatim**. Exact-prompt fidelity is evidence: a bad translation can be corrected before it reaches a commit phase.

### 3. Describe the phase shape

Write phases in execution order with explicit kinds, for example:

```text
agent(plan) → agent(build) → agent(review)
```

Use `engineer(...)` only for operator-owned input, `agent(...)` for judgment, and `code(...)` for known deterministic commands or repository calculations. A known test command is code, not an agent.

### 4. Generate from the nearest shape

Run:

```bash
node --experimental-strip-types skills/drafting-workflows/scripts/make-workflow.ts \
  <name> 'agent(plan) → agent(build) → agent(review)'
```

The generator reads `Phases:` docstrings, compares phase-kind sequences deterministically, and breaks ties by workflow name. Commas inside phase parentheses (for example `agent(builder-fix, bounded)`) remain part of that phase. It copies the nearest source in full, replaces the phase docstring block, and renames the workflow/preflight entry symbols to match the new file. It never overwrites an existing workflow.

Do not regenerate boilerplate from memory. Copying the entire nearest flow preserves imports, envelopes, explicit permission enforcement, gates, correction behavior, dry-run stubs, and finish semantics that a partial template can accidentally omit. The symbol rename is the sole identity change required to make `just flow <name>` discover the new module.

### 5. Resolve judgment-only TODOs

The draft marks only three classes of decisions:

- executable gates for claims that need repository evidence;
- bounded retry limits for safely correctable phases;
- the final acceptance condition, separate from phase completion.

Edit the copied phase bodies so the declared shape is real. Remove each TODO only after making that decision. Do not add TODOs for imports, envelope wiring, trace calls, dry-run stubs, or other boilerplate.

For the complete contracts, read `references/workflow-authoring.md`.

### 6. Keep the envelope triad synchronized

For every agent phase, keep these three sites identical:

1. the TypeBox schema in `lib/envelopes.ts`;
2. the JSON example emitted by the phase prompt;
3. the `envelope:` name at the workflow call site.

Use existing return-contract vocabulary. A parsed envelope with `status: "fail"` is a failed phase, not a successful parse.

### 7. Prove the draft before handoff

The generator refuses handoff unless both gates pass:

```bash
npx tsc -p scripts/workflows/tsconfig.json --noEmit
node --experimental-strip-types skills/drafting-workflows/scripts/make-workflow.ts \
  --verify-draft scripts/workflows/wf-<name>.ts
```

The second command resolves the exact `wf-<name>.ts` entry export used by the flow registry, then executes it with stubbed agent phases and `dryRun: true`; it makes no model call. If either gate fails, the generator deletes the draft and reports the exact failure. Repair the source decision or rerun the generator—never bypass either gate. A handed-off draft is immediately reachable as `just flow <name>`; no central registry edit is required.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| “I should inspect traces first so I understand the state.” | Volunteered state is guessed, costly, and immediately stale. Map, list, stop. |
| “The operator clearly meant a smaller refactor.” | Weakening the request changes intent. Preserve their exact strong wording. |
| “A fresh template is cleaner than copying.” | A template silently drops proven safety wiring. Copy the nearest whole flow. |
| “The TypeScript is obvious; dry-run is enough.” | Type and runtime gates catch different failures. Both are mandatory. |
| “This TODO is harmless boilerplate.” | Boilerplate TODOs shift syntax work back to the operator. TODOs are for judgment only. |
| “The phases passed, so acceptance is implied.” | Phase completion and accepted work are deliberately separate facts. |

## Red Flags

- Reporting repository or trace state before the operator asks for a flow.
- Sending a paraphrased prompt without showing its exact text.
- A phase docstring that does not match the implemented phase order.
- Shell command strings where an argv list is available.
- Agent phases used to rediscover a known test command.
- Unbounded correction loops or retries after a permission breach.
- An approved review with blocking findings.
- A draft handed off after only one of compile or dry-run succeeds.

## Verification

Before presenting a workflow draft, confirm:

- [ ] The workflow map was read, available flows were listed one per line, and work stopped for operator direction.
- [ ] The four-line phase prompt preserves every explicit requirement and was reported verbatim.
- [ ] The nearest existing flow was copied in full; only its phase docstring block was initially replaced.
- [ ] Every remaining `// TODO:` is a gate, retry-bound, or acceptance judgment.
- [ ] Implemented phase order matches the `Phases:` docstring.
- [ ] Envelope schema, JSON prompt example, and call-site name agree.
- [ ] Every agent phase has an explicit persona or call-site writes policy; omission is a startup error, never unrestricted by accident.
- [ ] Writes policy and protected paths are enforced around agent phases.
- [ ] The generated export is uniquely named for the file and resolves through `just flow <name>`.
- [ ] `npx tsc -p scripts/workflows/tsconfig.json --noEmit` passes.
- [ ] The generated workflow's stubbed dry run is accepted with zero model calls.
- [ ] The exact commands and outcomes are included in the handoff.
