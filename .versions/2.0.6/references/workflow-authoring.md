# Workflow Authoring Reference

## Purpose

This is the deep contract for deterministic workflows launched by `just flow`.
It complements the procedural `drafting-workflows` skill.
A workflow is code-owned orchestration: code fixes order, retries, permissions, gates, and acceptance.
Agents appear only at phases that require judgment.
The interactive `just fleet` hub remains independent and unchanged.

## Public contract

The only public recipe is:

```text
just flow <name> [args] [--allow-dirty] [--run-id <id>] [--dry-run]
```

The equivalent raw entry point is:

```text
node --experimental-strip-types scripts/flow.ts <name> [args]
```

The script loads the repository `.env` without replacing variables already present in `process.env`.
The command is headless, has no TUI, and requires no human interaction after launch.
Exit `0` means accepted.
Exit `1` means a phase failed or the completed work was not accepted.
Exit `2` means invalid arguments or an unknown flow.
Exit `3` means startup was refused before side effects.
Signals finalize the trace and use the conventional `128 + signal` exit code.

## Startup safety

A normal run requires a clean working tree.
`--allow-dirty` is the explicit exception.
All refusal checks run before trace creation or branch creation.
A run creates `flow/<name>-<runId>` from the current HEAD.
The repository baseline is captured before an agent can write.
Runtime files live under `.pi/flow-sessions/<runId>/`.
That runtime directory is gitignored and never shares hub session storage.
The trace records pid and command before the first phase.

## Phase primitive

Every phase declares:

- `name`: stable machine-readable phase name;
- `kind`: `engineer`, `agent`, or `code`;
- `owner`: operator, persona, or deterministic subsystem;
- `description`: one sentence explaining why the phase exists;
- `retries`: optional bounded correction rounds.

A description cannot be empty.
A description cannot merely reformat the phase name.
A phase starts with `status: "fail"`.
A clean return changes it to `success`.
A thrown error leaves it failed and propagates.
A failed phase finalizes the run as failed.
Phase success says the phase body executed correctly; it does not imply acceptance.

## Kinds and ownership

Use `engineer` for operator-owned input or decisions already supplied to the run.
Use `agent` only where interpretation or implementation judgment is required.
Use `code` for known commands, git calculations, validation, commits, and other deterministic work.
Do not dispatch an agent to rediscover `npm test`.
Do not hide a judgment call in a code phase.
Keep phase order visible in the `/** Phases: ... */` docstring.
The docstring is the generator's shape map and must match runtime order.

## Finish and acceptance

Call `run.finish()` exactly once.
Pass `accepted: true` only when the workflow's explicit acceptance rule is satisfied.
Pass a reason when acceptance is false.
`finish()` owns the exit code, final trace status, and terminal banner together.
No caller may calculate those three results independently.
A red quality command may be a successfully executed code phase while making the run unaccepted.
A second `finish()` call is an error.

## Trace semantics

The JSONL trace contains `run_start`, `phase_start`, `phase_end`, `log`, `error`, `gate_report`, `agent_process`, and `run_end` evidence.
Each event carries timestamp and run id.
Phase descriptions are the durable intent shown in traces.
Do not put credentials or complete model transcripts in trace data.
Command logs and agent session files belong below the run directory.
An interrupted run must not remain marked `running`.

## Agent phase construction

Resolve personas through the existing agent scanner.
Use the persona model, fallback model, thinking level, tools, system prompt, and additive `writes` declaration.
Build a replacement specialist prompt and context manifest.
Do not inherit the hub prompt.
Spawn through `spawnPiAgentWithModelFallback` with detached process-group ownership.
Load `damage-control-continue` for the child.
Keep the tool watchdog and whole-turn deadline enabled.
Store each persona session at `.pi/flow-sessions/<runId>/<agentKey>/session.json`.
Resume the same session for corrections.
Recycle before spawn when projected prompt use exceeds the resolved context window.

## Typed envelopes

Schemas use TypeBox.
The base fields are `status`, `summary`, `artifacts`, and `notes_for_next_agent`.
Plan adds `commit_message`.
Build adds `changed_files` and `commit_message`.
Review adds `approved`, assertion status arrays, risks, and user decisions.
Scout adds `findings`.
Document adds `document_path`, `documented_files`, and `commit_message`.
All array and string fields are explicit; defaults are not a substitute for an emitted contract.
The existing hub return parser is the first parser, not the final validator.
TypeBox validation decides whether the flow envelope is acceptable.
Unexpected fields are refused.
A valid envelope with `status: "fail"` fails the phase.

## Envelope triad

For every agent phase, synchronize:

1. the TypeBox schema in `lib/envelopes.ts`;
2. the JSON example included in the phase prompt;
3. the `envelope:` name at the workflow call site.

`envelopes-triad.test.ts` guards this relationship.
A schema-only edit is incomplete.
A prompt-only edit is incomplete.
A call-site-only edit is incomplete.
Personas keep the shared return-contract vocabulary and need no flow-only rewrite.

## Correction loop

Invalid output is corrected in the same Pi session.
The correction names every missing or invalid field.
The agent re-emits only Report JSON.
JSON correction is bounded by `JSON_FIX_ATTEMPTS`.
Gate correction is separately bounded by the phase retry policy.
The hub's second-model return extractor is never used by flows.
Exhausted correction attempts fail the phase with the envelope type named.
A declared `status: "fail"` is terminal and is not negotiated into success.
Permission breaches are terminal and are never sent back as a correction prompt.

## Executable gates

A gate receives an envelope and the active run.
A `GateReport` records one check for every inspected item.
A green report must say what it checked.
`artifactsExist` stats each declared artifact and records its size.
`filesNonEmpty` requires a real size greater than zero.
`jsonParses` performs `JSON.parse` on declared JSON artifacts.
`diffMatchesClaims` checks every `changed_files` path on disk.
`testsPass(argv)` executes the argv without a shell and includes bounded red output.
`verdictConsistent` rejects approval with blocking findings.
It also rejects disapproval that names no problem.
Gates verify claims; they do not replace envelope validation.

## Writes boundary

Persona `writes` is additive frontmatter and remains ignored by the hub.
A flow agent phase must have either persona `writes` or an explicit call-site permission policy; omission is refused before spawn.
Use `writes: []` for repository read-only.
A non-empty list is an allowlist; use an explicit `writes: ["**"]` call-site policy when a workflow intentionally permits repository-wide changes.
Runtime session files are always writable.
`protectedGlobs` reject a path only when no `writes` glob matches it; therefore a broad `writes: ["**"]` policy also permits protected paths.
The glob implementation is owned by the workflow layer.
`*` does not cross `/`; `**` does.

Enforcement compares repository snapshots before and after an agent phase.
Snapshots include tracked numstat state and untracked files.
A path changed, created, deleted, or restored to HEAD is detected.
Changes introduced outside policy are rolled back and the phase fails.
A path already dirty before the run is not reconstructed or destroyed.
A dirty path restored by an agent is still reported as a change.
Clean-tree startup makes rollback safe in the normal case.
The hub's advisory scope behavior is not changed by this enforcement.

## Quality blocks

Quality configuration comes from `## workflows` in `.ai/agent-fleet-overrides.md`.
There is no fallback: the section must contain a non-empty `quality:` value (for example, `quality: npm test`) or startup refuses with an actionable exit-`3` error.
The value is split into argv with simple shell-style quote handling; it is not a JSON-array setting and is never run through a shell.
Bare executable names inherit the operator environment.
A missing executable returns a real `127` result and diagnostic.
Stdout and stderr are persisted to `command.log`.
The runtime currently uses its explicit 1,800-second default timeout; `timeout-seconds:` is not a supported workflow override.
`asEnvelope` lets repair logic consume deterministic quality output like reviewer evidence.
No placeholder command may manufacture a green result.

## Change capture

`resolveBase` records both the selected diff base and the reason.
When HEAD is ahead, capture the branch plus working tree.
When at base with dirty state, capture the uncommitted tree.
When at base and clean, fall back to `HEAD~1`.
Name untracked files explicitly because `git diff` omits them.
Bound diff text with `maxDiffLines`.
Record how many lines were hidden.
The reason belongs in the trace and in the documenter's context.

## Commit placement

Commit only after deterministic verification succeeds.
A build-test flow commits once after the suite is green.
An exhausted repair loop commits nothing.
A document flow commits only gated documentation.
Commit only changes introduced after the recorded baseline and allowed by persona policy.
The commit message comes from the validated envelope.
A no-change result is logged and is not an error.

## Dry-run semantics

`--dry-run` executes the entire graph.
Agent phases return fixed schema-valid envelopes.
Code phases skip external side effects and return representative green results.
Commit phases log that commit was skipped.
No model is called.
The same phase order, envelope parsing, and finish rule still execute.
Dry-run is an authoring gate, not a substitute for focused unit tests.

## Generator contract

`make-workflow.ts` reads every `wf-*.ts` phase docstring.
It classifies explicit `engineer(...)`, `agent(...)`, and `code(...)` kinds.
It parses separators only at parenthesis depth zero, so annotations such as `agent(builder-fix, bounded)` remain one phase.
It computes deterministic edit distance over the resulting phase-kind sequences.
Length difference participates in scoring after edit distance.
Workflow name breaks exact score ties.
The selected workflow is copied in full.
The phase docstring block is replaced and workflow/preflight symbols are renamed from the source identity to the unique camel-cased identity derived from the new file name.
For `wf-plan-build-review.ts`, the required entry is `planBuildReviewWorkflow` (and optional `planBuildReviewWorkflowPreflight`).
Built-in flows are listed in `scripts/flow.ts`; for a non-built-in name, the dispatcher discovers `wf-<name>.ts` on demand by this exact export convention. A successful draft is therefore immediately reachable through `just flow <name>` without editing the built-in map.
The generator never overwrites an existing workflow.

Generated TODOs are limited to actual judgment:

- executable gate selection;
- bounded retry policy;
- final acceptance semantics.

There are no TODOs for imports, exports, trace calls, envelopes, or dry-run boilerplate.
Before returning a path, the generator runs scoped TypeScript compilation.
It then resolves the generated workflow by the exact export convention used by the dispatcher and executes it with stubbed agent phases.
A failed typecheck deletes the draft.
A failed dry-run deletes the draft.
A successful handoff names both the generated file and copied source.

## Scoped TypeScript

`scripts/workflows/tsconfig.json` includes only workflow production TypeScript.
Workflow imports of hub seams cross typed dynamic boundaries so the compiler does not absorb the hub program.
Tests remain checked by Node's runtime test execution rather than expanding the scoped project.
The project emits nothing.
Node and TypeBox types are available through pinned development tooling.
No typecheck failure requires edits under `.pi/harnesses/**`.
The canonical command is:

```text
npx tsc -p scripts/workflows/tsconfig.json --noEmit
```

## Package and install surface

The npm package includes `scripts/flow.ts`, `scripts/lib/flow-command.ts`, `scripts/workflows/*.ts`, `scripts/workflows/lib/*.ts`, and the scoped tsconfig.
It also includes the complete `skills/` and `references/` trees. The installer maps the workflow guide to `.pi/agent-fleet/docs/workflows.md`, so the drafting skill, generator, authoring reference, and managed guide are packaged without adding product documentation to the target repository's `docs/` tree.
The install manifest is generated from `manifest-meta.json` and the repository tree.
Workflow runtime files use preserved repository-relative paths because the justfile recipe imports them there.
The drafting skill brings the authoring reference as a companion.
Never hand-edit `install-manifest.json`.
Run manifest validation and `pack:dry` before release.
The tarball must be inspected for every required surface, not merely for a successful npm exit code.

## `run_flow` design note (D8)

A future hub tool may call the same flow dispatcher module directly.
It must not shell through `just`.
It should pass validated arguments to the exported execution function and preserve the same exit, trace, startup, and signal semantics.
The hub tool will need an explicit budget and cancellation contract before implementation.
It must not bypass clean-tree or permission enforcement.
It must not translate flow acceptance into advisory assertion status.
`run_flow` is design-only in this release: no tool is registered and no hub file is changed.

## Author verification checklist

- Phase docstring equals runtime order.
- Every phase description explains why.
- Agent prompts preserve exact operator intent.
- Every agent call uses the intended envelope.
- Envelope triad tests pass.
- Gates perform real checks and report each item.
- Retry loops are bounded.
- Permission breaches terminate.
- Quality commands use argv and real exits.
- Acceptance is separate from phase success.
- `finish()` is called exactly once.
- Dry-run makes zero model calls.
- Scoped TypeScript passes.
- Focused workflow tests pass.
- Full repository tests pass.
- Manifest check passes.
- Package dry-run contains all workflow and authoring files.
- `.pi/flow-sessions/` remains ignored.
- `.pi/harnesses/**` remains unmodified.
