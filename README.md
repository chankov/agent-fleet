# Agent Fleet

[![npm](https://img.shields.io/npm/v/%40chankov%2Fagent-fleet)](https://www.npmjs.com/package/@chankov/agent-fleet)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![runtimes](https://img.shields.io/badge/runtimes-pi%20%C2%B7%20Claude%20Code%20%C2%B7%20OpenCode-8A2BE2)](#quick-start)

**Operate a coding-agent *fleet* — not just one chat session.**

Agent Fleet is a **multi-agent orchestration system for AI coding agents**, built pi-first: a thin dispatcher routes work to specialist agents under a Verification Contract, whole teams spawn as tiled workspaces you can snapshot and resume, agents message each other over a shared coms plane — and a library of **29 production-grade lifecycle skills** and **15 personas** keeps every agent disciplined. Runs on **pi** (primary runtime), **Claude Code**, and **OpenCode**.

![agent-hub dashboard — the dispatcher grid of specialists and research helpers](docs/assets/agent-hub-dashboard.png)

```text
  You  ──▶  Hub (dispatcher)  ──▶  Team agents  ──▶  Sub-agents
                │                      │
                ├── herdr (workspace)  ├── skills (how to work)
                ├── coms (messages)    └── Verification Contract
                ├── Hermes (phone · inbound ask_user)
                └── Codex Remote Control (phone · outbound delegation, experimental)
```

| Layer | Job |
| --- | --- |
| **[agent-hub](#agent-hub-a-thin-context-dispatcher-for-pi)** | Thin-context dispatcher on **pi** — drives specialists under a Verification Contract |
| **[herdr](https://herdr.dev)** | Fleet control plane — tiled peer workspaces, presence, snapshot/resume |
| **coms** | Peer data plane — bidirectional messaging between agents (including Claude Code panes) |
| **Hermes** | Remote human control — relay hub questions to your phone |
| **Codex conductor (experimental)** | Android-initiated, approval-gated delegation to live coms peers through a user-systemd service |
| **[Skills](docs/skills-catalog.md) + [personas](docs/agents.md)** | Lifecycle discipline — how to spec, plan, build, verify, review, and ship |

---

## Quick Start

### pi (primary runtime)

```bash
pi install -l npm:@chankov/agent-fleet   # project-scoped package: skills, prompts, ask-user
# then, inside pi:
#   /setup-agent-fleet                    # guided install of harnesses, personas, extensions
# and once set up:
just hub          # guarded multi-agent dispatcher
just hub-team docs  # hub + a whole peer team in one tiled herdr workspace
```

### Claude Code / OpenCode

```bash
npx @chankov/agent-fleet init
# then open your coding agent in this directory and run:
#   /setup-agent-fleet
```

The CLI detects your coding agent and `/setup-agent-fleet` runs the full guided install — analysing the workspace, showing grouped menus, and confirming everything before writing a single file.

| CLI command | What it does |
|---|---|
| `npx @chankov/agent-fleet init` | Materialize the package + hand off to `/setup-agent-fleet` |
| `npx @chankov/agent-fleet doctor` | Scan for broken symlinks and stale persona refs |
| `npx @chankov/agent-fleet update` | Surface the version delta + hand off to `/setup-agent-fleet` for the per-artifact diff |
| `npx @chankov/agent-fleet transform-persona` | Generate per-agent subagent files from the canonical personas |

<details>
<summary><b>Other install paths</b> — Claude Code marketplace, git clone + symlinks, OpenCode details</summary>

**Claude Code plugin marketplace** — best UX inside Claude Code:

```
/plugin marketplace add chankov/agent-fleet
/plugin install agent-fleet@nc-agent-fleet
```

> **SSH errors?** The marketplace clones via SSH; use the HTTPS URL instead: `/plugin marketplace add https://github.com/chankov/agent-fleet.git`

**Git clone + symlinks** — best for skill authors and contributors:

```bash
git clone https://github.com/chankov/agent-fleet.git && cd agent-fleet
claude --plugin-dir .    # in Claude Code
# then run /setup-agent-fleet in your target workspace and pick "symlink"
```

Updates flow through `git pull`. Symlinks need Developer Mode on Windows.

**OpenCode** — agent-driven skill execution via `AGENTS.md` + the `skill` tool, plus optional `af-*` slash commands (`/af-spec` … `/af-ship`, `/af-orchestrate`, `/af-compound`). See [docs/opencode-setup.md](docs/opencode-setup.md).

**pi details** — the package bundles `pi-ask-user` (interactive `ask_user` + skill); lifecycle commands load from `.pi/prompts/`, always-on utility extensions from `.pi/extensions/` (mcp-bridge, chrome-devtools-mcp, compact-and-continue, pi-voice-stt push-to-talk dictation), and the selectable harnesses live under `.pi/harnesses/` (loaded via the `justfile`). See [docs/pi-setup.md](docs/pi-setup.md) and the [pi extension catalog](docs/pi-extensions.md).

</details>

### Experimental: delegate to live peers from ChatGPT Android

The optional Codex Remote-Control conductor is verified on Linux with Codex CLI `0.144.x`. Hermes remains the inbound `ask_user` route; Codex is outbound-only and delegates one confirmed task at a time to peers already visible in the same coms project.

```bash
cd /path/to/agent-fleet
just conductor-codex-setup docs --project af   # once per configured context
just conductor-codex-pair                       # interactive; never capture the code
just conductor-codex-start
just hub-team docs --project af                 # hub + peers Codex can reach
```

In ChatGPT Android, open the paired Remote Control host and use the managed external workspace at `$HOME/.local/state/agent-fleet/codex-conductor/workspace`. Do not start a local `codex` process for the Android flow, and do not also launch `conductor-codex docs` when `hub-team docs` already owns the same peers.

Lifecycle, approval flow, examples, recovery, and security boundaries: **[Codex Remote-Control conductor runbook](docs/codex-remote-conductor.md)**.

Versioned with [semver](https://semver.org) — [CHANGELOG.md](CHANGELOG.md) · [docs/npm-install.md](docs/npm-install.md).

---

## agent-hub: a thin-context dispatcher for pi

`agent-hub` turns a single **pi** session into a **dispatcher that drives a live team of specialist subagents** — planner, builder, reviewer, test-engineer, documenter — with read-only research helpers fanning out beneath them, peer-to-peer `coms` messaging embedded, and a `damage-control-continue` guardrail on every tool call.

What makes it different is what it **doesn't** put in front of the dispatcher LLM. Multi-agent setups usually drown the orchestrator: every subagent's output, every research dump flows back into one context window until it compacts and forgets. `agent-hub` is built the other way around:

- **Research never enters the dispatcher context.** Specialists end their turn with `NEEDS_RESEARCH:` lines; the hub fans out read-only helpers, writes findings to disk, and resumes the specialist with file paths. The dispatcher sees a one-line notice — never the raw findings. Each local-disk research tool call has a parent-side 120-second watchdog (configurable as `recon-search-timeout-s` in `.ai/agent-fleet-overrides.md`), not a whole-agent deadline.
- **The Verification Contract lives on disk.** A ledger of checkable acceptance assertions, built from the request *before* any builder runs, rendered as one status line (`Assertions: 2✓ 1○ 1✗ · open: A4`). A stated requirement is never silently dropped, and the contract survives compaction.
- **Specialists run `--no-extensions`.** Tools and credentials stay scoped to the subagent that needs them instead of leaking up into the dispatcher.

![agent-hub compact view with the btw side-session](docs/assets/agent-hub-compact.png)

Personas don't hardcode one frontier model — each declares a default plus a switch list on a three-tier policy (deep reasoning / workhorse / fast recon), switchable at runtime per persona (`/agent-model`) or fleet-wide (`/models <profile>`). `plan-reviewer` and `code-reviewer` can run as **Claude Code peers** for cross-model review.

```bash
just hub              # guarded dispatcher + research + coms + orchestrator persona
just hub-solo         # same, without the coms layer

# fleet recipes (need a running herdr server — https://herdr.dev)
just team-up full     # spawn addressable peers into a tiled herdr workspace
just hub-team docs    # hub + a whole team in ONE workspace
just team-down docs   # snapshot + close cleanly
just team-resume docs # rebuild the grid; pi peers continue their conversations
```

Deep dive: [agent-hub harness README](.pi/harnesses/agent-hub/README.md) (the full dispatch loop, coms layer, configuration) · [fleet hierarchy](docs/ARCHITECTURE.md#fleet-hierarchy) · [pi extension catalog](docs/pi-extensions.md) · [Claude Code coms bridge](docs/claude-code-coms-bridge.md) · [Hermes bridge](docs/coms-hermes-bridge.md) · [Hermes integration screenshots](hermes/README.md#integration-in-action).

---

## The lifecycle: commands and skills

```
  DEFINE          PLAN           BUILD          VERIFY         REVIEW          SHIP
 ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐      ┌──────┐
 │ Idea │ ───▶ │ Spec │ ───▶ │ Code │ ───▶ │ Test │ ───▶ │  QA  │ ───▶ │  Go  │
 │Refine│      │  PRD │      │ Impl │      │Debug │      │ Gate │      │ Live │
 └──────┘      └──────┘      └──────┘      └──────┘      └──────┘      └──────┘
  /spec          /plan          /build        /test         /review       /ship
```

10 slash commands map to the development lifecycle; each activates the right skills automatically:

| What you're doing | Command | Key principle |
|-------------------|---------|---------------|
| Define what to build | `/spec` | Spec before code |
| Plan how to build it | `/plan` | Small, atomic tasks |
| Build incrementally | `/build` | One slice at a time (`/build auto` runs the whole plan in one approved pass) |
| Prove it works | `/test` | Tests are proof |
| Review before merge | `/review` | Improve code health |
| Audit web performance | `/webperf` | Measure before you optimize |
| Simplify the code | `/code-simplify` | Clarity over cleverness |
| Ship to production | `/ship` | Faster is safer |
| Orchestrate a team | `/orchestrate` | Main session drives a config-defined subagent roster (claude-code/opencode; pi uses agent-hub) |
| Capture session lessons | `/compound` | Every session improves the next — lessons land as minimal diffs on your rule tree |

Under the hood are **29 skills** — each a structured workflow with steps, verification gates, and anti-rationalization tables (never vague advice). Skills also activate automatically from what you're doing: designing an API triggers `api-and-interface-design`, building UI triggers `frontend-ui-engineering`.

- **Define:** [interview-me](skills/interview-me/SKILL.md) · [idea-refine](skills/idea-refine/SKILL.md) · [spec-driven-development](skills/spec-driven-development/SKILL.md)
- **Plan:** [planning-and-task-breakdown](skills/planning-and-task-breakdown/SKILL.md)
- **Build:** [incremental-implementation](skills/incremental-implementation/SKILL.md) · [test-driven-development](vendor/agent-skills-upstream/skills/test-driven-development/SKILL.md) · [context-engineering](skills/context-engineering/SKILL.md) · [source-driven-development](vendor/agent-skills-upstream/skills/source-driven-development/SKILL.md) · [doubt-driven-development](vendor/agent-skills-upstream/skills/doubt-driven-development/SKILL.md) · [frontend-ui-engineering](skills/frontend-ui-engineering/SKILL.md) · [api-and-interface-design](vendor/agent-skills-upstream/skills/api-and-interface-design/SKILL.md)
- **Verify:** [browser-testing-with-devtools](skills/browser-testing-with-devtools/SKILL.md) · [debugging-and-error-recovery](vendor/agent-skills-upstream/skills/debugging-and-error-recovery/SKILL.md)
- **Review:** [code-review-and-quality](skills/code-review-and-quality/SKILL.md) · [code-simplification](vendor/agent-skills-upstream/skills/code-simplification/SKILL.md) · [security-and-hardening](skills/security-and-hardening/SKILL.md) · [performance-optimization](skills/performance-optimization/SKILL.md)
- **Ship:** [git-workflow-and-versioning](skills/git-workflow-and-versioning/SKILL.md) · [ci-cd-and-automation](vendor/agent-skills-upstream/skills/ci-cd-and-automation/SKILL.md) · [deprecation-and-migration](skills/deprecation-and-migration/SKILL.md) · [documentation-and-adrs](vendor/agent-skills-upstream/skills/documentation-and-adrs/SKILL.md) · [observability-and-instrumentation](vendor/agent-skills-upstream/skills/observability-and-instrumentation/SKILL.md) · [shipping-and-launch](vendor/agent-skills-upstream/skills/shipping-and-launch/SKILL.md)
- **Orchestrate:** [orchestration-verification](skills/orchestration-verification/SKILL.md) · [peer-coms](skills/peer-coms/SKILL.md)
- **Learn:** [compound-learning](skills/compound-learning/SKILL.md) · **Onboard:** [guided-workspace-setup](skills/guided-workspace-setup/SKILL.md) · **Meta:** [using-agent-skills](skills/using-agent-skills/SKILL.md) · [designing-agents](skills/designing-agents/SKILL.md)

Full catalog with descriptions and triggers: **[docs/skills-catalog.md](docs/skills-catalog.md)**. Format spec: [docs/skill-anatomy.md](docs/skill-anatomy.md).

---

## Agent personas

15 pre-configured specialist personas live in [`agents/`](agents/) — reusable subagent definitions your coding agent delegates work to: `planner`, `plan-reviewer`, `builder`, `code-reviewer`, `test-engineer`, `security-auditor`, `web-performance-auditor`, `documenter`, `architect`, `releaser`, `researcher`, `deep-researcher`, plus the pi-only `bowser`, `web-debugger`, and `orchestrator`.

Each persona is one Markdown file; the canonical format is pi-flavored and `/setup-agent-fleet` transforms it per target agent on install (Claude Code subagents, OpenCode `mode: subagent`, pi as-is). Personas are the *who*, skills are the *how* — each carries a conditional hook to its primary skill, and they compose into teams under the hub or via `/orchestrate`.

Full roster, skill hooks, install matrix, and team composition: **[docs/agents.md](docs/agents.md)**.

---

## Why Agent Fleet?

One coding agent is an assistant; a *fleet* is a team you operate. Agent Fleet exists for the moment a single session stops being enough — when you want a dispatcher driving specialists under a Verification Contract, whole peer teams you can snapshot and resume, Claude Code panes that answer pi agents mid-task, and a phone-reachable human in the loop.

Discipline is the other half. AI coding agents default to the shortest path — skipping specs, tests, and security reviews. The skill library gives every agent in the fleet the same discipline senior engineers bring to production code, baking in practices from [Software Engineering at Google](https://abseil.io/resources/swe-book) and Google's [engineering practices guide](https://google.github.io/eng-practices/): Hyrum's Law in API design, the test pyramid and Beyonce Rule in testing, change sizing in review, Chesterton's Fence in simplification, trunk-based development in git workflow.

**How it compares:** wondering how this stacks up against [Superpowers](https://github.com/obra/superpowers) or [Matt Pocock's skills](https://github.com/mattpocock/skills)? See **[docs/comparison.md](docs/comparison.md)** — an honest, side-by-side look, including a controlled [head-to-head experiment](https://www.linkedin.com/pulse/superpowers-vs-agent-skills-faster-shipping-safer-reasoning-om-mishra-dzakf/).

---

## Documentation

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime layers, fleet hierarchy, module map, external dependencies |
| [docs/getting-started.md](docs/getting-started.md) | First session walkthrough |
| [docs/skills-catalog.md](docs/skills-catalog.md) | All 29 skills with descriptions and triggers |
| [docs/agents.md](docs/agents.md) | All 15 personas: roster, skill hooks, install matrix, teams |
| [docs/pi-setup.md](docs/pi-setup.md) · [docs/pi-extensions.md](docs/pi-extensions.md) | pi install paths, harnesses, and utility extensions |
| [docs/opencode-setup.md](docs/opencode-setup.md) | OpenCode setup and `af-*` commands |
| [docs/agent-fleet-setup.md](docs/agent-fleet-setup.md) | Per-project overrides (`.ai/agent-fleet-overrides.md`) — spec/plan paths, dev server, branch policy, dispatcher language, rules/docs targets |
| [docs/claude-code-coms-bridge.md](docs/claude-code-coms-bridge.md) · [docs/coms-hermes-bridge.md](docs/coms-hermes-bridge.md) · [docs/codex-remote-conductor.md](docs/codex-remote-conductor.md) | Claude Code as a coms peer · phone relay · experimental Codex remote-control operator runbook |
| [docs/npm-install.md](docs/npm-install.md) | CLI reference, versioning, update flow |
| [references/](references/) | 9 checklists skills pull in: testing, security, performance, accessibility, observability, orchestration + fleet-coordination + prompting patterns |

---

## Credits & origins

Agent Fleet started as a customized fork of [Addy Osmani](https://github.com/addyosmani)'s [`agent-skills`](https://github.com/addyosmani/agent-skills) library, with pi session-harness patterns from [IndyDevDan](https://github.com/disler)'s [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) (MIT) growing alongside it. As orchestration became the center of gravity, it split into a standalone project — with the upstream relationship kept honest: Addy's library is vendored **pristine at a pinned SHA** under [`vendor/agent-skills-upstream/`](vendor/agent-skills-upstream/) ([policy](docs/UPSTREAM-SKILLS.md)), and the ported harnesses credit their origin in [docs/pi-extensions.md](docs/pi-extensions.md). Split record: [docs/MIGRATION-agent-fleet.md](docs/MIGRATION-agent-fleet.md).

| Person | Handle | What we draw from |
| --- | --- | --- |
| **IndyDevDan** | [@disler](https://github.com/disler) | Pi session harness patterns — foundation for `agent-hub`, `coms`, `damage-control` |
| **Addy Osmani** | [@addyosmani](https://github.com/addyosmani) | Production-grade lifecycle skills — the vendored upstream skill library |

Thank you both for the inspiration and for shipping work others can build on.

---

## Contributing

Skills should be **specific** (actionable steps), **verifiable** (clear exit criteria with evidence), **battle-tested** (based on real workflows), and **minimal** (only what's needed to guide the agent). See [docs/skill-anatomy.md](docs/skill-anatomy.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT - use these skills in your projects, teams, and tools.
