# Skills Catalog

All 29 skills, grouped by lifecycle phase. Each one is a structured workflow with steps, verification gates, and anti-rationalization tables — see [skill-anatomy.md](skill-anatomy.md) for the format. The lifecycle commands (`/spec`, `/plan`, `/build`, …) are the entry points; these skills are what they activate, and every skill can also be referenced directly.

Skills live in **two roots**: fleet-native and customized skills in [`skills/`](../skills/), and the pristine upstream import in [`vendor/agent-skills-upstream/skills/`](../vendor/agent-skills-upstream/). When a name exists in both, the native copy wins — see [UPSTREAM-SKILLS.md](UPSTREAM-SKILLS.md).

## Meta - Discover which skill applies

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [using-agent-skills](../skills/using-agent-skills/SKILL.md) | Maps incoming work to the right skill workflow and defines shared operating rules | Starting a session or deciding which skill applies |
| [designing-agents](../skills/designing-agents/SKILL.md) | Author a new agent persona, workflow skill, or pi harness that another agent will delegate to | Writing or rewriting a persona/skill/harness (via `/design-agent`) |

## Define - Clarify what to build

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [interview-me](../skills/interview-me/SKILL.md) | One-question-at-a-time interview that extracts what the user actually wants instead of what they think they should want, until ~95% confidence | The ask is underspecified, or the user invokes "interview me" / "grill me" |
| [idea-refine](../skills/idea-refine/SKILL.md) | Structured divergent/convergent thinking to turn vague ideas into concrete proposals | You have a rough concept that needs exploration |
| [spec-driven-development](../skills/spec-driven-development/SKILL.md) | Write a PRD covering objectives, commands, structure, code style, testing, and boundaries before any code | Starting a new project, feature, or significant change |

## Plan - Break it down

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [planning-and-task-breakdown](../skills/planning-and-task-breakdown/SKILL.md) | Decompose specs into small, verifiable tasks with acceptance criteria and dependency ordering | You have a spec and need implementable units |

## Build - Write the code

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [incremental-implementation](../skills/incremental-implementation/SKILL.md) | Thin vertical slices - implement, test, verify, commit. Feature flags, safe defaults, rollback-friendly changes | Any change touching more than one file |
| [test-driven-development](../vendor/agent-skills-upstream/skills/test-driven-development/SKILL.md) | Red-Green-Refactor, test pyramid (80/15/5), test sizes, DAMP over DRY, Beyonce Rule, browser testing | Implementing logic, fixing bugs, or changing behavior |
| [context-engineering](../skills/context-engineering/SKILL.md) | Feed agents the right information at the right time - rules files, context packing, MCP integrations | Starting a session, switching tasks, or when output quality drops |
| [source-driven-development](../vendor/agent-skills-upstream/skills/source-driven-development/SKILL.md) | Ground every framework decision in official documentation - verify, cite sources, flag what's unverified | You want authoritative, source-cited code for any framework or library |
| [doubt-driven-development](../vendor/agent-skills-upstream/skills/doubt-driven-development/SKILL.md) | Adversarial fresh-context review of every non-trivial decision in-flight - CLAIM → EXTRACT → DOUBT → RECONCILE → STOP, with optional user-authorized cross-model escalation | Stakes are high (production, security, irreversible), working in unfamiliar code, or a confident output is cheaper to verify now than to debug later |
| [frontend-ui-engineering](../skills/frontend-ui-engineering/SKILL.md) | Component architecture, design systems, state management, responsive design, WCAG 2.1 AA accessibility | Building or modifying user-facing interfaces |
| [api-and-interface-design](../vendor/agent-skills-upstream/skills/api-and-interface-design/SKILL.md) | Contract-first design, Hyrum's Law, One-Version Rule, error semantics, boundary validation | Designing APIs, module boundaries, or public interfaces |

## Verify - Prove it works

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [browser-testing-with-devtools](../skills/browser-testing-with-devtools/SKILL.md) | Chrome DevTools MCP for live runtime data - DOM inspection, console logs, network traces, performance profiling | Building or debugging anything that runs in a browser |
| [debugging-and-error-recovery](../vendor/agent-skills-upstream/skills/debugging-and-error-recovery/SKILL.md) | Five-step triage: reproduce, localize, reduce, fix, guard. Stop-the-line rule, safe fallbacks | Tests fail, builds break, or behavior is unexpected |

## Review - Quality gates before merge

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [code-review-and-quality](../skills/code-review-and-quality/SKILL.md) | Five-axis review, change sizing (~100 lines), severity labels (Nit/Optional/FYI), review speed norms, splitting strategies | Before merging any change |
| [code-simplification](../vendor/agent-skills-upstream/skills/code-simplification/SKILL.md) | Chesterton's Fence, Rule of 500, reduce complexity while preserving exact behavior | Code works but is harder to read or maintain than it should be |
| [security-and-hardening](../skills/security-and-hardening/SKILL.md) | OWASP Top 10 prevention, auth patterns, secrets management, dependency auditing, three-tier boundary system | Handling user input, auth, data storage, or external integrations |
| [performance-optimization](../skills/performance-optimization/SKILL.md) | Measure-first approach - Core Web Vitals targets, profiling workflows, bundle analysis, anti-pattern detection | Performance requirements exist or you suspect regressions |

## Ship - Deploy with confidence

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [git-workflow-and-versioning](../skills/git-workflow-and-versioning/SKILL.md) | Trunk-based development, atomic commits, change sizing (~100 lines), the commit-as-save-point pattern | Making any code change (always) |
| [ci-cd-and-automation](../vendor/agent-skills-upstream/skills/ci-cd-and-automation/SKILL.md) | Shift Left, Faster is Safer, feature flags, quality gate pipelines, failure feedback loops | Setting up or modifying build and deploy pipelines |
| [deprecation-and-migration](../skills/deprecation-and-migration/SKILL.md) | Code-as-liability mindset, compulsory vs advisory deprecation, migration patterns, zombie code removal | Removing old systems, migrating users, or sunsetting features |
| [documentation-and-adrs](../vendor/agent-skills-upstream/skills/documentation-and-adrs/SKILL.md) | Architecture Decision Records, API docs, inline documentation standards - document the *why* | Making architectural decisions, changing APIs, or shipping features |
| [observability-and-instrumentation](../vendor/agent-skills-upstream/skills/observability-and-instrumentation/SKILL.md) | Structured logging, RED metrics, OpenTelemetry tracing, symptom-based alerting - instrument as you build | Adding telemetry, or shipping anything that runs in production |
| [shipping-and-launch](../vendor/agent-skills-upstream/skills/shipping-and-launch/SKILL.md) | Pre-launch checklists, feature flag lifecycle, staged rollouts, rollback procedures, monitoring setup | Preparing to deploy to production |

## Orchestrate - Keep multi-agent runs honest

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [orchestration-verification](../skills/orchestration-verification/SKILL.md) | The Verification Contract — dispatcher-owned acceptance assertions, a parity/touchpoint inventory for "behave like X" requests, structured upward returns with named evidence, and a requirement-regression reset | Orchestrating specialists through a dispatcher (the `agent-hub` harness / `orchestrator` persona), a "make X behave like existing Y" change, or a requirement that keeps coming back wrong |
| [peer-coms](../skills/peer-coms/SKILL.md) | Makes Claude Code a first-class peer in the local coms pool — discover pi colleagues with `coms-cli list`, ask/delegate with `send --await`, answer inbound peer questions, never drive panes itself | Claude Code runs in a bridged herdr pane (see the [coms bridge](claude-code-coms-bridge.md)), or an inbound `[coms message from …]` arrives |

`orchestration-verification` is the single canonical source for the four Verification-Contract artifacts. It is referenced — never restated — by the [`orchestrator`](../agents/orchestrator.md) persona (which drives the [agent-hub harness](../.pi/harnesses/agent-hub/), loaded by default via `just hub`), and conditionally by the [`builder`](../agents/builder.md), [`test-engineer`](../agents/test-engineer.md), and [`code-reviewer`](../agents/code-reviewer.md) personas, whose structured returns report assertion status with evidence when the skill is installed.

## Learn - Compound the session's lessons

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [compound-learning](../skills/compound-learning/SKILL.md) | End-of-session compound pass — extracts lessons from session evidence (corrections, recurring findings, root causes), dedupes them index-first against the project's rule tree, and lands them as minimal, capped diffs on existing rules/docs files | A session ends with something worth keeping, the user says "compound", or the `documenter` persona receives a `/compound` dispatch |

This is the compound-engineering loop: the `/compound` command (claude-code, opencode, and the agent-hub harness on pi) runs this skill against the `rules:`/`docs:` targets from `.ai/agent-fleet-overrides.md`, with an approval gate and hard caps so the rule tree gets sharper instead of longer.

## Onboard - Get a workspace set up

| Skill | What It Does | Use When |
|-------|-------------|----------|
| [guided-workspace-setup](../skills/guided-workspace-setup/SKILL.md) | The LLM-driven installer behind `/setup-agent-fleet` — workspace analysis, grouped install menus, version-aware three-way diffs, per-project overrides, doctor repairs | Installing, upgrading, or repairing an Agent Fleet workspace |

## How skills work

Every skill follows a consistent anatomy — frontmatter (`name` + a trigger-bearing `description`), Overview, When to Use, Process, Common Rationalizations, Red Flags, and Verification. Key design choices:

- **Process, not prose.** Skills are workflows agents follow, not reference docs they read. Each has steps, checkpoints, and exit criteria.
- **Anti-rationalization.** Every skill includes a table of common excuses agents use to skip steps (e.g., "I'll add tests later") with documented counter-arguments.
- **Verification is non-negotiable.** Every skill ends with evidence requirements - tests passing, build output, runtime data. "Seems right" is never sufficient.
- **Progressive disclosure.** The `SKILL.md` is the entry point. Supporting references load only when needed, keeping token usage minimal.

Full format specification: [skill-anatomy.md](skill-anatomy.md). Supplementary checklists the skills pull in live in [`references/`](../references/).
