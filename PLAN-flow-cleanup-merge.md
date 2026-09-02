# Flow branch cleanup and merge plan

## Goal

Add safe lifecycle commands for branches created by `just flow`, using Worktrunk for removal and squash-merge operations while preserving flow acceptance evidence and the branch from which each run started.

## Decisions

- Public syntax is subcommand-based: `just flow cleanup [number|branch]` and `just flow merge [number|branch]`.
- With no selector, an interactive terminal presents a numbered selector; non-interactive use prints the same numbered list and exits without mutation.
- `merge` uses Worktrunk's default squash/rebase/fast-forward pipeline and removes the flow branch/worktree only after success.
- Normal cleanup is loss-averse: Worktrunk may remove only empty or already-integrated work. Explicit `--discard` permits deletion of an unmerged branch, but never silently removes a dirty worktree.
- New runs record their source branch and source commit. Merge targets that recorded source branch; old runs without metadata require `--target` rather than guessing.
- Flow traces remain under `.pi/flow-sessions/` after branch cleanup as local execution evidence.

## Dependency-ordered implementation

1. **Persist flow branch metadata.** Capture source branch/commit before branch creation, write branch-local Git configuration, and record the final accepted/rejected result.
   - Acceptance: metadata survives switching away from the flow branch and tests cover accepted and rejected results.
2. **Parse maintenance commands.** Add typed parsing for `cleanup` and `merge`, numeric or full branch selectors, `--target`, `--discard`, and `--yes` without changing normal workflow argument parsing.
   - Acceptance: invalid combinations and unsafe selectors return the existing invalid-argument exit code (`2`).
3. **Build the selector/read model.** Enumerate only local `flow/*` branches in deterministic newest-first order and display run status, dirty state, target, commit relation, and stable branch name.
   - Acceptance: TTY use can select by number; non-TTY use prints options; exact branch names remain valid if ordering changes.
4. **Implement safe cleanup through Worktrunk.** Refuse dirty worktrees, invoke `wt remove` without force for normal cleanup, and require explicit `--discard` before adding `-D` for unmerged work.
   - Acceptance: no path uses Worktrunk's worktree force flag; failures retain the branch and return non-zero.
5. **Implement squash merge through Worktrunk.** Require an accepted run, a clean source worktree, and a known local target; materialize a Worktrunk worktree when the selected branch is not checked out; invoke standard `wt merge <target>` and let Worktrunk remove the source after success.
   - Acceptance: rejected/unknown runs, dirty trees, missing targets, and missing Worktrunk are refused before merge.
6. **Document operations.** Update the workflow guide and command guide with selector, cleanup, merge, explicit target, discard, and safety examples.
7. **Verify.** Run scoped TypeScript checking, targeted maintenance/Git/CLI tests, the complete new workflow test set, manifest validation, documentation link checks, and package dry-run.

## Out of scope

- Automatically deleting flow traces.
- Force-removing dirty worktrees.
- Fetching or merging remote targets.
- Changing every flow run to execute in a dedicated Worktrunk worktree; maintenance may materialize one only when merge needs it.
- Registering a hub `run_flow` tool.
