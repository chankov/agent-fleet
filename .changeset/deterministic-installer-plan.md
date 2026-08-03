---
"@chankov/agent-fleet": minor
---

Add the deterministic installer's planner and the upgrade three-way merge (Phases 3 and 5 of `plans/deterministic-installer.md`).

- **`agent-fleet install --profile <name> --dry-run`** — resolves a selection (profiles ∪ explicit item ids, closed over `requires` and `companions`) against the workspace and prints the exact action list: what would be created, refreshed, repaired, kept, or skipped, in an order where every requirement precedes the item that needs it. A selection never removes anything; a narrower profile keeps what is already installed.
- **`agent-fleet upgrade --dry-run`** — plans an upgrade of what the workspace already has, using the `.versions/<recorded>` snapshot as the merge base. An untouched file that moved upstream is refreshed; a locally modified file whose source did not move is preserved; a file changed in both places is reported as a conflict and never resolved by guessing. `--accept-theirs` / `--accept-ours` resolve conflicts non-interactively, and an artifact retired upstream is proposed for removal by name.
- **Consent classes are enforced at plan time.** `exec` items are skipped unless `--allow-exec` is passed, and `external` / `operator` items are reported as steps the engine will never perform.
- Exit codes: `0` clean, `1` could not plan, `3` conflicts needing a decision.

`plan()` reads the filesystem and writes nothing; `verify` and both new verbs now share one workspace evaluation (`evaluateWorkspace`), so they cannot disagree about a file's state. Golden plans for a fresh `pi` / `claude-code` / `opencode` workspace are committed, so a change to the recommended set shows up as a reviewed diff.

Applying a plan lands with the apply engine in Phase 4; until then both verbs require `--dry-run` and refuse to run without it. `init`, `doctor`, `update`, `verify`, and the guided setup skill are unchanged.
