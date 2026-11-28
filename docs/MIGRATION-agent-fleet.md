# Major-release migration guide

This guide covers the major releases. Each change breaks something different:

| # | Change | Who it breaks | Section |
|---|---|---|---|
| 1 | Guided LLM setup replaced by deterministic `setup`/`doctor`/`uninstall` | Anyone who installed or updated with the old guided flow | [Lifecycle](#1-the-lifecycle-is-deterministic-now) |
| 2 | Claude Code removed as a coding-agent install target | Workspaces installed with `--agent claude-code` | [Claude Code](#2-claude-code-is-a-coms-peer-only) |
| 3 | OpenCode support removed entirely | Workspaces installed with `--agent opencode` | [OpenCode](#3-opencode-is-gone) |
| 4 | Pi Fleet startup unified behind one guarded Agent Hub runtime | Scripts and habits built on `just fleet hub` / `just fleet team` | [Fleet runtime](#4-one-unified-just-fleet-runtime) |
| 5 | The orchestrator work mode removed; one operator | Scripts using `--work-mode`, habits built on `/af-work-mode` or Alt+M | [One operator](#5-one-operator-the-orchestrator-work-mode-is-removed) |
| 6 | Three runtime roles with practices replace the 14 personas; native teams and peer groups removed (2.3.0) | Dispatches, overrides and profiles that name a persona; `teams.yaml`, `peers.yaml`, `just fleet team …`, `/af-agents-*` | [Roles](#6-three-runtime-roles-replace-the-personas) |

If you read only one thing: **update with `just fleet setup --dry-run` first.**
The plan names every file it will overwrite, and this release changes enough
that reading it once is worth the minute.

---

## 1. The lifecycle is deterministic now

The conversational setup layer is gone. `setup`, `doctor`, and `uninstall` are
the public commands, they need no coding agent or model, and every mutation is
planned before it is applied.

**What was removed:** the guided setup skill and its two prompts, the installer
self-removal command, and the raw `--items` / `--profile` selectors on `setup`
(use `--preset <default|full>` and `--features <name[,name]|none>`).

**Compatibility aliases:** `init` and `update` dispatch to `setup`. `install`
and `upgrade` keep their historical selection and three-way-merge semantics and
emit a deprecation warning — they are not replacements for deterministic
automation and do not restore retired prompt or skill surfaces.

### The command matrix

| Situation | Command | Result / gate |
| --- | --- | --- |
| **First install, any repository** | `npx @chankov/agent-fleet@latest setup` | Interactive in a TTY. A repository without Agent Fleet has no justfile — setup writes it — so `just fleet setup` is not available yet. |
| Fresh Default automation | `npx @chankov/agent-fleet@<exact-version> setup --preset default --features none --yes` | Reproducible stable Fleet Core, no voice configuration or `.claude/`. |
| Fresh Full automation | `npx @chankov/agent-fleet@<exact-version> setup --preset full --features none --yes` | All stable, platform-applicable catalogue roots; retired CLI integrations are not selectable. |
| Finish the install | `just fleet deps` (or `setup --allow-exec`) | Setup writes files and runs no commands. The `npm` steps are planned as `skip`; the workspace is not launchable until they run. |
| **Routine update** | `just fleet setup --dry-run`, then `just fleet setup` | Reconciles to the desired state already in `.ai/agent-fleet.json`; no flags needed. |
| Stable features | `... setup --preset default --features voice,browser --yes` | `hermes`, `telegram` (requires `hermes`), and `claude-bridge` are stable. Leftover desired features `codex-remote` and `chatgpt-client` are refused before mutation and require separate backed-up config repair. Native Codex MCP is configured separately; original CLI journals are preserved — see [native setup](codex-local-mcp.md) and [CLI migration](codex-session-bridge.md). |
| Existing desired state | `... setup --preset full --features none --yes` | Flags are ephemeral; existing `.ai/agent-fleet.json` is unchanged. Add `--save-desired` to persist. |
| First legacy migration preview | `... setup --migrate --dry-run` | Lists exact state-owned removals; no consent or writes. |
| First legacy migration mutation | `... setup --migrate --preset default --features none --yes` | Automation requires all three gates: `--migrate`, explicit preset/features, and `--yes`; only unchanged owned extras are removed. |
| Legacy record without state | `... setup --migrate --dry-run` | Preview first; do not assume unrecorded files are owned or removable. |
| Conflict | `... setup --on-conflict theirs` or `--on-conflict ours` | Without a policy setup exits `3` before writes. `ours` keeps the local copy; `theirs` takes the package version. |
| Read-only diagnosis | `... doctor` | Never prompts or writes; actionable findings exit `2`, advisory-only output exits `0`. |
| Repair | `... doctor --fix` | Recovers interrupted transactions and pending runtime repairs. If a transaction backup was reaped, doctor reports the unrecoverable journal; `--fix` safely discards that installer-owned journal because restoration is impossible. |
| Normal removal | `... uninstall --all --yes` | Removes only recorded, unchanged artifacts; desired/override/STT configuration and environment files remain. |
| Config purge | `... uninstall --all --purge-config --yes` | The separate destructive gate removes desired/override/STT config; environment files remain. |
| Self-hosted removal | `just fleet uninstall --yes` | Removes ordinary content, then launcher/managed region, then state; its in-memory report still completes. |
| Self-hosted reinstall | `npx @chankov/agent-fleet@latest setup --preset default --features none --yes` | Restores `just fleet`; then run `just fleet doctor`. |

`just fleet install` was removed; use `just fleet setup` or `just fleet deps`.
`pi update --extensions` updates pi extensions only, never the npm installer.
Published-package commands use `npx`; source-checkout development uses
`node bin/cli.js setup` with equivalent flags.

### The behaviour change most likely to surprise you

`setup` reconciles the workspace **toward the package**. If you edited a shipped
artifact in place and upstream did not change it, `setup` refreshes the file and
your edit is gone — no conflict, no prompt. The old `upgrade` verb preserved
such edits; `setup` does not.

```bash
just fleet setup --dry-run
# refresh  skill:code-review-and-quality
#          locally modified — selecting it overwrites your edits   ← your edit dies here
```

Customize through `.ai/agent-fleet-overrides.md` (human-owned, never touched by
any lifecycle command), through artifacts under names Agent Fleet does not ship,
or by leaving the item out of your selection — `setup` never removes what it
does not select, so an unselected item stays installed and frozen.

Full per-state table: [npm-install.md](npm-install.md#what-reconcile-does-to-each-file).

### Ownership and configuration rules

The state file is the only deletion authority. Unknown extensions, hooks,
settings, recipes, and files are not adopted. Desired state belongs to
`.ai/agent-fleet.json`; project overrides and STT configuration are human
configuration and survive a normal uninstall. Secrets are referenced by
environment-variable name only and are never written to state, journals, desired
state, or `.ai/stt.json`. The installer-owned `.ai/agent-fleet-transaction.json`
is a crash-recovery journal — removed on success or recovery, never a user
configuration file.

---

## 2. Claude Code is a coms peer only

pi is the only agent the installer writes for. Claude Code stays in the fleet as
a **coms peer** and nothing else.

**Gone:** `.claude/commands/` (15 slash commands, including `/orchestrate`) and
`.claude/orchestrate-teams.yaml`; `.claude-plugin/` — Agent Fleet is no longer
published as a Claude Code plugin, and npm is the only distribution channel;
`hooks/session-start.sh`, `hooks/simplify-ignore*.sh`, `hooks/SIMPLIFY-IGNORE.md`,
`hooks/hooks.json`; `agent-fleet transform-persona` and its install strategy; the
`references-hooks` manifest group; and the interactive "which coding agent?"
prompt.

**Replaced by:** `--agent` is still accepted and validated, defaults to `pi`, and
is never asked for. References moved from `.claude/references/` to
`.pi/references/` and are no longer a standalone menu section — each is a
**companion of the skills that cite it**, so installing `code-review-and-quality`
brings `security-checklist.md` and `performance-checklist.md` with it, and
uninstall refuses to strand a skill without its checklists. A new `coms-bridge`
manifest group holds `skill:peer-coms` and its companion `hook:coms-stop-hook`;
the hook installs under the **pi** agent like everything else — 2.0 wrote it to
`.claude/hooks/`, and the runtime relocation moved it to
`.pi/agent-fleet/hooks/coms-stop-hook.mjs`, which `setup` reconciles for you.
Registering it in `.claude/settings.json` remains a manual step — see
[claude-code-coms-bridge.md](claude-code-coms-bridge.md).

**Unchanged:** the bridge itself — `.pi/agent-fleet/scripts/coms-claude-bridge.ts`,
`.pi/agent-fleet/scripts/lib/claude-bridge-core.ts`, `skills/peer-coms/`, the `_claude-peer`
recipe, `runner: claude-code` peers in `.pi/agents/peers.yaml`, and the
`dispatch-policy.yaml` routing that lets a bridged pane serve a team member's
dispatch. Cross-model review through a standing Claude session works as before.
(2.3.0 later removed `peers.yaml` and teams: start the peer with
`just fleet peer <name> --runner claude-code`, and key its route by role; see
[section 6](#6-three-runtime-roles-replace-the-personas).)

### Migrating a `claude-code` workspace

Not automatic. Those `.claude/` artifacts left the catalogue, so `verify` will
not claim them and `uninstall` will not remove them — the ownership rule cuts
both ways.

```bash
# 1. Reinstall for pi.
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
just fleet deps

# 2. See what the installer now considers yours.
just fleet doctor

# 3. Remove the orphaned Claude Code install by hand, after reviewing it.
#    The coms-bridge Stop hook now lives in .pi/agent-fleet/hooks/, so a
#    leftover .claude/hooks/coms-stop-hook.mjs is safe to drop once
#    .claude/settings.json points at the new path.
rm -rf .claude/commands .claude/skills .claude/agents .claude/references
rm -f  .claude/orchestrate-teams.yaml
rm -rf .claude-plugin
```

Review before deleting — `.claude/` may hold your own settings and hooks that
Agent Fleet never wrote.

---

## 3. OpenCode is gone

OpenCode is no longer a recognized agent for any skill, persona, command, or
harness. `--agent opencode` is rejected by every CLI verb, and the installer no
longer knows the `.opencode/` paths — so it can neither install into nor clean
up an OpenCode workspace.

`detect-agent`, `manifest`, `bootstrap`, and `doctor` dropped every `.opencode/`
target path and the OpenCode persona transform. `.opencode/` and
`docs/opencode-setup.md` left the package, and the `opencode` keyword left
`package.json`. `/compound` is gone as an installable command — it only ever
shipped as an OpenCode command file; pi keeps `/af-compound` via the `agent-hub`
harness.

### Migrating an OpenCode workspace

Delete it by hand **before** you upgrade, then install for pi:

```bash
rm -rf .opencode/agent .opencode/skills .opencode/commands
rm -f  .opencode/orchestrate-teams.yaml
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
just fleet deps
```

`.versions/<x.y.z>/` snapshots are left untouched — they are the record of what
each past release actually shipped, and reconciliation diffs against them.

---

## 4. One unified `just fleet` runtime

Pi Fleet startup is now a single guarded Agent Hub runtime. Bare `just fleet`
loads Fleet Core plus Agent Hub in **operator** work mode: direct coding tools
preserved, native roster empty. Work Mode, native specialists, workspace
topology, project scope, and communication capabilities are now selected
independently:

```bash
just fleet                                       # operator, empty native roster
just fleet --agents frontend                     # operator with a native roster
just fleet --no-coms                             # direct/native work, no peer messaging
just fleet --herdr --project af                  # one Hub pane, no standing peers
just fleet --agents frontend --peers frontend --project af
```

New in the same change: on-demand native roster
growth (`/af-agents-add`), deterministic `dispatch_agent` routing through
`backend: auto|native|coms`, and same-project dynamic Pi or Claude Code peer
spawning through Herdr.

> Since 2.3.0, `--agents`, `--peers`, `/af-agents-add` and `just fleet team <preset>`
> are gone; see [section 6](#6-three-runtime-roles-replace-the-personas). The
> examples above describe that earlier release.

### Deprecated forms — accepted for one migration release

| Old | New |
|---|---|
| `just fleet hub` | `just fleet` |
| `just fleet hub --solo` | `just fleet --no-coms` |
| `just fleet team <preset>` | `just fleet --agents <roster> --peers <preset>` |
| `just fleet team <preset> --no-hub` | legacy peers-only topology; no canonical replacement |

Each old form still runs and prints its canonical replacement. Legacy peer-only
presets (`full`, `web`, `docs`) retain the default native roster. Update scripts
during this release — the aliases are removed in the next one.

---

## 5. One operator: the orchestrator work mode is removed

The Hub has one work mode. The operator keeps its direct tools and delegates on its own judgment;
the delegate-only **orchestrator** mode, the `/af-work-mode` command, the **Alt+M** picker and the
`orchestrator` catalog persona are gone (PHILOSOPHY, 2026-11-11).

| Before | Now |
|---|---|
| `just fleet --agents frontend` started the orchestrator | it starts the operator with that roster |
| `just fleet --work-mode operator\|orchestrator` | accepted for one release, ignored with a warning; remove it from scripts |
| `/af-work-mode`, **Alt+M** | removed |
| a resumed orchestrator session with no valid roster blocked model input | the session continues as the operator, with a one-time notice |
| `agents/orchestrator.md` / `.pi/agents/personas/orchestrator.md` | retired; `doctor` reports a leftover copy as retired upstream and the compatibility `upgrade` command proposes removing it. A leftover copy is harmless: the Hub never dispatches it |
| `orchestrator:` under a model profile's `agents:` | ignored instead of invalidating the profile; delete it |
| a writable dispatch beside another writer ran with uncertain attribution | it is refused unless both use `parallel: true` with disjoint exact scopes |

`teams.yaml`, `/af-agents-*`, `dispatch-policy.yaml` and `peers.yaml` were unchanged in that release
(2.3.0 later removed teams and peer groups; see [section 6](#6-three-runtime-roles-replace-the-personas)). If you relied on
the orchestrator to keep a weaker main model away from direct edits, choose a stronger model for the
Hub session; local models remain fully supported as delegated agents.

---

## 6. Three runtime roles replace the personas

Release 2.3.0 (minor). The Hub dispatches three roles, `researcher`, `reviewer`
and `editor`, and each assignment attaches practices from an eleven-entry catalogue.
A practice adds method and expected evidence, never authority. The catalogue is
[agents.md](agents.md).

### Persona → role + practices

Naming a retired persona is refused before anything starts, with the mapping.
There is no alias. Pick the role by the outcome you need.

| Retired persona | Dispatch instead |
|---|---|
| `architect` | `researcher` + `architecture` for analysis; `editor` + `architecture`, `documentation` for an ADR |
| `bowser` | `researcher` + `browser-debugging` to observe; `editor` + `browser-debugging` for stateful interaction or test artifacts |
| `builder` | `editor` + `implementation`, adding `testing` as needed |
| `code-reviewer` | `reviewer` + `independent-review` |
| `deep-researcher` | `researcher` + `research` (one researcher; the question drives the depth) |
| `documenter` | `editor` + `documentation` |
| `plan-reviewer` | `reviewer` + `independent-review`, adding `architecture` or `planning` as needed |
| `planner` | `editor` + `planning` for a saved plan; `researcher` + `planning` for advice |
| `releaser` | `editor` + `release` (prepares only; publishing needs separate permission) |
| `security-auditor` | `reviewer` + `independent-review`, `security`; fixes: `editor` + `security` |
| `test-engineer` | `editor` + `testing` for test changes; `reviewer` + `testing`, `independent-review` for coverage |
| `web-debugger` | `researcher` + `browser-debugging` to diagnose; `editor` + `browser-debugging` for scoped changes |
| `web-performance-auditor` | `reviewer` + `performance`, `independent-review`; writes or optimization: `editor` + `performance` |

```js
// before
dispatch_agent({ agent: "builder", task: "…" })
// now
dispatch_agent({ agent: "editor", practices: ["implementation", "testing"], task: "…", scope: ["src/export"] })
```

Research stays on `spawn_research`, which runs the `researcher` role; its
`persona` parameter accepts only `researcher` or nothing.

Keep `independent-review` in a reviewer's practices when the review must close the
task or register operator current-state evidence. A reviewer with other practices
only (for example `testing`) gives advice, and its result stays preliminary
(`review_practice_missing`).

### Teams and peer groups are removed

| Removed | Use instead |
|---|---|
| `.pi/agents/teams.yaml`, `/af-agents-team`, `/af-agents-add`, `/af-agents-drop`, `/af-agents-save`, the `team_adjust` tool, `--agent-team` | Nothing to activate: the Hub always has the three roles and every practice, and the operator prompt lists them |
| `just fleet --agents <roster>` | `just fleet` (the flag is refused with this reason) |
| `.pi/agents/peers.yaml`, `just fleet --peers …`, `just fleet team <name>` | `just fleet peer <name>` per peer, with `--runner`, `--persona`/`--no-persona`, `--model`, `--read-only`, `--env-file`; `herdr_spawn_peer` from a Hub inside Herdr |
| `just fleet team base` | Still accepted with a warning; use `just fleet --herdr` |
| `just fleet snapshot`, `down`, `resume` | Removed; close a workspace with `herdr workspace close <id>` and start peers again |
| `read_only: true` in `peers.yaml` | `just fleet peer <name> --read-only` |
| `dispatch-policy.yaml` routes keyed by persona or peer name | Keyed by role with a separate address: `reviewer: { peer: claude-reviewer, prefer: coms, fallback: native }` |

`just fleet --herdr` and `just fleet conductor hermes` now open one pane on a
single-pane launcher. A pi peer always loads Chrome DevTools MCP unless it is
read-only. A read-only role reaches only a peer started with `--read-only`, and a
reviewer never reaches a peer address that changed a file in the review's scope.

### Overrides, profiles and doctor

Persona keys in `.ai/agent-fleet-overrides.md` (`model.builder`, `thinking.planner`,
…) no longer have any effect. The Hub keeps no alias and setup never edits the
overrides file. Rename them by hand:

| Before | After |
|---|---|
| `model.builder: <model>` | `model.editor.implementation: <model>` |
| `model.<persona>` for an ambiguous persona (`planner`, `architect`, …) | `model.<role>.<practice>` for the assignment you mean, from the table above |
| `model.<persona>` meaning the whole role | `model.editor`, `model.reviewer`, `model.researcher` |

`thinking.` keys follow the same pattern. `agent-fleet doctor` reports each retired
key with its file and line: the exact replacement for an unambiguous name, and the
mapping for an ambiguous one. It also reports leftover retired definition files.
Both are advisory, and `doctor --fix` changes neither.

A model profile that still names a retired persona fails validation
(`unknown persona "builder"`). Use role keys and `<role>.<practice>` keys such as
`editor.planning`. Per-practice models can also come from a role file's
`practice_models:` and from `/af-agent-model <role>.<practice>`
([precedence](agents.md#models-per-role-and-practice)).

### Installation

The catalogue now ships three role items, `persona:researcher`, `persona:reviewer`
and `persona:editor`, in the group "Agent roles". All three are in the default preset
and come with the Hub; the workflow runtime brings `editor` and `researcher`. On the
next `just fleet setup`, unmodified installed copies of retired personas under
`.pi/agents/personas/` are removed and edited copies are kept as yours. A kept copy is harmless: the Hub never dispatches it and lists it in its
startup notice. Your own `agents/editor.md` (or another role name) still replaces
that role's prompt or model under the same ceiling.

### Flows and commands

| Entry point | Runs |
|---|---|
| `just flow build-test` | `editor` + `implementation`; the test suite stays the flow's deterministic code phase |
| `just flow document` | `editor` + `documentation`, docs-only writes (`docs/`, `**/*.md`), no shell |
| `just flow scout` | `researcher` |
| `/af-compound` | `editor` + `documentation` |

A flow's model is an active complete profile's `editor.<practice>` entry, else the
role file's `practice_models:`, else the role model. Phase names in traces changed
from `builder` to `editor` (`editor-fix-N`).

### Publishing

The `release` practice prepares a release and never publishes. `git push`,
`npm`/`pnpm`/`yarn`/`bun publish`, `changeset publish` and
`gh release create|upload|edit` now need a one-call approval from the damage-control
rules in every session that loads them: the Hub, its native children and pi peers. Scripts that relied on an unattended push from a Hub
session must approve each publish or run it outside the session.

### Poll, Debate and Ask System 1

- A Poll or Debate voice takes the persona `researcher` (default) or `reviewer`; `editor` and retired persona names are refused. Debate is also the operator's `debate_panel` tool, with Poll's panel precedence.
- `consumers.agenticAsk.mode` in `.ai/system1.json` is `on` or `off`. The earlier `advisory` and `recommended` still work and read as `on`, with consent, scope and limits unchanged; `agent-fleet doctor` names them and suggests writing `on`. An `advisory` workspace now gets the recommended prompt guidance whenever the tool is active.
- System 1 still calls TypeSafe through Fleet's own adapter (`transport: direct`), with the credential from the environment variable `apiKeyEnv` names; Pi's `auth.json` and `models.json` are not used for it.

---

## Retired surfaces

The retired installer implementation and its two setup/doctor prompts are
intentionally absent. All other `af-*` lifecycle and operational prompts remain
public. Historical changelog and planning text may mention retired surfaces as
history only.
