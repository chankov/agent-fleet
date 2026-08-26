# Major-release migration guide

This is a large major release. Four independent changes land together, and each
one breaks something different:

| # | Change | Who it breaks | Section |
|---|---|---|---|
| 1 | Guided LLM setup replaced by deterministic `setup`/`doctor`/`uninstall` | Anyone who installed or updated with the old guided flow | [Lifecycle](#1-the-lifecycle-is-deterministic-now) |
| 2 | Claude Code removed as a coding-agent install target | Workspaces installed with `--agent claude-code` | [Claude Code](#2-claude-code-is-a-coms-peer-only) |
| 3 | OpenCode support removed entirely | Workspaces installed with `--agent opencode` | [OpenCode](#3-opencode-is-gone) |
| 4 | Pi Fleet startup unified behind one guarded Agent Hub runtime | Scripts and habits built on `just fleet hub` / `just fleet team` | [Fleet runtime](#4-one-unified-just-fleet-runtime) |

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
| Fresh Full automation | `npx @chankov/agent-fleet@<exact-version> setup --preset full --features none --yes` | All stable, platform-applicable catalogue roots; experimental Codex Remote stays excluded. |
| Finish the install | `just fleet deps` (or `setup --allow-exec`) | Setup writes files and runs no commands. The `npm` steps are planned as `skip`; the workspace is not launchable until they run. |
| **Routine update** | `just fleet setup --dry-run`, then `just fleet setup` | Reconciles to the desired state already in `.ai/agent-fleet.json`; no flags needed. |
| Stable features | `... setup --preset default --features voice,browser --yes` | `hermes`, `telegram` (requires `hermes`), and `claude-bridge` are stable; `codex-remote` is an explicit experimental opt-in. |
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
the hook still installs to `.claude/hooks/` under the **pi** agent, because the
pane reading it is a Claude Code process. Registering it in `.claude/settings.json`
remains a manual step — see [claude-code-coms-bridge.md](claude-code-coms-bridge.md).

**Unchanged:** the bridge itself — `scripts/coms-claude-bridge.ts`,
`scripts/lib/claude-bridge-core.ts`, `skills/peer-coms/`, the `_claude-peer`
recipe, `runner: claude-code` peers in `.pi/agents/peers.yaml`, and the
`dispatch-policy.yaml` routing that lets a bridged pane serve a team member's
dispatch. Cross-model review through a standing Claude session works as before.

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
#    Keep .claude/hooks/ if you use the coms bridge.
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
just fleet --agents frontend                     # native roster; orchestrator inferred
just fleet --work-mode operator --agents frontend  # direct work plus the same roster
just fleet --no-coms                             # direct/native work, no peer messaging
just fleet --herdr --project af                  # one Hub pane, no standing peers
just fleet --agents frontend --peers frontend --project af
```

New in the same change: live `/af-work-mode` switching, on-demand native roster
growth (`/af-agents-add`), deterministic `dispatch_agent` routing through
`backend: auto|native|coms`, and same-project dynamic Pi or Claude Code peer
spawning through Herdr.

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

## Retired surfaces

The retired installer implementation and its two setup/doctor prompts are
intentionally absent. All other `af-*` lifecycle and operational prompts remain
public. Historical changelog and planning text may mention retired surfaces as
history only.
