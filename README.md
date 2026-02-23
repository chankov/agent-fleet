# Agent Skills

**Production-grade engineering skills for AI coding agents.**

A curated collection of skills that encode the workflows, quality gates, and best practices senior engineers at top-tier companies use when building web applications — packaged so AI coding agents can follow them consistently.

These aren't generic prompts. Each skill captures a specific phase of the software development lifecycle with concrete processes, verification steps, anti-patterns to avoid, and the kind of hard-won knowledge that separates production-quality work from prototype-quality work.

## Why Agent Skills?

AI coding agents are powerful, but they default to taking the shortest path — which often means skipping specs, tests, security reviews, and all the practices that make software reliable. **Agent Skills** changes that by giving agents structured workflows for every phase of development:

| Phase | Skills | What They Enforce |
|-------|--------|-------------------|
| **Define** | [idea-refine](#idea-refine), [spec-driven-development](#spec-driven-development) | Refined ideas and structured requirements before code. |
| **Plan** | [planning-and-task-breakdown](#planning-and-task-breakdown) | Decompose into verifiable chunks |
| **Build** | [incremental-implementation](#incremental-implementation), [context-engineering](#context-engineering), [frontend-ui-engineering](#frontend-ui-engineering), [api-and-interface-design](#api-and-interface-design) | Small slices, right context, clean interfaces |
| **Verify** | [test-driven-development](#test-driven-development), [browser-testing-with-devtools](#browser-testing-with-devtools), [debugging-and-error-recovery](#debugging-and-error-recovery) | Prove it works with tests and real browser data |
| **Review** | [code-review-and-quality](#code-review-and-quality), [security-and-hardening](#security-and-hardening), [performance-optimization](#performance-optimization) | Quality gates before merge |
| **Ship** | [git-workflow-and-versioning](#git-workflow-and-versioning), [ci-cd-and-automation](#ci-cd-and-automation), [documentation-and-adrs](#documentation-and-adrs), [shipping-and-launch](#shipping-and-launch) | Safe, documented, reversible releases |

## Quick Start

### Claude Code (Recommended)

**Via marketplace** — add and install directly from Claude Code:

```
/plugin marketplace add addyosmani/agent-skills
/plugin install agent-skills@addy-agent-skills
```

**Local / development use** — clone and load with `--plugin-dir`:

```bash
git clone https://github.com/addyosmani/agent-skills.git
claude --plugin-dir /path/to/agent-skills
```

Once loaded, skills activate automatically based on context. Slash commands are also available under the `agent-skills:` namespace:

```
/agent-skills:spec      → Start spec-driven development
/agent-skills:plan      → Break work into tasks
/agent-skills:build     → Implement incrementally
/agent-skills:test      → Run TDD workflow
/agent-skills:review    → Trigger code review
/agent-skills:ship      → Pre-launch checklist
```

### Cursor

Copy the contents of any `SKILL.md` file into your `.cursor/rules/` directory, or reference the full `skills/` directory in your Cursor settings. See [docs/cursor-setup.md](docs/cursor-setup.md) for details.

### Windsurf

Add skill contents to your Windsurf rules configuration. See [docs/windsurf-setup.md](docs/windsurf-setup.md).

### GitHub Copilot

Use the agent definitions in `agents/` as Copilot agent personas, and skill content in your `agents.md` or `.github/copilot-instructions.md`. See [docs/copilot-setup.md](docs/copilot-setup.md).

### Codex / Other Agents

Skills are plain Markdown — they work with any agent that accepts system prompts or instruction files. See [docs/getting-started.md](docs/getting-started.md) for the universal approach.

---

## Skills Reference

### Define Phase

#### idea-refine
Refine ideas through structured divergent and convergent thinking. Helps clarify vague concepts into concrete proposals before specification.

**Use when:** You have a rough idea but need to explore options and solidify the concept.

#### spec-driven-development
Write structured specifications before writing code. Covers the full spec lifecycle: high-level vision, PRD structure with six core areas (commands, testing, project structure, code style, git workflow, boundaries), gated workflow (Specify → Plan → Tasks → Implement), and living document maintenance.

**Use when:** Starting a new project, feature, or significant change.

#### planning-and-task-breakdown
Decompose work into small, verifiable tasks with explicit acceptance criteria. Covers plan-mode-first workflow, task sizing, dependency ordering, checkpoint design, and the art of writing tasks that are small enough for an agent to execute reliably.

**Use when:** You have a spec and need to break it into implementable units.

### Build Phase

#### incremental-implementation
Build in thin vertical slices — implement one piece, test it, verify it, then expand. Covers feature flags, safe defaults, rollback-friendly changes, and the discipline of landing small, complete increments rather than big-bang changes.

**Use when:** Implementing any feature or change that touches more than one file.

#### context-engineering
Feed agents the right information at the right time. Covers rules files (CLAUDE.md, .cursorrules), context packing strategies, selective inclusion, hierarchical summaries, MCP integrations, and how to avoid both context starvation and context overload.

**Use when:** Starting a session, switching tasks, or when agent output quality degrades.

#### frontend-ui-engineering
Build production-quality user interfaces. Covers component architecture, design system adherence, state management patterns, responsive design, accessibility (WCAG 2.1 AA), and avoiding the "AI-generated UI" aesthetic. Includes patterns for React, Vue, and vanilla approaches.

**Use when:** Building or modifying user-facing interfaces.

#### api-and-interface-design
Design stable, well-documented interfaces. Covers REST and GraphQL patterns, error semantics, versioning strategy, boundary design between modules, input validation at system edges, and backward compatibility.

**Use when:** Designing APIs, module boundaries, or any public interface.

### Verify Phase

#### test-driven-development
Write tests before code. Covers the Prove-It pattern (reproduce bugs with failing tests before fixing), test hierarchy (unit → integration → e2e), test sizing, when to use each level, and the discipline of never shipping without verification.

**Use when:** Implementing any logic, fixing any bug, or changing any behavior.

#### browser-testing-with-devtools
Use Chrome DevTools MCP to give your agent eyes into the browser. Covers DOM inspection, console log analysis, network trace review, performance profiling, screenshot comparison, and automated UI testing through the agent — bridging static code analysis with live runtime data.

**Use when:** Building or debugging anything that runs in a browser.

#### debugging-and-error-recovery
Systematic debugging with structured triage. Covers the stop-the-line rule, five-step triage (reproduce → localize → reduce → fix → guard), safe fallbacks, rollback strategies, and when to instrument vs. when to remove debug code.

**Use when:** Tests fail, builds break, or behavior doesn't match expectations.

### Review Phase

#### code-review-and-quality
Multi-dimensional code review with quality gates. Covers five-axis review (correctness, readability, architecture, security, performance), dependency discipline, multi-model review patterns (write with one model, review with another), and the "would a staff engineer approve this?" standard.

**Use when:** Before merging any change.

#### security-and-hardening
Security-first development practices. Covers OWASP Top 10 prevention, input validation, output encoding, authentication/authorization patterns, secrets management, dependency auditing, and the three-tier boundary system (Always/Ask First/Never).

**Use when:** Handling user input, authentication, data storage, or external integrations.

#### performance-optimization
Measure before optimizing. Covers Core Web Vitals, performance budgets, profiling workflow, common anti-patterns (N+1 queries, unbounded loops, layout thrashing), bundle analysis, and the discipline of optimizing only what measurements prove matters.

**Use when:** Performance requirements exist, or you suspect regressions.

### Ship Phase

#### git-workflow-and-versioning
Git as your safety net. Covers atomic commits, descriptive messages, branch strategy, worktrees for parallel work, the "commit as save point" pattern, and the discipline of never mixing formatting changes with behavior changes.

**Use when:** Making any code change (i.e., always).

#### ci-cd-and-automation
Automate quality gates. Covers pipeline design, test/lint/typecheck/build enforcement, failure feedback loops (feed CI errors back to agent), deployment strategies, and environment management.

**Use when:** Setting up or modifying build and deployment pipelines.

#### documentation-and-adrs
Document decisions, not just code. Covers Architecture Decision Records (ADRs), API documentation, inline documentation standards, README patterns, and changelog maintenance. Emphasizes documenting the *why* — the context future engineers (and agents) will need.

**Use when:** Making architectural decisions, changing public APIs, or shipping features.

#### shipping-and-launch
Ship with confidence. Covers pre-launch checklists, feature flag management, monitoring setup, rollback procedures, staged rollouts, and post-launch verification. The final quality gate before users see your code.

**Use when:** Preparing to deploy to production.

---

## Agents

Pre-configured agent personas for specialized tasks:

| Agent | Purpose |
|-------|---------|
| [code-reviewer](agents/code-reviewer.md) | Senior code reviewer with five-dimension review framework |
| [test-engineer](agents/test-engineer.md) | QA specialist focused on test strategy and coverage |
| [security-auditor](agents/security-auditor.md) | Security-focused reviewer for vulnerability detection |

---

## Project Structure

```
agent-skills/
├── README.md                          # This file
├── AGENTS.md                          # Guidance for AI agents
├── CLAUDE.md                          # Claude Code configuration
├── LICENSE                            # MIT License
├── .claude-plugin/
│   ├── plugin.json                    # Claude Code plugin manifest
│   └── marketplace.json               # Claude Code marketplace catalog
├── .claude/
│   └── commands/                      # Slash commands (standalone use)
├── skills/                            # Core skills (SKILL.md per directory)
│   ├── idea-refine/                   # Define phase: Idea refinement
│   ├── using-agent-skills/            # Meta: how to use this pack
│   ├── spec-driven-development/       # Define phase
│   ├── planning-and-task-breakdown/   # Plan phase
│   ├── context-engineering/           # Build phase
│   ├── incremental-implementation/    # Build phase
│   ├── frontend-ui-engineering/       # Build phase
│   ├── api-and-interface-design/      # Build phase
│   ├── test-driven-development/       # Verify phase
│   ├── browser-testing-with-devtools/ # Verify phase
│   ├── debugging-and-error-recovery/  # Verify phase
│   ├── code-review-and-quality/       # Review phase
│   ├── security-and-hardening/        # Review phase
│   ├── performance-optimization/      # Review phase
│   ├── git-workflow-and-versioning/   # Ship phase
│   ├── ci-cd-and-automation/          # Ship phase
│   ├── documentation-and-adrs/        # Ship phase
│   └── shipping-and-launch/           # Ship phase
├── agents/                            # Reusable agent personas
│   ├── code-reviewer.md
│   ├── test-engineer.md
│   └── security-auditor.md
├── hooks/                             # Session lifecycle hooks
├── references/                        # Supplementary reference material
└── docs/                              # Setup guides
```

---

## Design Principles

**1. Encode process, not just knowledge.** Each skill is a workflow the agent follows, not a reference document it reads. Skills have steps, verification points, and exit criteria.

**2. Progressive disclosure.** The `SKILL.md` is the entry point. Supporting references are loaded only when relevant, keeping token usage minimal.

**3. Anti-rationalization.** Critical skills include tables of common excuses agents use to skip steps, with rebuttals. "I'll add tests later" has a documented counter-argument.

**4. Verification is non-negotiable.** Every skill includes a verification step. "Seems right" is never sufficient — there must be evidence (tests, build output, runtime data).

**5. Tool-agnostic, Claude-optimized.** Skills are plain Markdown that works with any agent, but the project structure is optimized for Claude Code's skill discovery and session hooks.

**6. Opinionated where it matters.** These skills take clear positions on practices that experienced engineers agree on: test before merge, spec before code, measure before optimize. They don't try to be neutral on settled questions.

---

## Philosophy

This project exists because AI coding agents are only as good as the practices they follow. A senior engineer's value isn't just in writing code — it's in knowing *when* to write a spec, *what* to test, *how* to review, and *when* to ship. **Agent Skills** packages that judgment into reusable, enforceable workflows.

The skills draw from established engineering practices at companies like Google, Anthropic, and Vercel, combined with hard-won lessons from the AI-assisted development community. They're designed for the modern stack: TypeScript/JavaScript-heavy, web-first, deployed continuously, built with AI assistance but held to human standards.

> "AI coding assistants are incredible force multipliers, but the human engineer remains the director of the show." — Addy Osmani

---

## Contributing

Skills should be:
- **Specific**: Actionable steps, not vague advice
- **Verifiable**: Clear exit criteria with evidence requirements
- **Battle-tested**: Based on real engineering workflows, not theoretical ideals
- **Minimal**: Only the content needed to guide the agent correctly

See [docs/skill-anatomy.md](docs/skill-anatomy.md) for the skill format specification.

---

## License

MIT — use these skills in your projects, teams, and tools.
