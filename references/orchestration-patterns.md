# Orchestration Patterns

Reference catalog of agent orchestration patterns this repo endorses, plus anti-patterns to avoid. Read this before adding a slash command or flow that coordinates several agents, or before proposing a new kind of assignment. This is the **composition layer**: which roles run, with which practices, and how they are wired. The runtime coordination protocols between already-running agents — sentinels, push events, barriers, fan-in digests, racing — are catalogued in [fleet-coordination-patterns.md](fleet-coordination-patterns.md).

In the Agent Hub, every delegated assignment is one of three roles — `researcher`, `reviewer`, `editor` — with practices that add method and expected evidence, never authority. The catalogue is [docs/agents.md](../docs/agents.md).

The governing rule: **the Hub operator, a deterministic flow or the user composes the work. Roles do not dispatch other roles** (the older wording of this rule: personas do not invoke other personas). Skills are mandatory hops inside an assignment, loaded through its practices.

---

## Endorsed patterns

### 1. Direct work or one assignment (no orchestration)

One perspective, one artifact. The operator does a small change itself, or sends one assignment. The default and the cheapest option.

```
operator → reviewer [independent-review] → report → operator
```

**Use when:** the work is one perspective on one artifact and you can describe it in one sentence.

**Examples:**
- "Review this PR" → `reviewer` with `independent-review`
- "Find security issues in `auth.ts`" → `reviewer` with `independent-review`, `security`
- "What tests are missing for the checkout flow?" → `reviewer` with `testing`, `independent-review`
- "Plan, build and test the export limit" → one `editor` with `planning`, `implementation`, `testing`

**Cost:** one round trip. The baseline you should always compare orchestrated patterns against.

---

### 2. Single-skill slash command

A slash command that loads one skill with the project's setup. Saves the user from re-explaining the workflow every time.

```
/af-review → code-review-and-quality skill → report
```

**Use when:** the same single-perspective request happens repeatedly with the same setup.

**Examples in this repo:** `/af-review`, `/af-test`, `/af-code-simplify`.

**Cost:** same as direct work. The slash command is just a saved prompt.

**Anti-signal:** if the slash command's body is mostly "decide which agent to call," delete it and let the user or the operator choose.

---

### 3. Parallel fan-out with merge

Several readers work on the same input concurrently, each producing an independent report. A merge step in the operator's context synthesizes them into a single decision.

```
                       ┌─→ reviewer      [independent-review]           ─┐
operator → fan out  ───┼─→ reviewer--p2  [independent-review, security] ─┤→ merge → decision
                       └─→ reviewer--p3  [testing, independent-review]  ─┘
```

**Use when:**
- The sub-tasks are genuinely independent (no shared mutable state, no ordering dependency)
- Each sub-agent benefits from its own context window
- The merge step is small enough to stay in the operator's context
- Wall-clock latency matters

**Examples in this repo:** the Hub operator dispatching reviewers by concern in one turn (a busy reviewer gets the next instance automatically), and distinct `spawn_research` questions, which run in parallel.

**Cost:** N parallel sub-agent contexts + one merge turn. Higher than one assignment, but faster wall-clock and produces better reports because each sub-agent stays focused on its single perspective.

**Validation checklist before adopting this pattern:**
- [ ] Can I run all sub-agents at the same time without ordering issues?
- [ ] Does each assignment produce a different *kind* of finding, not just the same finding from a different angle?
- [ ] Will the merge step fit in the operator's remaining context?
- [ ] Is the user's wait time long enough that parallelism is actually noticeable?

If any answer is "no," fall back to one assignment or a single-skill command.

---

### 4. Parallel editors with an agreed interface

Several editors change disjoint parts of one feature at the same time, then the operator integrates and one independent review covers the whole change.

```
agree contract → editor [scope A] ─┐
               → editor--p2 [scope B] ─┤→ operator integrates + full checks → reviewer (whole change)
               → reviewer after: [editor] (audit area A)
```

**Use when:** the parts touch disjoint paths, the shared interface (signatures, formats, acceptance checks) can be settled first, and the runtime can isolate each writer's scope.

**Rules:** each writer sets `parallel: true` with a disjoint scope of exact existing paths, otherwise writes stay sequential; a shared file has one owner; a dependent assignment waits with `after: [...]`; closure needs a fresh verdict on the integrated revision, and a follow-up review gets the previous findings and the delta. The worked calls are in [docs/agents.md](../docs/agents.md#parallel-editors-with-a-shared-interface).

**Cost:** one context per editor, the integration turn and one final review. Worth it only when the parts are large enough that serial work is the bottleneck.

---

### 5. Sequential pipeline as user-driven slash commands

The user runs slash commands in a defined order, carrying context (or commit history) between them. There is no orchestrator agent — the user IS the orchestrator.

```
user runs:  /af-spec  →  /af-plan  →  /af-build  →  /af-test  →  /af-review  →  /af-ship
```

**Use when:** the workflow has dependencies (each step needs the previous step's output) and human judgment between steps adds value.

**Examples in this repo:** the entire DEFINE → PLAN → BUILD → VERIFY → REVIEW → SHIP lifecycle.

**Cost:** one context per step. Free for the orchestration layer because there is no orchestrator agent.

**Why not automate it:** an LLM "lifecycle orchestrator" would (a) lose nuance between steps because it has to summarize for hand-off, (b) skip the human checkpoints that catch wrong-direction work early, and (c) double the token cost via paraphrasing turns. Deterministic `just flow` graphs are the code-owned alternative when the steps are mechanical.

---

### 6. Research isolation (context preservation)

When a task requires reading large amounts of material that shouldn't pollute the operator's context, send it to the `researcher` role, which returns only a digest.

```
operator → spawn_research (reads 50 files) → findings on disk → operator continues
```

**Use when:**
- The operator needs to stay focused on a downstream task
- The investigation result is much smaller than the input it consumes
- The decision quality benefits from the operator having room to think after

**Examples:** "Find every call site of this deprecated API across the monorepo," "Summarize what these 30 ADRs say about caching." A delegated editor or reviewer that lacks a fact pauses with `NEEDS_RESEARCH:` and resumes with the findings paths.

**Cost:** one isolated sub-agent context. Worth it any time the alternative is loading hundreds of files into the main context.

---

## On Claude Code

Agent Fleet runs on pi; Claude Code joins a fleet only as a coms peer ([claude-code-coms-bridge.md](../docs/claude-code-coms-bridge.md)). The patterns above still map onto Claude Code's own primitives when you work in a Claude Code session, and the platform enforces some of the rules for you. The Agent Fleet role files are Hub definitions, not Claude Code subagents.

### Subagents vs. Agent Teams

Claude Code has two parallelism primitives. Pattern 3 (parallel fan-out with merge) maps to **subagents**. If you need teammates that talk to each other *live* (shared task list, mid-turn messaging), use **Agent Teams**. If you need the same question answered by several models with labeled cross-examination between rounds, use `/af-debate` / `just flow debate` — the harness mediates; the voices stay read-only and never message each other. That Fleet debate mechanism is not Agent Teams.

| | Subagents | Agent Teams |
|--|-----------|-------------|
| Coordination | Main agent fans out, sub-agents only report back | Teammates message each other, share a task list |
| Context | Own context window per subagent | Own context window per teammate |
| When to use | Independent tasks producing reports | Collaborative work needing discussion |
| Status | Stable | Experimental — requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| Cost | Lower | Higher — each teammate is a separate Claude instance |

### Platform-enforced rules

Two rules in this catalog aren't just convention — Claude Code enforces them:

- **"Subagents cannot spawn other subagents"** (verbatim from the docs). Anti-pattern B (role-calls-role) and Anti-pattern D (deep trees) cannot exist on Claude Code by construction.
- **"No nested teams"** — teammates cannot spawn their own teams. Same anti-patterns blocked at the team level.

### Built-in subagents to know about

Before defining a custom subagent in a Claude Code session, check whether one of these covers the work:

| Built-in | Purpose |
|----------|---------|
| `Explore` | Read-only codebase search and analysis. Use this for Pattern 6 (research isolation). |
| `Plan` | Read-only research during plan mode. |
| `general-purpose` | Multi-step tasks needing both exploration and modification. |

### Spawning multiple subagents in parallel

In Claude Code, parallel fan-out (Pattern 3) requires issuing **multiple Agent tool calls in a single assistant turn**. Sequential turns serialize execution. The same holds for the Hub: issue the `dispatch_agent` or `spawn_research` calls of one fan-out in one turn.

---

## Worked example: Agent Teams for competing-hypothesis debugging

This example shows when to reach for Claude Code **Agent Teams** instead of a subagent fan-out (Pattern 3). The two look similar from a distance — both spawn three investigators — but the value comes from a different place.

### The scenario

> *Checkout occasionally hangs for ~30 seconds before completing. It happens roughly once every 50 sessions. No errors in logs. Started after last week's release.*

Plausible root causes (mutually exclusive, all fit the symptoms):

1. A race condition in the new payment-confirmation flow
2. An auth check that occasionally falls through to a slow synchronous network call
3. A missing index on a query that scales with cart size
4. A flaky third-party API where the SDK retries silently before timing out

A single agent will pick the first plausible theory and stop investigating. A subagent fan-out would have each investigator report independently — but their reports never meet, so nothing rules out the wrong theories.

This is exactly the case the Agent Teams docs describe: *"With multiple independent investigators actively trying to disprove each other, the theory that survives is much more likely to be the actual root cause."*

### Why this is *not* a review fan-out

| | Review fan-out (subagents) | Agent Teams |
|--|--------------------|-------------|
| Sub-agents see | The same diff, different lenses | A shared task list, each other's messages |
| Output | Three independent reports → one merge | Adversarial debate → consensus root cause |
| Right when | You want a verdict on a known artifact | You want to *find* the artifact among hypotheses |

A review fan-out is a verdict; Agent Teams is an investigation.

### Setup (one-time, per-environment)

Agent Teams is experimental. In `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

Requires Claude Code v2.1.32 or later.

### The trigger prompt

Type into the lead session, in natural language:

```
Users report checkout hangs for ~30 seconds intermittently after last
week's release. No errors in logs.

Create an agent team to debug this with competing hypotheses. Spawn
three teammates:

  - a concurrency investigator — race conditions and blocking calls
    in the checkout code path
  - an auth investigator — auth checks, session handling, and any
    synchronous network calls added recently
  - a test investigator — tests that would distinguish between the
    hypotheses, and coverage gaps in checkout

Have them message each other directly to challenge each other's
theories. Update findings as consensus emerges. Only converge when
two teammates agree they can disprove the others'.
```

### What happens

1. Each teammate runs in its own context window, exploring the codebase from its own lens.
2. Teammates use `message` to send findings to each other directly. The lead doesn't have to relay.
3. The shared task list shows who's investigating what — visible at any time with `Ctrl+T` (in-process mode) or in a tmux pane (split mode; tmux here is Claude Code Agent Teams' own split-mode mechanism, not this repo's fleet tooling — our fleet layer runs on herdr).
4. When the concurrency investigator finds a `Promise.all` that should be sequential, it messages the auth investigator to confirm the auth call isn't part of the race. The auth investigator checks and replies — either confirming the race is the real issue or producing counter-evidence.
5. The test investigator proposes a focused integration test for whichever theory is winning, which the team uses to verify before declaring consensus.
6. The lead synthesizes the converged finding and presents it to you.

You can interrupt at any teammate by cycling with `Shift+Down` and typing — useful for redirecting an investigator who's gone down a wrong path.

### When to clean up

When the investigation lands on a root cause, tell the lead:

```
Clean up the team
```

Always cleanup through the lead, not a teammate (per the docs: teammates lack full team context for cleanup).

### Cost expectation

Three Sonnet teammates running for ~10–15 minutes of investigation costs noticeably more than three subagents reporting once. The justification is *quality of conclusion* — for production debugging where the wrong fix is expensive, the extra tokens are a bargain. For a routine PR review, stick with a review fan-out.

### Anti-pattern in this scenario

Do **not** rebuild this as a `/debug` slash command that fans out subagents. Subagents can't message each other live — you'd lose the adversarial debate that makes Agent Teams work. Fleet `/af-debate` is a different mechanism: the harness feeds labeled positions between rounds; voices never chat. Don't wrap Agent Teams inside a slash command that pretends to be `/af-debate`, and don't use `/af-debate` when you actually need live teammate messaging.

### When *not* to use Agent Teams

- Production-bound verdict on a known diff → a review fan-out (Pattern 3).
- One specialist perspective on one artifact → one assignment (Pattern 1).
- Sequential lifecycle (spec → plan → build) → user-driven slash commands (Pattern 5).
- Read-heavy research with a small digest → research isolation (Pattern 6).

Reach for Agent Teams only when teammates **need** to challenge each other to produce the right answer.

---

## Anti-patterns

### A. Router agent ("meta-orchestrator")

An agent whose job is to decide which other agent to call.

```
/work → router → "this needs a review" → reviewer → router (paraphrases) → user
```

**Why it fails:**
- Pure routing layer with no domain value
- Adds two paraphrasing hops → information loss + roughly 2× token cost
- The user already knew they wanted a review; they could have called `/af-review` directly
- Replicates the work that slash commands, intent mapping in `AGENTS.md` and the Hub operator already do

**What to do instead:** add or refine slash commands. Document intent → command mapping in `AGENTS.md`.

---

### B. A role that dispatches another role

A reviewer that internally starts a security review when it sees auth code.

**Why it fails:**
- An assignment is scoped to one perspective and one set of practices; chaining them defeats that
- The summary the calling agent passes loses context the called agent needs
- Failure modes multiply (whose output format wins? whose rules apply?)
- Hides cost from the user

**What to do instead:** have the reviewer *recommend* a follow-up assignment (role, practices, scope) in its report. The operator, a flow or the user runs the second pass. When one agent needs both perspectives, give that one assignment both practices.

---

### C. Sequential orchestrator that paraphrases

An agent that calls `/af-spec`, then `/af-plan`, then `/af-build`, etc. on the user's behalf.

**Why it fails:**
- Loses the human checkpoints that catch wrong-direction work
- Each hand-off summarizes context — accumulated drift over a long pipeline
- Doubles token cost: orchestrator turn + sub-agent turn for every step
- Removes user agency at exactly the points where judgment matters most

**What to do instead:** keep the user as the orchestrator. Document the recommended sequence in `README.md` and let users invoke it.

---

### D. Deep trees

A command that calls a `pre-ship-coordinator` that calls a `quality-coordinator` that calls a reviewer.

**Why it fails:**
- Each layer adds latency and tokens with no decision value
- Debugging becomes a multi-level investigation
- The leaf agents lose context to multiple summarization steps

**What to do instead:** keep the orchestration depth at most 1 (operator or command → roles). The merge happens in the operator's context. A role's own `subagents:` helpers (for example the editor's `recon` and `verifier`) are bounded by `delegate_depth: 1` and report back to it; they are not further roles.

---

## Decision flow

When considering a new orchestrated workflow, walk this flow:

```
Is the work one perspective on one artifact?
├── Yes → Direct work or one assignment. Stop.
└── No  → Will the same composition repeat?
         ├── No  → Assignments chosen ad hoc by the operator. Stop.
         └── Yes → Are sub-tasks independent?
                  ├── No  → Sequential slash commands run by user (Pattern 5).
                  └── Yes → Readers: parallel fan-out with merge (Pattern 3).
                           Writers: parallel editors with an agreed interface (Pattern 4).
                           Validate against the checklists above.
                           If any check fails → fall back to a single-skill command (Pattern 2).
```

---

## When to add a new pattern to this catalog

Add a new entry only after:

1. You've used the pattern at least twice in real work
2. You can name a concrete artifact in this repo that demonstrates it
3. You can explain why an existing pattern wouldn't have worked
4. You can describe its anti-pattern shadow (what people will mistakenly build instead)

Premature catalog entries become aspirational documentation that no one follows.
