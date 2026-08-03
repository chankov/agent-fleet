# Getting Started with agent-fleet

agent-fleet works with any AI coding agent that accepts Markdown instructions. This guide covers the universal approach. For tool-specific setup, see the dedicated guides.

## How Skills Work

Each skill is a Markdown file (`SKILL.md`) that describes a specific engineering workflow. When loaded into an agent's context, the agent follows the workflow — including verification steps, anti-patterns to avoid, and exit criteria.

**Skills are not reference docs.** They're step-by-step processes the agent follows.

## Install path — which one fits you?

| Audience | Path | Why |
|---|---|---|
| **Most users** — you want to use the skills in your projects | `npx @chankov/agent-fleet init` | One command; semver updates; cross-platform; no source dir to babysit. See [docs/npm-install.md](npm-install.md). |
| **You already know what you want** — or you're scripting a fresh repo | `npx @chankov/agent-fleet install --agent <a> --profile recommended --yes` | The CLI does every write itself: no coding agent, no model, no prompts. |
| **Claude Code users** — you live in Claude Code and want plugin-managed updates | `/plugin marketplace add chankov/agent-fleet` | Best UX inside Claude Code; marketplace handles the lifecycle. |
| **Skill authors / contributors** — you want to edit the skills themselves | `git clone` + work in the checkout | Inside an agent-fleet checkout `--method symlink` is available, so editing an installed artifact edits the source. |

`init` is the conversational front-end; `install` is the engine underneath it.
Both end up in the same place — the same manifest, the same install record, the
same three-way merge on the next `upgrade`. None of the paths is being deprecated.

### Installing without an agent

```bash
npx @chankov/agent-fleet install --agent pi --profile recommended --yes
npx @chankov/agent-fleet verify              # read-only report: recorded × on disk × shipped
npx @chankov/agent-fleet upgrade --dry-run   # what a refresh would change
```

Profiles: `minimal`, `recommended`, `full`, `pi-fleet-core`, `hermes-plugins`,
`codex-bridge`. Pick individual artifacts instead with `--items skill:test-driven-development,persona:code-reviewer`.
Every verb takes `--dry-run` and `--json`. **Artifacts install as copies** —
refresh them with `agent-fleet upgrade`, which keeps local edits and writes an
incoming conflict beside your file as `<file>.new`.

## Optional: see the fleet in Hermes Desktop

Once you are running more than one or two agents, `agent-fleet-herdr` gives you
a live panel of every Agent Fleet session — grouped by project, sorted so the
agent blocked on a human is at the top, with a toast when one gets stuck or
dies mid-work.

**You need:** Hermes v0.19.0+ with the Desktop app (`hermes` on `PATH`), this
repo checked out, and a fleet that has run at least once so
`~/.pi/coms/projects/` exists. [herdr](https://herdr.dev) is optional; without
it every row reads `unknown` instead of a live state.

```bash
# 1. link both halves into the profile and open the enable gate
scripts/install-hermes-plugin.sh agent-fleet-herdr        # --profile dev / --copy / --dry-run

# 2. restart the HERMES DESKTOP APP
#    (not `hermes gateway restart` — the pane talks to the gateway Desktop spawns for itself,
#     and backend routes only mount when that app starts)

# 3. start a fleet and open the "Agent Fleet" tab
just fleet team default
```

Nothing about how you launch a fleet changes: the panel reads what the fleet
already writes (the coms registry, herdr presence, and each agent's own
transcript). It is read-only apart from `Focus pane` and cancelling a hub's
subagent. Uninstall with `scripts/install-hermes-plugin.sh agent-fleet-herdr
--uninstall`.

![The Agent Fleet panel in Hermes Desktop listing seven live sessions in one project](assets/hermes-desktop-agent-fleet-panel.png)

Full runbook — prerequisites, API, join rules, event kinds, the optional
Telegram fan-out, and the failure modes that all look like an empty panel:
**[hermes-desktop-plugins.md](hermes-desktop-plugins.md)**.

Separately, the [coms ⇄ Hermes bridge](coms-hermes-bridge.md) relays an agent's
`ask_user` question to Telegram and races your phone's answer against a local
one. The two are independent; you can run either without the other.

## Optional experimental Android conductor

Linux/pi fleet users can pair Codex Remote Control with ChatGPT Android and delegate one approval-gated task at a time to peers already running in a coms project. It is optional, supports only Codex CLI `0.144.x`, requires Node `22.6+` and user systemd, and does not replace Hermes as the inbound `ask_user` route.

```bash
cd /path/to/agent-fleet
just fleet conductor codex setup docs --project af
just fleet conductor codex pair
just fleet conductor codex start
just fleet team docs --project af
```

The runtime contract is generated under `$HOME/.local/state/agent-fleet/codex-conductor/`, outside the checkout. Pairing is interactive secret-bearing output and must never be captured. Read the complete [Codex conductor runbook](codex-remote-conductor.md) before enabling the service.

## Quick Start (Any Agent)

The CLI installs into `claude-code`, `opencode`, and `pi` workspaces. For **any
other** agent it has no target paths to write to, so the skills are loaded by
hand — that is what this section covers.

### 1. Get the files

```bash
npm install --save-dev @chankov/agent-fleet    # or:
git clone https://github.com/chankov/agent-fleet.git
```

> The npm path puts the package contents in `node_modules/@chankov/agent-fleet/`.
> Use whichever of the two you have wherever this guide says "the agent-fleet repo."
> Don't use `agent-fleet install` here — it writes to `.claude/`, `.opencode/`, or
> `.pi/`, which an agent outside those three won't read.

### 2. Choose a skill

Browse the `skills/` directory. Each subdirectory contains a `SKILL.md` with:
- **When to use** — triggers that indicate this skill applies
- **Process** — step-by-step workflow
- **Verification** — how to confirm the work is done
- **Common rationalizations** — excuses the agent might use to skip steps
- **Red flags** — signs the skill is being violated

### 3. Load the skill into your agent

Copy the relevant `SKILL.md` content into your agent's system prompt, rules file, or conversation. The most common approaches:

**System prompt:** Paste the skill content at the start of the session.

**Rules file:** Add skill content to your project's rules file (CLAUDE.md, AGENTS.md, etc.).

**Conversation:** Reference the skill when giving instructions: "Follow the test-driven-development process for this change."

### 4. Use the meta-skill for discovery

Start with the `using-agent-skills` skill loaded. It contains a flowchart that maps task types to the appropriate skill.

## Recommended Setup

### Minimal (Start here)

Load three essential skills into your rules file:

1. **spec-driven-development** — For defining what to build
2. **test-driven-development** — For proving it works
3. **code-review-and-quality** — For verifying quality before merge

These three cover the most critical quality gaps in AI-assisted development.

### Full Lifecycle

For comprehensive coverage, load skills by phase:

```
Starting a project:  spec-driven-development → planning-and-task-breakdown
During development:  incremental-implementation + test-driven-development
Before merge:        code-review-and-quality + security-and-hardening
Before deploy:       shipping-and-launch
```

### Context-Aware Loading

Don't load all skills at once — it wastes context. Load skills relevant to the current task:

- Working on UI? Load `frontend-ui-engineering`
- Debugging? Load `debugging-and-error-recovery`
- Setting up CI? Load `ci-cd-and-automation`

## Skill Anatomy

Every skill follows the same structure:

```
YAML frontmatter (name, description)
├── Overview — What this skill does
├── When to Use — Triggers and conditions
├── Core Process — Step-by-step workflow
├── Examples — Code samples and patterns
├── Common Rationalizations — Excuses and rebuttals
├── Red Flags — Signs the skill is being violated
└── Verification — Exit criteria checklist
```

See [skill-anatomy.md](skill-anatomy.md) for the full specification.

## Using Agents

The `agents/` directory contains pre-configured agent personas:

| Agent | Purpose |
|-------|---------|
| `code-reviewer.md` | Five-axis code review (read-only) |
| `test-engineer.md` | Test strategy and writing |
| `security-auditor.md` | Vulnerability detection (read-only) |
| `web-performance-auditor.md` | Core Web Vitals & performance audit (read-only, via `/webperf`) |
| `planner.md` | Numbered implementation plans (read-only) |
| `plan-reviewer.md` | Critiques and validates plans (read-only) |
| `builder.md` | Implements an approved plan |
| `documenter.md` | READMEs and inline docs |

Load an agent definition when you need specialized review. For example, ask your coding agent to "review this change using the code-reviewer agent persona" and provide the agent definition.

## Using Commands

The `.claude/commands/` directory contains slash commands for Claude Code:

| Command | Skill Invoked |
|---------|---------------|
| `/setup-agent-fleet` | guided-workspace-setup |
| `/spec` | spec-driven-development |
| `/plan` | planning-and-task-breakdown |
| `/build` | incremental-implementation + test-driven-development |
| `/build auto` | planning-and-task-breakdown → incremental-implementation + test-driven-development (whole plan, one approval) |
| `/test` | test-driven-development |
| `/review` | code-review-and-quality |
| `/code-simplify` | code-simplification |
| `/ship` | shipping-and-launch |
| `/webperf` | web-performance-auditor (specialist agent, web apps only) |

## Using References

The `references/` directory contains supplementary checklists:

| Reference | Use With |
|-----------|----------|
| `testing-patterns.md` | test-driven-development |
| `performance-checklist.md` | performance-optimization |
| `security-checklist.md` | security-and-hardening |
| `accessibility-checklist.md` | frontend-ui-engineering |
| `definition-of-done.md` | incremental-implementation, planning-and-task-breakdown |
| `observability-checklist.md` | observability-and-instrumentation |
| `orchestration-patterns.md` | orchestration-verification, designing-agents |
| `prompting-patterns.md` | context-engineering |

Load a reference when you need detailed patterns beyond what the skill covers.

## Spec and task artifacts

The `/spec` and `/plan` commands create working artifacts (`SPEC.md`, `tasks/plan.md`, `tasks/todo.md`). Treat them as **living documents** while the work is in progress:

- Keep them in version control during development so the human and the agent have a shared source of truth.
- Update them when scope or decisions change.
- If your repo doesn’t want these files long‑term, delete them before merge or add the folder to `.gitignore` — the workflow doesn’t require them to be permanent.

## Contributor verification

The live Agent Fleet hub delegation smoke is intentionally outside the default unit suite. It uses the current checkout's `HEAD` and a deterministic local Pi fixture (no network/model call):

```bash
node --test scripts/agent-fleet-head-count-smoke.test.mjs
```

## Tips

1. **Start with spec-driven-development** for any non-trivial work
2. **Always load test-driven-development** when writing code
3. **Don't skip verification steps** — they're the whole point
4. **Load skills selectively** — more context isn't always better
5. **Use the agents for review** — different perspectives catch different issues
