<!--
  FORK.md — the canonical record of how this fork differs from upstream.

  Audiences:
    1. Users evaluating this fork vs. the original (read "Why this fork" + "What's
       different at a glance").
    2. The maintainer reconciling an upstream merge (read "Upstream sync playbook").

  This is the source of truth for fork direction and drop/keep/adapt decisions.
  Update it in the same change that alters fork behavior — especially after every
  upstream merge. It is documentation, not a skill: keep it out of agent context.
-->

# Fork notes — `chankov/agent-skills`

This repository is a fork of [**addyosmani/agent-skills**](https://github.com/addyosmani/agent-skills). It keeps the upstream skill library and lifecycle commands, drops the harnesses this fork doesn't support, and adds a **pi runtime layer** plus **npm packaging** on top.

| | |
|---|---|
| **Upstream** | `addyosmani/agent-skills` (git remote `upstream`) |
| **This fork** | `chankov/agent-skills` (git remote `origin`) |
| **npm package** | `@chankov/agent-skills` |
| **Claude Code marketplace** | `nc-agent-skills` |
| **Relationship** | Tracking fork — periodically merges upstream, then reconciles per the playbook below |

---

## Why this fork

Upstream is a broad, multi-harness plugin marketplace that targets many coding agents (Claude Code, OpenCode, Gemini, Antigravity, Cursor, Copilot, Windsurf, …). This fork makes two deliberate bets the upstream doesn't:

1. **Three harnesses only — Claude Code, OpenCode, and pi.** Everything for the other agents is dropped on every merge. Less surface area, no half-maintained install paths, and every doc/command/persona is verified against the three harnesses that are actually used.
2. **pi is a first-class runtime, not just a target.** The fork adds `agent-hub` — a thin-context multi-agent harness — plus `coms`, `damage-control`, persona model-switching, and nested delegate subagents. On pi, the skills and personas run as a *live team* under a Verification Contract, not just as prompt text.

On top of that, the fork ships **npm packaging** (`@chankov/agent-skills` with a CLI, changeset-based releases, and version-aware update flow) that upstream's plugin-only distribution doesn't have.

**Pick this fork if** you run pi (or want the multi-agent harness), or you want the skills via `npx`/npm with versioned updates.
**Pick upstream if** you need Gemini / Antigravity / Cursor / Copilot / Windsurf support, or you want the canonical, widest-reach plugin marketplace.

See [`docs/comparison.md`](docs/comparison.md) for how the *project as a whole* compares to other skill collections (Superpowers, Matt Pocock's skills) — that doc is upstream-shared and is about peers, not about this fork-vs-upstream split.

---

## What's different at a glance

### Added by the fork (not in upstream)

| Area | What | Where |
|---|---|---|
| **pi runtime — harnesses** | `agent-hub` (dispatcher + specialists + research helpers + Verification Contract), `coms` (P2P messaging), `damage-control` / `damage-control-continue` (tool guardrails) | `.pi/harnesses/` |
| **pi runtime — extensions** | Always-on utilities: `mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`, `btw`, `agent-skills-update-check` | `.pi/extensions/` |
| **pi orchestration config** | Teams, peers, chains, model profiles, damage-control rules | `.pi/agents/`, `.pi/damage-control-rules.yaml` |
| **Agent personas** | 15 canonical pi-flavored personas (incl. `web-performance-auditor`, `bowser`, `web-debugger`, `orchestrator`) generated per-harness via `transform-persona` | `agents/`, `.pi/skills/bowser/` |
| **npm CLI + packaging** | `agent-skills` CLI, `transform-persona`, `doctor`, update-notifier, version snapshots, changeset releases | `bin/`, `.changeset/`, `.versions/`, `.github/workflows/release.yml`, `package.json`, `.npmignore` |
| **Fork-only skills** | `designing-agents`, `guided-workspace-setup`, `orchestration-verification` | `skills/` |
| **Fork commands** | `/design-agent`, `/doctor-agent-skills`, `/prime`, `/setup-agent-skills` (+ OpenCode `as-` mirrors, pi prompts) | `.claude/commands/`, `.opencode/commands/`, `.pi/prompts/` |
| **pi & npm docs** | `pi-setup.md`, `pi-extensions.md`, `pi-specs/`, `npm-install.md`, `publishing.md`, `agent-skills-setup.md`, `NPM/` | `docs/` |
| **Dev tooling** | `justfile` (launch pi per harness), `scripts/team-up.ts`, harness/CLI tests | `justfile`, `scripts/`, `bin/test/` |

### Dropped by the fork (present upstream, removed on every merge)

| Dropped harness / file | Reason |
|---|---|
| `.gemini/commands/*`, `docs/gemini-cli-setup.md` | Gemini not supported |
| `commands/*.toml`, root `plugin.json`, `docs/antigravity-setup.md` | Antigravity not supported |
| `docs/copilot-setup.md` | Copilot not supported |
| `docs/cursor-setup.md` | Cursor not supported |
| `docs/windsurf-setup.md` | Windsurf not supported |
| `scripts/validate-commands.js`, `scripts/validate-skills.js` | CommonJS; fork's `package.json` is `"type": "module"` (ESM). `validate-commands` is also hardcoded to the claude/gemini/antigravity matrix. Fork uses its own ESM tests + `test-plugin-install.yml`. |
| jq-based `hooks/session-start.sh` overwrite + `hooks/session-start-test.sh` | Fork uses a **node-based** session-start hook (no `jq` dependency). |
| `hooks/sdd-cache-*.sh`, `hooks/SDD-CACHE.md` | Unwired, `jq`-dependent, not referenced in `hooks.json`. |

> The "dropped" list is the fork's standing position. If a future upstream merge re-introduces any of these paths, delete them again as part of reconciling the merge.

### Adapted (kept from upstream, but fork-aligned)

These files exist in both and must be **merged, not overwritten** — keep the fork's framing while pulling in upstream's substantive edits:

- `README.md` — fork leads with `agent-hub` / pi and the three-harness reach; keep that headline.
- `docs/agents.md`, `docs/comparison.md`, `AGENTS.md` (orchestration section) — tooling reach is claude-code / opencode / pi; pi's `agent-hub`/`orchestrator` is the sanctioned exception to "personas don't call personas".
- `CONTRIBUTING.md` — drop any "Testing Hooks" section that assumes the jq hook tests.
- Any harness-agnostic **skill / reference** improvement — adopt freely; if upstream adds a persona worth keeping (e.g. `web-performance-auditor` was adopted as a persona), give it canonical pi frontmatter and wire `/<name>` for Claude Code + `as-<name>` for OpenCode.

---

## Upstream sync playbook

Run this every time you merge `upstream/main`. The goal: take upstream's genuine improvements, re-drop the unsupported harnesses, and keep this file current.

```bash
git fetch upstream
git checkout -b sync/upstream-into-fork
git merge upstream/main        # resolve, then apply the decision table below
```

**Decision table — for each changed path, do one of:**

| Verdict | Applies to | Action |
|---|---|---|
| **Drop** | Anything in the "Dropped by the fork" table above (Gemini / Antigravity / Copilot / Cursor / Windsurf / upstream validate scripts / jq hooks / sdd-cache) | `git rm` it; it does not belong in the fork. |
| **Copy as-is** | Harness-agnostic skill content, `references/`, bug fixes, wording in shared docs that doesn't touch fork framing | Accept the upstream version. |
| **Adapt** | Anything in the "Adapted" list — README, `docs/agents.md`, `docs/comparison.md`, `AGENTS.md`, `CONTRIBUTING.md`, new upstream personas | Merge by hand: keep fork framing (3 harnesses, pi/agent-hub), fold in upstream's real changes. |
| **Fork-only, ignore upstream** | `bin/`, `.pi/`, `agents/`, `.changeset/`, `.versions/`, `justfile`, `package.json` packaging | Upstream rarely touches these; keep the fork's version. Never let an upstream merge revert npm/pi infra. |

**After resolving:**

1. `node bin/cli.js transform-persona --all` if any `agents/*.md` changed — never hand-edit generated persona frontmatter.
2. `npm test` (CLI smoke + `node --test`) and `npm run pack:dry`.
3. **Update this file** — move anything newly dropped/added/adapted into the right table, and add a dated entry to the decision log below.
4. `npx changeset` for any user-visible change.

---

## Decision log

Newest first. One entry per notable fork decision — especially anything that changes the drop/keep/adapt tables above.

- **2026-06-26** — Created `FORK.md` as the canonical record of fork direction, the drop/keep/adapt playbook, and this log. Supersedes the ad-hoc sync notes that previously lived only in maintainer memory.
- **(ongoing)** — Standing drop policy: Gemini, Antigravity, Copilot, Cursor, Windsurf support; upstream CommonJS validate scripts; jq-based session-start + sdd-cache hooks. Re-applied on every upstream merge.
- **2026-06-19** — Decided **not** to split `agent-hub` into its own repo. It stays inside agent-skills as a two-layer product: content (`skills/`, `agents/`, `references/`) + runtime (`agent-hub`, `coms`, `damage-control`). Splitting would sever the persona↔skill coupling (e.g. `orchestrator` → `orchestration-verification`). Defer even an npm-workspace split until an external consumer wants the harness without the skills.
- **2026-06-11** — Landed `agent-hub` increments: per-persona model switching (`/agent-model`, `/models`) and nested delegate subagents. The dispatcher LLM is **not** told about model overrides (operator control only).
- **(ongoing)** — `web-performance-auditor` adopted as a first-class persona (15th), with canonical pi frontmatter mirroring `security-auditor`; `/webperf` (Claude Code) and `as-webperf` (OpenCode).
