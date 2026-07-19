# Agent Personas

Specialist personas that play a single role with a single perspective. Each persona is a Markdown file consumed as a system prompt by your harness (Claude Code, OpenCode, or pi). The canonical file is pi-flavored; `transform-persona` rewrites it per target harness on install.

## The full roster

| Persona | Role | Access | Primary skill | Agents |
|---|---|---|---|---|
| [planner](../agents/planner.md) | Architect — writes dependency-ordered PLAN files with acceptance criteria | rw (plan file only) | [planning-and-task-breakdown](../skills/planning-and-task-breakdown/SKILL.md) | all |
| [plan-reviewer](../agents/plan-reviewer.md) | Plan critic — stress-tests plans for gaps, ordering, feasibility | read-only | [planning-and-task-breakdown](../skills/planning-and-task-breakdown/SKILL.md) | all |
| [builder](../agents/builder.md) | Implementer — lands changes in small verifiable increments | rw | [incremental-implementation](../skills/incremental-implementation/SKILL.md) | all |
| [code-reviewer](../agents/code-reviewer.md) | Senior staff engineer — five-axis review before merge | read-only | [code-review-and-quality](../skills/code-review-and-quality/SKILL.md) | all |
| [test-engineer](../agents/test-engineer.md) | QA — test strategy, coverage analysis, the Prove-It pattern | rw | [test-driven-development](../vendor/agent-skills-upstream/skills/test-driven-development/SKILL.md) | all |
| [security-auditor](../agents/security-auditor.md) | Security engineer — vulnerability detection, threat modeling, OWASP | read-only | [security-and-hardening](../skills/security-and-hardening/SKILL.md) | all |
| [web-performance-auditor](../agents/web-performance-auditor.md) | Web performance engineer — Core Web Vitals, loading, rendering, network audits (via `/webperf`) | read-only | [performance-optimization](../skills/performance-optimization/SKILL.md) | all |
| [documenter](../agents/documenter.md) | Tech writer — READMEs, inline docs, usage examples | rw | [documentation-and-adrs](../vendor/agent-skills-upstream/skills/documentation-and-adrs/SKILL.md) | all |
| [architect](../agents/architect.md) | System architect — design decisions and migration strategy | rw | [api-and-interface-design](../vendor/agent-skills-upstream/skills/api-and-interface-design/SKILL.md) | all |
| [releaser](../agents/releaser.md) | Release owner — changeset → version-bump → tag flow | rw | [git-workflow-and-versioning](../skills/git-workflow-and-versioning/SKILL.md), [shipping-and-launch](../vendor/agent-skills-upstream/skills/shipping-and-launch/SKILL.md) | all |
| [researcher](../agents/researcher.md) | Fast read-only recon — reports findings with file:line citations | read-only | — | all |
| [deep-researcher](../agents/deep-researcher.md) | Deep recon for hard, cross-cutting questions | read-only | — | all |
| [bowser](../agents/bowser.md) | Headless browser automation via Playwright CLI | rw | — | pi only |
| [web-debugger](../agents/web-debugger.md) | Interactive headful Chrome debugging via Chrome DevTools MCP (coms peer) | rw | [browser-testing-with-devtools](../skills/browser-testing-with-devtools/SKILL.md) | pi only |
| [orchestrator](../agents/orchestrator.md) | Verification-Contract agent-hub dispatcher — owns acceptance assertions, parity inventory, runtime-proof gate | — | [orchestration-verification](../skills/orchestration-verification/SKILL.md) | pi only |

## How personas connect to skills

Personas are the *who*, skills are the *how*. Each working persona carries a conditional hook to its primary skill: if `skills/<skill-name>/SKILL.md` exists in the repo it is working on, the persona reads it before starting and follows its process and output format. Install the matching skill alongside the persona to get the full structured workflow — without it, the persona still works on its built-in rules. The research personas and `bowser` deliberately carry no skill hook (recon must stay lean; the orchestration prompt is built by agent-hub). The single `orchestrator` is the exception: it references [`orchestration-verification`](../skills/orchestration-verification/SKILL.md) for the acceptance-assertion, parity-inventory, and structured-return formats of the Verification Contract it enforces. Several personas also honour the per-project overrides in `.ai/agent-fleet-overrides.md` — e.g. `planner` writes its plan where `## planning-and-task-breakdown` says, and reviewers validate against the project's `rules:` folders.

## Installing personas

`/setup-agent-fleet` offers every persona available for the chosen agent and installs it to the right place, transforming the frontmatter deterministically (via `npx @chankov/agent-fleet transform-persona`):

| Agent | Installed to | Transformation |
|---|---|---|
| Claude Code | `.claude/agents/<name>.md` | tools renamed (`read→Read`, `find/ls→Glob`, …), model mapped to `opus`/`sonnet`/`haiku`, agent-hub keys dropped |
| OpenCode | `.opencode/agent/<name>.md` | `mode: subagent` added, write-capable tools denied per persona, agent-hub keys dropped |
| pi | `agents/<name>.md` | none — the canonical format is the pi format |

When the repo is installed as a Claude Code plugin, the `agents/` directory is auto-discovered — every non-pi-only persona is immediately available as a subagent without a separate install.

## Teams of subagents

The personas are designed to be composed, not used one at a time. For the full hub → team → agent → sub-agent picture, see [ARCHITECTURE.md](ARCHITECTURE.md#fleet-hierarchy).

- **pi (agent-hub harness)** — the dispatcher spawns personas as specialist agents on a named team from [.pi/agents/teams.yaml](../.pi/agents/teams.yaml): `default` (plan → build → review → document), `debug`, `frontend`, `security`, `hotfix`, `release`, `info`. `just team-up <name>` instead spawns [peers.yaml](../.pi/agents/peers.yaml) personas (e.g. `architect`, `releaser`) as standalone, addressable peers in a tiled [herdr](https://herdr.dev) workspace (requires a running herdr server). Personas with a `subagents:` block (e.g. `code-reviewer`'s `preflight`/`quality`/`perf`/`docs`) additionally delegate slices of their own job to pre-configured children.
- **Claude Code** — installed personas are native subagents: the main agent delegates to them automatically based on their `description`, or you invoke one explicitly ("use the code-reviewer subagent on this diff"). Chain them along the lifecycle: `/plan` work goes to `planner`, then `plan-reviewer` critiques, `builder` implements, and `code-reviewer` + `security-auditor` gate the merge. `/orchestrate` runs a config-defined roster (see `.claude/orchestrate-teams.yaml`).
- **OpenCode** — installed personas are subagents (`mode: subagent`): mention one with `@<name>` to invoke it directly, or let the primary agent delegate to it by description. `/af-orchestrate` mirrors the Claude Code roster pattern.

## How personas relate to skills and commands

Three layers, each with a distinct job:

| Layer | What it is | Example | Composition role |
|-------|-----------|---------|------------------|
| **Skill** | A workflow with steps and exit criteria | `code-review-and-quality` | The *how* — invoked from inside a persona or command |
| **Persona** | A role with a perspective and an output format | `code-reviewer` | The *who* — adopts a viewpoint, produces a report |
| **Command** | A user-facing entry point | `/review`, `/ship` | The *when* — composes personas and skills |

The user (or a slash command) is the orchestrator. **Personas do not call other personas.** Skills are mandatory hops inside a persona's workflow.

## When to use each

### Direct persona invocation
Pick this when you want one perspective on the current change and the user is in the loop.

- "Review this PR" → invoke `code-reviewer` directly
- "Are there security issues in `auth.ts`?" → invoke `security-auditor` directly
- "What tests are missing for the checkout flow?" → invoke `test-engineer` directly
- "Audit Core Web Vitals on the product page" → invoke `web-performance-auditor` directly

### Slash command (single persona behind it)
Pick this when there's a repeatable workflow you'd otherwise re-explain every time.

- `/review` → wraps `code-reviewer` with the project's review skill
- `/test` → wraps `test-engineer` with TDD skill
- `/webperf` → wraps `web-performance-auditor` for performance-focused audits on web apps

### Slash command (orchestrator — fan-out)
Pick this only when **independent** investigations can run in parallel and produce reports that a single agent then merges.

- `/ship` → fans out to `code-reviewer` + `security-auditor` + `test-engineer` in parallel, then synthesizes their reports into a go/no-go decision

On Claude Code and OpenCode, this fan-out is the endorsed in-harness orchestration pattern. On pi, the `agent-hub` harness adds a dispatcher model: the dedicated `orchestrator` persona spawns specialist subagents under a Verification Contract (see [CLAUDE.md](../CLAUDE.md) and the [agent-hub harness](../.pi/harnesses/agent-hub/)). The `/orchestrate` command mirrors a constrained version for Claude Code and OpenCode. See [references/orchestration-patterns.md](../references/orchestration-patterns.md) for the full pattern catalog and anti-patterns.

## Decision matrix

```
Is the work a single perspective on a single artifact?
├── Yes → Direct persona invocation
└── No  → Are the sub-tasks independent (no shared mutable state, no ordering)?
         ├── Yes → Slash command with parallel fan-out (e.g. /ship)
         └── No  → Sequential slash commands run by the user (/spec → /plan → /build → /test → /review)
```

## Worked example: valid orchestration

`/ship` is the canonical fan-out orchestrator in this repo:

```
/ship
  ├── (parallel) code-reviewer    → review report
  ├── (parallel) security-auditor → audit report
  └── (parallel) test-engineer    → coverage report
                  ↓
        merge phase (main agent)
                  ↓
        go/no-go decision + rollback plan
```

Why this works:
- Each sub-agent operates on the same diff but produces a **different perspective**
- They have no dependencies on each other → genuine parallelism, real wall-clock savings
- Each runs in a fresh context window → main session stays uncluttered
- The merge step is small and benefits from full context, so it stays in the main agent

## Worked example: invalid orchestration (do not build this)

A `meta-orchestrator` persona whose job is "decide which other persona to call":

```
/work-on-pr → meta-orchestrator
                  ↓ (decides "this needs a review")
              code-reviewer
                  ↓ (returns)
              meta-orchestrator (paraphrases result)
                  ↓
              user
```

Why this fails:
- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + 2× token cost
- The user already knows they want a review; let them call `/review` directly
- Replicates work that slash commands and `AGENTS.md` intent-mapping already do

## Rules for personas

1. A persona is a single role with a single output format. If you find yourself adding a second role, create a second persona.
2. **Personas do not invoke other personas.** Composition is the job of slash commands or the user. On Claude Code this is also a hard platform constraint — *"subagents cannot spawn other subagents"* — so the rule is enforced for you. The one exception is pi's `agent-hub` harness, where the dedicated `orchestrator` persona dispatches specialists; that dispatch lives in the harness, not in a peer persona calling another.
3. A persona may invoke skills (the *how*).
4. Every persona file ends with a "Composition" block stating where it fits.

## Harness interop

On **OpenCode**, the same personas install as `mode: subagent` (invoke with `@<name>`); on **pi** they run under the `agent-hub` harness. The rest of this section is Claude Code-specific.

The personas in this repo are designed to work as Claude Code subagents and as Agent Teams teammates without modification:

- **As subagents:** auto-discovered when this plugin is enabled (no path config needed). Use the Agent tool with `subagent_type: code-reviewer` (or `security-auditor`, `test-engineer`). `/ship` is the canonical example.
- **As Agent Teams teammates** (experimental, requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`): reference the same persona name when spawning a teammate. The persona's body is **appended to** the teammate's system prompt as additional instructions (not a replacement), so your persona text sits on top of the team-coordination instructions the lead installs (SendMessage, task-list tools, etc.).

Subagents only report results back to the main agent. Agent Teams let teammates message each other directly. Use subagents when reports are enough; use Agent Teams when sub-agents need to challenge each other's findings (e.g. competing-hypothesis debugging). See [references/orchestration-patterns.md](../references/orchestration-patterns.md) for the full mapping.

Plugin agents do not support `hooks`, `mcpServers`, or `permissionMode` frontmatter — those fields are silently ignored. Avoid relying on them when authoring new personas here.

## Adding a new persona

1. Create `agents/<role>.md` with the same frontmatter format used by existing personas.
2. Define the role, scope, output format, and rules.
3. Add a **Composition** block at the bottom (Invoke directly when / Invoke via / Do not invoke from another persona).
4. Add the persona to the table at the top of this file.
5. If the persona enables a new orchestration pattern, document it in `references/orchestration-patterns.md` rather than inventing the pattern in the persona file itself.
