# Deterministic Workflows

Agent Fleet provides a code-owned, headless workflow layer beside the interactive `agent-hub`. Workflow code fixes phase order, bounded retries, executable gates, permissions, and acceptance; agents are used only for phases that require judgment. Nothing in this layer changes `just fleet`.

## Run a flow

```bash
just flow quality
just flow scout "where is authentication configured?"
just flow build-test "add the validated endpoint"
just flow document
```

The raw entry point is equivalent and loads `.env` itself:

```bash
node --experimental-strip-types scripts/flow.ts quality
```

Options:

- `--dry-run` executes the full graph with valid stub agent envelopes and no model calls.
- `--run-id <id>` assigns a trace id.
- `--allow-dirty` explicitly bypasses the normal clean-tree refusal.

Exit codes are `0` accepted, `1` failed/unaccepted, `2` invalid arguments or unknown flow, and `3` startup refusal. SIGINT/SIGTERM finalize the run trace and return `128 + signal`.

## Shipped flows

| Flow | Shape | Purpose |
| --- | --- | --- |
| `quality` | `engineer(request) → code(quality)` | Run configured quality evidence without an agent. |
| `scout` | `engineer(request) → agent(scout)` | Read-only repository reconnaissance. |
| `build-test` | `engineer(request) → agent(builder) → code(test) → agent(builder-fix, bounded) → code(commit)` | Build, deterministically test, repair within a bound, then commit once. |
| `document` | `code(changes) → agent(documenter) → code(commit)` | Capture changes deterministically, document them, gate files, then commit. |

## Quality configuration

Quality blocks require a non-empty `quality:` command in `## workflows` in `.ai/agent-fleet-overrides.md`; there is **no implicit `npm test` fallback**. A missing override, missing `## workflows` section, or empty `quality:` value is a startup refusal (exit `3`), rather than a fake green command. The value is split into argv using simple shell-style quotes, inherits the operator environment, and runs without a shell.

```markdown
## workflows
quality: npm test
```

The runtime currently uses its 1,800-second default timeout; `timeout-seconds:` and JSON-array values are not workflow configuration keys. Command output is stored in `.pi/flow-sessions/<runId>/command.log`. A missing executable produces exit `127` and its actual diagnostic.

## Safety and evidence

Normal runs require a clean tree and create `flow/<name>-<runId>`. Every agent phase must receive an explicit writes policy from persona frontmatter or its call site; a missing policy is refused before spawn rather than silently treated as unrestricted. `writes: []` is repository read-only, and a non-empty list is an allowlist. Agent writes are checked after each phase against that policy and workflow `protectedGlobs`. `protectedGlobs` reject a path only when no `writes` glob matches it, so `writes: ["**"]` also permits a protected path. `*` stays within one path segment; `**` crosses directories. Out-of-policy changes introduced by the agent are rolled back and terminate the phase. Runtime reports remain writable even for repository-read-only agents. This enforcement exists only in flows; hub behavior is unchanged.

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
