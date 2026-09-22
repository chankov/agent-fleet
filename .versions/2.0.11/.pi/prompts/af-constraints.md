---
description: Establish or check the project's quality bar — write CONSTRAINTS.md and guard the diff against a lowered bar
---

Load and follow the `constraint-driven-development` skill before proceeding.

Two modes. Pick from the argument, defaulting to `setup` when none is given.

## `setup` — establish the bar

Run only with a live user; the interview is not valid in CI, a headless `just flow` run, or any autonomous loop. In those contexts apply the floor, say that you did, and leave the rest for a human.

1. **Detect before asking.** Read the stack, test runner, linters, CI, and — importantly — whether `.ai/agent-fleet-overrides.md` already defines `quality:` under `## workflows`. Report what you found in two lines.
2. **Ask the four questions**, one at a time, each with its default, so "I don't know" is a complete answer.
3. **Write `CONSTRAINTS.md`** at the repo root: the floor, the enforced dimensions with a number *and* a reason for each, what is measured but not yet enforced, and any exceptions with an owner and an expiry.
4. **Wire the executable gate.** Put the task-end command in `quality:` under `## workflows` in `.ai/agent-fleet-overrides.md`, and cite it from the `Checked by` column. `CONSTRAINTS.md` holds the reasoning; `quality:` is what `just flow` actually runs. They must not name different commands.
5. **Make it discoverable.** Add the pointer line to `.ai/agent-fleet-overrides.md`. Offer — do not perform unasked — the same line in a human-owned `AGENTS.md` or `CLAUDE.md`.

Confirm the dimensions and numbers with the user before writing anything.

## `check` — guard the bar

No interview. Run the Step 6 guard over the current diff and report what it finds:

1. A threshold moved — a budget lowered, a severity dropped, a check pulled out of the fast stage.
2. A test got easier — `.skip` added, a test file deleted, assertions removed from tests that stayed.
3. A checker got silenced — new `@ts-ignore`, `eslint-disable`, `istanbul ignore`, `Stryker disable`, `nosemgrep`, `gitleaks:allow`.
4. Work is unfinished — a stub that throws, an empty `catch`, a `TODO` where the implementation belongs.
5. An exception appeared — a new row in the Exceptions table nobody discussed.

Report the rule and the location, never a matched secret value. Tightening the bar is silent; loosening it is loud. Cite `file:line` for every finding.
