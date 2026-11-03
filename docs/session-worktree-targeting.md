# Session-scoped Git worktree selection

Fleet can remain outside the application:

```text
root/                    # does not have to be a Git repository
  af/                    # Fleet installation, configuration, resources, evidence
  repo/                  # application's main checkout
  repo.worktree/         # already registered linked or detached checkout
  docs/                  # independent, shared documentation repository
```

## Launch

From `root/af`, after the usual setup of Fleet and its dependencies:

```sh
just fleet --worktree ../repo.worktree --dry-run
just fleet --worktree ../repo.worktree
just fleet --worktree ../repo --herdr --project example
just fleet --worktree ../repo.worktree --herdr --project example
just flow quality --worktree ../repo.worktree
```

Selector paths are relative to the Fleet workspace (`af`); when launching without
an inherited binding, this is the command's working directory. Optionally,
`--repository ../repo` explicitly verifies the owning main checkout. Selection is a startup
option, not a global active pointer. Fleet does not create, move, or remove worktrees;
the operator manages them with Git/Worktrunk. Without a selector, legacy mode is preserved.

`workspaceRoot` is `af`; `executionRoot` is the selected checkout. For a copy installation,
`resourceRoot` is also `af`; for a managed symlink installation, it is the physical
Fleet source root. Its identity is part of the binding, while human configuration remains in
`af`. Arbitrary resources outside these two verified roots are refused.
Agents, profiles, teams, overrides, guard policy, extensions, skills, and prompts
remain workspace-owned. Git and relative coding operations run in the target.
Target configuration does not replace Fleet configuration. The workspace's `AGENTS.md`
(or `CLAUDE.md`) is an explicitly supplied resource; automatic target-local discovery
is disabled. Project instructions are read as explicitly requested project data.

## Verification, resume, and refusals

In an interactive session, `/af-worktree status` and `/af-worktree verify` show the binding,
namespace, and configuration state. The base project is preserved, but the effective
project includes the physical target identity: matching peer names in two teams do not
connect them. Resume requires the same workspace and physical roots.
A removed/replaced target, mismatched history, or missing mandatory workspace
policy causes a refusal, not a fallback to main. After such a change, start
a new session with an explicit selector. There is no live target switch in an existing session.

Fleet evidence, peer snapshots, and workflow state are partitioned by target under `af`.
Interactive Pi history retains its standard global, cwd-scoped location;
its custom entries carry an immutable binding. Native specialists use
workspace-owned session artifacts. These different kinds of state are not permissions.

## System 1: separate consent for each consumer

Existing approval for main does not authorize source export from a worktree.
`/af-worktree-consent agenticAsk` shows the exact effective scope and requires fresh
interactive confirmation. Repeat separately for the desired consumers: `watchdog`,
`dispatch`, `proactiveReview`, `taskTriage`, `agenticAsk`, `fileDiscovery`,
`contextCompaction`, `damageGuard`. Restart after approval.

Approval does not enable a disabled consumer or change configuration, budgets,
model/provider, local bindings, or rule pins. A changed policy/config/scope requires
fresh approval. A scope that cannot be projected is refused. A scout snapshot is a separate physical
target and does not automatically inherit source-export approval from the original.
`needs_worktree_consent`, invalid/adaptation, and off are distinct from a verified helper
result. `providerChecked: false`/`applicabilityChecked: false` do not indicate successful
verification of the provider or local-rule applicability.

## Boundaries and optional integrations

- Shared docs are authorized through explicit workspace-relative read grants. This does not
  authorize writes; editing the shared docs repository requires separate task scope.
- Browser/MCP, STT, and remote clients retain their separate credentials/endpoints.
  A correct cwd does **not** mean separate browser profiles, frontend ports, API,
  database, or gateway. These destinations are not automatically rewritten.
- `/btw` and the targeted Hermes conductor refuse this combination; use guarded
  `dispatch_agent`, Hub, or a targeted Pi peer. The external Hermes conductor profile
  has no verified split-root resource contract. The legacy conductor is unchanged.
- `--all-extensions`, custom `--session-dir`, and worktree selectors for installation
  lifecycle commands are refused. Run setup/doctor/deps/uninstall from `af`.
- Preview does not perform live provider/browser/Herdr/gateway verification. A missing
  capability is a gap, not evidence of a working integration.

This provides verified operational routing and bounded guards, **not an OS sandbox** or
external-service isolation. Do not copy Fleet into the application worktree or replace
the root contract with arbitrary symlinks or just `cd`.

## Regression runtime

`npm run test:full` uses the project's Pi SDK from `devDependencies` (currently
1.1.0), not a version inferred from `PATH` or the Node executable's directory.
The separate interactive launcher may point to another installation.
`CONTEXT_CONTINUITY_PI_RUNTIME` is an explicit test-only override pointing to an SDK directory;
an invalid override is refused without silent fallback. This does not change production
runtime selection or permissions. SDK fixtures isolate inherited Fleet role,
root, and exemption metadata to test their own synthetic session.
