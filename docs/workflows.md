# Deterministic Workflows

Agent Fleet provides a code-owned, headless workflow layer beside the interactive `agent-hub`. Workflow code fixes phase order, bounded retries, executable gates, permissions, and acceptance; agents are used only for phases that require judgment. Nothing in this layer changes `just fleet`.

## Run a flow

```bash
just flow quality
just flow scout "where is authentication configured?"
just flow build-test "add the validated endpoint"
just flow document
just flow poll --panel default "should we extract this module?"
just flow debate --panel default --rounds 3 "should we extract this module?"
```

The raw entry point is equivalent and loads `.env` itself:

```bash
node --experimental-strip-types scripts/flow.ts quality
```

Options:

- `--dry-run` executes the full graph with valid stub agent envelopes and no model calls.
- `--run-id <id>` assigns a trace id.
- `--allow-dirty` explicitly bypasses the normal clean-tree refusal.
- `--panel <name>` selects a model panel from `.pi/agents/voices.yaml` (required for `poll` and `debate`).
- `--rounds <n>` sets debate rounds (default 3, minimum 2, maximum 5).
- `--apply` lets the poll integrator write the recommendation (lease-guarded). Debate refuses `--apply`.

Exit codes are `0` accepted, `1` failed/unaccepted, `2` invalid arguments or unknown flow, and `3` startup refusal. SIGINT/SIGTERM finalize the run trace and return `128 + signal`.

## Clean up and merge flow branches

Every run records its source branch and commit before creating `flow/<name>-<runId>`, then records whether the run was accepted or rejected. The reserved `cleanup` and `merge` subcommands use that metadata and [Worktrunk](https://worktrunk.dev) to manage completed branches.

List branches and open the numbered prompt in a terminal:

```bash
just flow cleanup
```

Example output:

```text
Flow branches:
  1. flow/scout-scout-demo  accepted  clean  ↑0 ↓0  target: main
  2. flow/build-test-api-42  accepted  clean  ↑1 ↓0  target: feature/api

Select with a number or full branch name.
Clean up which flow branch?
```

Select by the displayed number or by its stable full name:

```bash
just flow cleanup 1
just flow cleanup flow/scout-scout-demo
```

Normal cleanup calls `wt remove` without force. Worktrunk removes only clean work that is empty or already integrated; otherwise the command fails and keeps the branch. To intentionally discard a clean but unmerged branch, make that destructive intent explicit:

```bash
just flow cleanup 2 --discard
```

The wrapper never passes Worktrunk's worktree `--force` flag: a dirty worktree must be committed or stashed manually. In non-interactive automation, listing without a selector only prints options; a selected mutation also requires `--yes`:

```bash
just flow cleanup flow/scout-scout-demo --yes
```

Merge presents the same selector:

```bash
just flow merge
just flow merge 2
```

Only an accepted run with a clean worktree can merge. The command invokes Worktrunk's standard `wt merge <target>` pipeline: squash to one commit, rebase onto the recorded source branch when necessary, run configured hooks, fast-forward the target, then remove the flow worktree and branch. If a selected branch is not checked out, Worktrunk first materializes its worktree. Old flow branches without source metadata require an explicit local target rather than a guess:

```bash
just flow merge flow/build-test-api-42 --target feature/api
```

Maintenance does not fetch remotes and does not delete `.pi/flow-sessions/<runId>`; traces remain as local execution evidence. `cleanup` and `merge` are reserved maintenance names and cannot be generated as workflow names.

## Shipped flows

| Flow | Shape | Purpose |
| --- | --- | --- |
| `quality` | `engineer(request) → code(quality)` | Run configured quality evidence without an agent. |
| `scout` | `engineer(request) → agent(scout)` | Read-only repository reconnaissance. |
| `build-test` | `engineer(request) → agent(builder) → code(test) → agent(builder-fix, bounded) → code(commit)` | Build, deterministically test, repair within a bound, then commit once. |
| `document` | `code(changes) → agent(documenter) → code(commit)` | Capture changes deterministically, document them, gate files, then commit. |
| `poll` | `engineer(request) → agent×N(poll, parallel) → code(collect) → agent(merge)` | Same question to every voice in a named model panel; integrator merge. Optional `--apply` writes only in merge, behind a cross-process writer lease. |
| `debate` | `engineer(request) → [agent×N(debate) → code(collect)]×rounds` | Same panel, 2–5 harness-mediated rounds. Voices stay read-only; there is no judge. |

## Quality configuration

Quality blocks require a non-empty `quality:` command in `## workflows` in `.ai/agent-fleet-overrides.md`; there is **no implicit `npm test` fallback**. A missing override, missing `## workflows` section, or empty `quality:` value is a startup refusal (exit `3`), rather than a fake green command. The value is split into argv using simple shell-style quotes, inherits the operator environment, and runs without a shell.

```markdown
## workflows
quality: npm test
```

The runtime currently uses its 1,800-second default timeout; `timeout-seconds:` and JSON-array values are not workflow configuration keys. Command output is stored in `.pi/flow-sessions/<runId>/command.log`. A missing executable produces exit `127` and its actual diagnostic.

## Safety and evidence

Normal runs require a clean tree and create `flow/<name>-<runId>`. The branch stores its source branch, source commit, flow name, run id, and final acceptance as local Git metadata so maintenance can merge back without guessing. Every agent phase must receive an explicit writes policy from persona frontmatter or its call site; a missing policy is refused before spawn rather than silently treated as unrestricted. `writes: []` is repository read-only, and a non-empty list is an allowlist. Agent writes are checked after each phase against that policy and workflow `protectedGlobs`. `protectedGlobs` reject a path only when no `writes` glob matches it, so `writes: ["**"]` also permits a protected path. `*` stays within one path segment; `**` crosses directories. Out-of-policy changes introduced by the agent are rolled back and terminate the phase. Runtime reports remain writable even for repository-read-only agents. This enforcement exists only in flows; hub behavior is unchanged.

Every run writes JSONL under `.pi/flow-sessions/<runId>/trace.jsonl`; this directory is gitignored and separate from hub sessions. Phase success and work acceptance are separate. `run.finish()` produces the exit code, final trace status, and banner from one decision so they cannot disagree.

Agent reports use TypeBox envelopes built on the existing return-contract vocabulary. Invalid reports are corrected in the same Pi session with exact field errors. Executable gates inspect artifacts, sizes, JSON, changed-file claims, real test commands, and review-verdict consistency. Permission breaches are terminal rather than correctable.

## Author a workflow

Invoke the `drafting-workflows` skill. It first reads this map, lists available `wf-*.ts` shapes one per line, and waits. After the operator supplies intent, use the deterministic generator:

```bash
node --experimental-strip-types skills/drafting-workflows/scripts/make-workflow.ts \
  plan-build-review 'agent(plan) → agent(build) → agent(review)'
```

The generator copies the nearest complete workflow, preserves commas inside parenthesized phase annotations, replaces its phase docstring block, and renames the workflow and optional preflight symbols to the unique camel-cased identity derived from the new filename (for example, `planBuildReviewWorkflow`). Built-in flows are listed in `scripts/flow.ts`; a non-built-in `wf-<name>.ts` is resolved on demand by that same export convention, making a generated draft reachable through `just flow <name>` without editing the built-in map. TODOs remain only for gate, retry, and acceptance judgments. The generator refuses to return a draft unless both of these pass:

```bash
npx tsc -p scripts/workflows/tsconfig.json --noEmit
node --experimental-strip-types skills/drafting-workflows/scripts/make-workflow.ts \
  --verify-draft scripts/workflows/wf-plan-build-review.ts
```

The scoped TypeScript project checks workflow production sources only; the dry-run resolves the same exact export convention as `just flow`; workflow imports cross into hub seams through typed dynamic imports, so neither check makes `.pi/harnesses/**` part of the typecheck. See [workflow-authoring.md](../references/workflow-authoring.md) for envelopes, correction, gates, permissions, quality, change capture, dry-run, and packaging contracts.

## Architecture boundary

`just flow` directly composes `scripts/workflows/lib/` with the clean `spawnPiAgent` and context seams. It does not call `dispatch-native.ts`, use the hub ledger as acceptance, or change hub scope semantics. `just fleet`, coms peers, Herdr, Hermes, budgets, and the Fleet Dashboard continue to operate as before.

## Future `run_flow` tool (D8, design only)

A future hub tool may call the exported flow dispatcher module directly with validated arguments. It must never shell through `just`, and it must preserve clean-tree checks, cancellation, trace finalization, permission enforcement, and exact acceptance semantics. This release intentionally registers no `run_flow` tool and modifies no hub implementation; budgeting and cancellation ownership require a separate design/implementation cycle.
