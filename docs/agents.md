# Roles and practices

The Agent Hub dispatches three runtime roles. A role sets what an assignment may
do. Each assignment also carries one or more practices, which add method and
expected evidence but never authority. The operator chooses the role by the work
the subagent may perform, attaches the practices the assignment needs, and stays
responsible for integrating the results.

The code owns both catalogues: [roles.ts](../.pi/harnesses/agent-hub/config/roles.ts)
and [practices.ts](../.pi/harnesses/agent-hub/config/practices.ts). The role
prompts are [researcher](../agents/researcher.md), [reviewer](../agents/reviewer.md)
and [editor](../agents/editor.md). The Hub operator prompt lists the same roles and
practices.

## Roles

| Role | Assignment and authority | Reached through | Default practice |
|---|---|---|---|
| `researcher` | Read-only investigation (`read,grep,find,ls`). Starts with the smallest search that can answer the question and deepens it when sources disagree or evidence is missing. Returns sources, uncertainty and remaining questions. | `spawn_research` | `research` |
| `reviewer` | Read-only, independent assessment of a named plan, code change or documentation revision. Returns findings and a verdict scoped to what it inspected. The author of reviewed work can never approve it, including after changing role. | `dispatch_agent` | `independent-review` |
| `editor` | Creates or changes code, tests, plans and documentation inside the authorized write scope. Returns the changes, checks run and outstanding work. | `dispatch_agent` | `implementation` |

- The role ceiling comes from code. A role file can change the prompt and the
  model, never the tools, the read-only status or the kind.
- A reviewer gets a shell only in an active-check mode (`review_mode: "run-checks"`
  or a current-state mode). That shell runs inside the write-denying sandbox with an
  empty write allowlist. Without the sandbox the dispatch is refused, and the check
  belongs to an editor that returns revision-bound results.
- `dispatch_agent { agent: "researcher" }` is refused with a pointer to
  `spawn_research`.
- An unknown role, unknown practice, or practice the role cannot use is refused
  before anything starts. So is a [retired persona name](#retired-personas).

## Practices

A practice supplies method and expected evidence and points the worker at existing
skills, resolved native-first: the workspace's `skills/`, then `.pi/skills/`, then
the vendored upstream copy ([UPSTREAM-SKILLS.md](UPSTREAM-SKILLS.md)). Authority
still comes from the role ceiling, the authorized scope, the backend and the
existing action permissions.

| Practice id | Roles | Skills | Typical result |
|---|---|---|---|
| `research` | all | source-driven-development, context-engineering | An answer with traceable sources, stated uncertainty and the remaining questions |
| `architecture` | all | spec-driven-development, api-and-interface-design | Options, constraints and an interface decision with the trade-off that decided it |
| `planning` | all | planning-and-task-breakdown | Ordered tasks with dependencies and acceptance criteria. An editor saves the plan; a researcher or reviewer returns advice or critique |
| `implementation` | editor | incremental-implementation | A scoped change with verification evidence |
| `independent-review` | reviewer | code-review-and-quality, orchestration-verification | A plan feasibility, code correctness or documentation accuracy verdict against a named revision |
| `testing` | all | test-driven-development | A reproduction, regression coverage or check results |
| `security` | all | security-and-hardening | Findings with evidence, or a scoped remediation with verification |
| `performance` | all | performance-optimization | Measurements, their interpretation and any verified improvement |
| `browser-debugging` | all | browser-testing-with-devtools, debugging-and-error-recovery | A reproducible interaction, observations and a diagnosis. Readers only observe |
| `documentation` | editor | documentation-and-adrs | Accurate user guidance or a recorded decision |
| `release` | editor | shipping-and-launch, git-workflow-and-versioning | Release preparation and readiness evidence |

**Publishing needs separate permission.** The `release` practice prepares a
release: the changeset, version, changelog and readiness checks. It never
publishes. `git push`, `npm`/`pnpm`/`yarn`/`bun publish`, `changeset publish` and
`gh release create|upload|edit` each need a one-call approval from the
damage-control rules ([.pi/damage-control-rules.yaml](../.pi/damage-control-rules.yaml)),
whatever the role or practice.

At the trivial and small task tiers, `architecture` on any role and `security` on a
reviewer are refused without charging. Raise the tier with an honest reason first.

**Decision questions.** `planning`, `architecture`, `independent-review` and
`security` also say when a worker should propose a Poll or a Debate: planning for
viable sequences, scopes or migration paths and for a dependency or rollback
objection; architecture for trade-offs with their assumptions and evidence;
independent review for a substantial finding or incompatible remedies, tied to the
named revision; security for mitigations once the risk is established, and for a
disputed threat-model assumption or residual risk. A worker never starts either.
It ends its report with at most two lines such as

```text
DECISION_QUESTION: {"method":"debate","decision":"Where should the retry limit live","alternatives":["the shared client","each job"],"objection":"a client default also retries the non-idempotent POST in src/billing/charge.ts","evidence":["src/http/client.ts","src/billing/charge.ts"]}
```

The Hub validates each line (`method` poll or debate, 2–5 `alternatives`, an
`objection` for a debate, `evidence` as paths) and adds one notice to the dispatch
or research result with the tool and a ready question; the parsed proposals are in
`details.decisionQuestions`, and a rejected line is reported with its reason. A
proposal starts nothing and never blocks, fails or accepts the run, and a
reviewer's verdict stays its own. A worker that cannot continue without the
decision still raises `ASK_USER`. Facts go to research (`NEEDS_RESEARCH`), never to
a Poll or a Debate.

## Dispatch examples

One editor with combined practices plans, implements and tests in one assignment:

```js
dispatch_agent({
  agent: "editor",
  practices: ["planning", "implementation", "testing"],
  task: "Plan and add rate limiting to the export endpoint; cover the 429 path with a test",
  scope: ["src/export", "test/export", "docs/plans"],
})
```

Distinct research questions run in parallel. Each question is its own attempt,
and the same question already in flight is refused as busy:

```js
spawn_research({ task: "Where is the export endpoint authenticated?", expected_result: "path:line list" })
spawn_research({ task: "Which clients call the export endpoint?", practices: ["research", "architecture"] })
```

Readers fan out by concern on the same revision. A busy reviewer doing plain
inspection gets its own instance (`reviewer--p2`, `reviewer--p3`) without
`parallel: true`; active checks and editors still need it. Practices are
part of the review identity, so a security review never reuses a plain one:

```js
dispatch_agent({ agent: "reviewer", task: "Review the export change at HEAD" })
dispatch_agent({ agent: "reviewer", practices: ["independent-review", "security"], task: "Security review of the export change at HEAD" })
dispatch_agent({ agent: "reviewer", practices: ["testing", "independent-review"], task: "Assess test coverage of the export change" })
```

### Parallel editors with a shared interface

Editors run one at a time unless each assignment sets `parallel: true` and the
runtime can isolate a disjoint scope of exact existing paths. Otherwise writes stay
sequential.

1. **Agree the contract first.** Settle the signatures, formats and acceptance
   checks the editors share before dispatching them. Record them in the task brief,
   or have one editor land the shared file before the parallel writers start. A
   shared file has one owner. An editor that finds the interface unsettled, or
   different from its assignment, stops the dependent work and returns `blocked` or
   `partial`.
2. **Dispatch writers with disjoint scopes.** The second concurrent editor runs as
   `editor--p2`, and its result says so:

   ```js
   dispatch_agent({ agent: "editor", parallel: true, practices: ["implementation", "testing"],
     task: "Implement GET /orders/summary against the OrderSummary contract in the brief",
     scope: ["src/server/orders", "test/server/orders"] })
   dispatch_agent({ agent: "editor", parallel: true, practices: ["implementation"],
     task: "Render the order summary in the client against the same contract",
     scope: ["src/client/orders"] })
   ```

3. **Queue a consumer with `after`.** `after` names instances already dispatched in
   this task. The call waits with a visible "queued after …" status, and nothing
   starts or is charged until each dependency settles. A failed or unsettled
   dependency refuses the consumer with a diagnostic, and cancellation is honored.
   An assignment cannot wait for its own instance, and research runs through
   `spawn_research` handles, not instances.

   ```js
   dispatch_agent({ agent: "reviewer", after: ["editor"],
     task: "Audit the server endpoint once it lands", scope: ["src/server/orders"] })
   ```

4. **Integrate, then review the whole change.** Collect results by assignment,
   reconcile interface differences, edit shared files and run the full checks on the
   combined change. Then dispatch one independent review covering the integrated
   whole:

   ```js
   dispatch_agent({ agent: "reviewer",
     task: "Review the whole order-summary change on the integrated working tree" })
   ```

Closure needs a fresh verdict that covers every changed file at the integrated
revision. A verdict on one editor's files, on the base revision, or from an author
of the change does not close the task. When an editor changes reviewed work, the
follow-up review receives the previous findings and the delta.

## Retired personas

The 13 personas that shipped before 2.3.0 are no longer dispatched. Naming one is
refused before anything starts, and the message gives the mapping below. There is
no alias. Choose the role by the outcome you need.

| Retired persona | Dispatch instead |
|---|---|
| `architect` | `researcher` + `architecture` for analysis; `editor` + `architecture`, `documentation` for an ADR |
| `bowser` | `researcher` + `browser-debugging` for observation; `editor` + `browser-debugging` for authorized stateful interaction or test artifacts |
| `builder` | `editor` + `implementation`; add `testing` as needed |
| `code-reviewer` | `reviewer` + `independent-review` for code or documentation |
| `deep-researcher` | `researcher` + `research`; the question drives the depth |
| `documenter` | `editor` + `documentation` |
| `plan-reviewer` | `reviewer` + `independent-review`; add `architecture` or `planning` as needed |
| `planner` | `editor` + `planning` for a saved plan; `researcher` + `planning` for advice |
| `releaser` | `editor` + `release` for scoped preparation; publishing needs separate explicit permission |
| `security-auditor` | `reviewer` + `independent-review`, `security`; fixes go to `editor` + `security` |
| `test-engineer` | `editor` + `testing` for test changes; `reviewer` + `testing`, `independent-review` for coverage assessment |
| `web-debugger` | `researcher` + `browser-debugging` for diagnosis; `editor` + `browser-debugging` for scoped changes |
| `web-performance-auditor` | `reviewer` + `performance`, `independent-review`; measurement that needs writes or optimization goes to `editor` + `performance` |

`researcher` keeps its name and becomes the role. Upgrade steps, the overrides key
migration and what `doctor` reports are in
[MIGRATION-agent-fleet.md](MIGRATION-agent-fleet.md#6-three-runtime-roles-replace-the-personas).

## Models per role and practice

Each role file sets `model:`, `models:` (the candidates `/af-agent-model` offers)
and `thinking:`. It may also set `practice_models:` for per-practice defaults:

```yaml
practice_models:
  planning: { model: openai-codex/gpt-6.2-astra, thinking: high }
```

A practice-level choice comes from, highest first: the session
(`/af-agent-model <role>.<practice>`), the active model profile (`editor.planning`),
`.ai/agent-fleet-overrides.md` (`model.<role>.<practice>`, `thinking.<role>.<practice>`),
then the role file's `practice_models:`. The first practice in assignment order with
a choice wins. Without one, the role's own model chain applies. The run records
which source chose the model. Override keys are documented in
[agent-fleet-setup.md](agent-fleet-setup.md).

## Peers serving a role

A live coms peer can serve a role instead of a fresh native subagent.
[.pi/agents/dispatch-policy.yaml](../.pi/agents/dispatch-policy.yaml) keys routes by
role, with a separate peer address:

```yaml
routes:
  reviewer:
    peer: claude-reviewer
    prefer: coms
    fallback: native
```

- Start each peer on its own: `just fleet peer <name>` with `--runner pi|claude-code`,
  `--persona <name>` or `--no-persona`, `--model`, `--read-only` and `--env-file`, or
  `herdr_spawn_peer` from a Hub running inside Herdr. A pi peer loads Chrome DevTools
  MCP unless it is read-only.
- A read-only role (`researcher`, `reviewer`) reaches only a peer launched with
  `--read-only` that declares it at registration. Otherwise the route runs native, or
  is refused under `fallback: none`.
- A reviewer route never reaches a peer address that changed a file in the review's
  scope, even after a restart. An auto route runs a native reviewer instead. An
  explicit `backend: "coms"` or `fallback: none` is refused before anything starts.
- A parallel instance such as `reviewer--p2` uses its role's route.

See [claude-code-coms-bridge.md](claude-code-coms-bridge.md) for a Claude Code
reviewer peer.

## Roles as panel voices

Poll and Debate ask every voice of a model panel (`.pi/agents/voices.yaml`, or the
active model profile's panel) the same decision question. Both are the operator's,
never a delegate's: Poll through `poll_panel` or `/af-poll`, Debate through
`debate_panel` or `/af-debate`. A delegate proposes one with a
[decision question](#practices).

```js
debate_panel({ question: "Decision: … Alternatives: (A) … (B) … Objection to test: … Evidence: src/a.ts, docs/adr/0007.md. Constraints: …",
  persona: "reviewer", rounds: 3 })
```

- A voice runs as `researcher` (the default) or `reviewer`, always read-only.
  `editor` is refused because a voice never writes, and a retired persona name is
  refused with its mapping. The rule is the same for both entry points of Poll and
  Debate.
- Both select the panel the same way: an explicit name, then the configured panel,
  then a panel named `default`. Voices inspect the session's assigned checkout
  (`just fleet --worktree <path>` from a non-Git Fleet workspace). A preflight
  refusal starts no voice.
- Debate runs 2–5 rounds (default 3). Round 1 positions are independent; later
  rounds show each voice the others' labelled positions. The result lists each
  final position, which voice changed in which round and the evidence that moved
  it, the open disagreements, failed voices and incomplete rounds, and the round
  artifacts. There is no judge: the operator decides, records the decision in the
  task brief, and refers a reserved decision to the human.

The [debate](../skills/debate/SKILL.md) skill is the operator's guidance for
choosing between research, Poll and Debate and for acting on the result. It is
not a practice. The Hub requires it, so it installs with the roles.

## Customizing a role

Only the three role names are dispatched. A workspace file with a role's name
replaces that role's prompt or model: `agents/<role>.md` or `.claude/agents/<role>.md`
win over the installed `.pi/agents/personas/<role>.md`. The code-owned ceiling still
applies. Any other definition file is ignored, and Hub startup lists it in one
notice. A retired name gets its mapping in that notice. A missing role is named too,
and dispatches to it are refused until `agent-fleet setup` installs it.

To add method for a kind of work, write or extend a skill and use it through the
practice that names it. To add a new kind of assignment, propose a practice change in
`practices.ts`. See [designing-agents](../skills/designing-agents/SKILL.md).

## Installing the roles

The installer ships the three role files as items `persona:researcher`,
`persona:reviewer` and `persona:editor` in the catalogue group "Agent roles". All
three are in the default preset and come with the Hub. They install verbatim to
`.pi/agents/personas/<role>.md`, beside the fleet YAML in `.pi/agents/`. Setup
removes unmodified installed copies of retired personas and keeps edited ones.
`agent-fleet doctor` reports leftover retired definitions and override keys without
changing them. See [npm-install.md](npm-install.md) for the lifecycle.

## Roles, skills and commands

| Layer | What it is | Example | Job |
|---|---|---|---|
| **Skill** | A workflow with steps and exit criteria | `code-review-and-quality` | The *how*, loaded through a practice or a command |
| **Role + practices** | A capability ceiling plus the method for one assignment | `reviewer` + `independent-review`, `security` | The *who* and *what evidence* |
| **Command** | A user-facing entry point | `/af-review`, `/af-ship` | The *when* |

Roles do not dispatch other roles. Composition belongs to the Hub operator, a
deterministic flow or the user. Inside an assignment, a role file's `subagents:`
are helpers on a cheaper model (for example the editor's `recon` and `verifier`), not
other roles. The operator follows
[orchestration-verification](../skills/orchestration-verification/SKILL.md). See
[orchestration-patterns.md](../references/orchestration-patterns.md) for the pattern
catalogue and anti-patterns. For the Hub → role → helper picture, see
[ARCHITECTURE.md](ARCHITECTURE.md#fleet-hierarchy).

### Avoid a routing layer

Do not build an agent whose only job is to decide which other agent to call. It
adds a paraphrasing hop, loses information and doubles the token cost. The operator
already chooses the role, and the user can call a command such as `/af-review`
directly.
