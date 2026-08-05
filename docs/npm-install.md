# npm install path

The `@chankov/agent-fleet` package ships every skill, persona, slash command,
and pi extension as installable content, plus the CLI that installs them. The
CLI is the whole installer: it decides paths, computes per-item state, performs
the three-way merge, and does every write, so a complete install needs no coding
agent and no model. The `guided-workspace-setup` skill is a conversational
front-end over it — it asks which artifacts a project wants and drafts the
overrides file; the CLI does the rest.

## Package name vs CLI name

| | Name |
|---|---|
| **npm package** (use this for `npm install` and the first `npx`) | `@chankov/agent-fleet` |
| **CLI binary** (the command the package ships) | `agent-fleet` |

The package is published under the `@chankov` npm scope to guarantee identity —
only [Nikolay Chankov](https://www.npmjs.com/~chankov) can publish to that
scope. The CLI binary stays the short name `agent-fleet` because that's what
goes on `PATH` after install.

So:

- First time / one-shot: `npx @chankov/agent-fleet <cmd>` — npx resolves the
  scoped package and runs its bin.
- After a project / global install: `npx agent-fleet <cmd>` works too,
  because the bin is named `agent-fleet`.

## Quick start

### Guided workspace setup

```bash
# In the workspace you want to configure:
npx @chankov/agent-fleet init
# Then open your coding agent in this directory and run the command it prints:
#   /af-setup-agent-fleet
#   Pi:          /af-setup-agent-fleet
```

That's it. `npx` fetches the package, the CLI detects your coding agent and
prints the runtime-appropriate command, which runs the full guided install
inside your agent.

### First-class pi package

For pi users who want package-native loading instead of copied setup artifacts:

```bash
# Project-scoped; writes .pi/settings.json
pi install -l npm:@chankov/agent-fleet

# Or global for every pi session
pi install npm:@chankov/agent-fleet
```

The pi package manifest exposes this repo's skills, pi runtime skills, lifecycle prompts, and bundled `pi-ask-user` resources. The bundled companion provides the `ask_user` tool and `ask-user` skill without a separate `pi-ask-user` install.

**Package-native skills/prompts do not compose with a full copied skills/prompts install.** Loading the same skill from `@chankov/agent-fleet` and from `.pi/skills` produces Pi collision warnings. Choose one ownership path, or use harness-only composition (package skills/prompts + copied Fleet Core harnesses, no copied skills/prompts). `agent-fleet verify` reports a read-only `pi-package-ownership` advisory when both paths overlap — see [pi-setup.md](pi-setup.md).

It intentionally does not auto-expose this repo's own `.pi/extensions` or harness directories; install those through guided setup or the pi setup docs so their runtime dependencies are handled explicitly. `pi-codex-image-gen` is also not bundled or required; guided setup may offer it as an optional suggested external npm/pi package when package installation is available, and installs it only if selected (`pi install -l npm:pi-codex-image-gen`). Minimal setup works without it.

The package also ships assets for the **experimental Linux Codex Remote-Control conductor** (`codex/`, `systemd/`, lifecycle/wrapper scripts, recipes, and runbook). Guided setup copies those assets with selected pi harnesses but never enables systemd, edits Codex config, starts a service, or pairs a phone. Those remain explicit operator actions and support only Codex CLI `0.144.x`; see [codex-remote-conductor.md](codex-remote-conductor.md). Its managed runtime contract is created later under `$HOME/.local/state/agent-fleet/codex-conductor/`, not inside the npm package or target checkout.

## Commands

### `npx @chankov/agent-fleet init`

Materializes the package, **bootstraps the installer artifacts** into the
workspace, and hands off to pi's Agent Fleet setup command
(`/af-setup-agent-fleet`, with `/af-doctor-agent-fleet` alongside it).

What `init` writes:

| Agent | Files written to the workspace |
|---|---|
| `pi` | `.pi/prompts/af-setup-agent-fleet.md`, `.pi/prompts/af-doctor-agent-fleet.md`, `.pi/skills/guided-workspace-setup/SKILL.md` |

These are **just the plumbing** — the slash commands, plus the skill they
invoke. The actual catalogue (spec-driven-development, code-reviewer,
test-engineer, pi extensions, …) is picked by you inside the setup workflow. Re-run
`init` to refresh the plumbing after a package upgrade; bootstrap files
are always overwritten because they're scaffolding, not user data.

After the setup workflow finishes its install pass, **the bootstrap files
are removed by default** so they don't clutter your agent's slash-command
list. Re-run `npx @chankov/agent-fleet init` whenever you want the runtime's
setup command back, or pick the "keep the installer commands" option at the
setup flow's confirmation to leave them in place.

### How the skill finds the source package

`init` writes one extra file alongside the bootstrap: `.ai/.agent-fleet-bootstrap.json`.
This is the **authoritative** record of where the npm package lives:

```json
{
  "sourceRoot": "/home/you/.npm/_npx/<hash>/node_modules/@chankov/agent-fleet",
  "version": "0.3.0",
  "agent": "pi",
  "method": "copy",
  "bootstrappedAt": "2026-05-24T..."
}
```

When the Agent Fleet setup command runs inside your agent, it reads this marker
*first* to find the source package. This matters on dev machines where you
may also have a git clone of `agent-fleet` elsewhere — the marker prevents
the skill from accidentally using that clone instead of the version the
user just installed via npm.

If the marker is missing or its `sourceRoot` no longer exists (e.g. npx
cleaned its cache), the skill **asks you explicitly** for the path. It
never scans your filesystem for other agent-fleet repos — that would
silently pick up forks, stale checkouts, or dev clones that aren't what
you installed.

The marker is removed by the same end-of-setup cleanup that removes the
slash commands (`agent-fleet cleanup-installer`).

| Flag | Default | Purpose |
|------|---------|---------|
| `--agent pi` | `pi` | Coding agent; pi is the only install target |
| `--workspace <path>` | `cwd` | Target workspace |
| `--launch` | off | Shell into the coding agent after init (best effort) |

```bash
npx @chankov/agent-fleet init --agent pi
npx @chankov/agent-fleet init --workspace ~/projects/foo
```

### `npx @chankov/agent-fleet doctor`

Finds and repairs breakage. Two sources, one report:

- **Recorded items** that are missing, dangling, or linked outside the source
  root. These are repaired through the *same* `apply()` path `install` writes
  with — a repaired file is byte-identical to a freshly installed one, which is
  the structural reason setup and repair cannot drift apart.
- **The scan**, for what the install record cannot own: broken symlinks in a
  pre-engine workspace, and stale persona names in `.pi/agents/*.yaml`
  (`reviewer` → `code-reviewer`, `red-team` → `security-auditor`).

Overrides problems and malformed `peers.yaml` entries are **advisory** —
reported, never auto-fixed, because the fix is always a hand edit.

| Flag | Default | Purpose |
|------|---------|---------|
| `--workspace <path>` | `cwd` | Target workspace |
| `--agent <name>` | recorded → detected | Override the agent whose targets are checked |
| `--fix` | off | Apply the repairs without prompting |
| `--dry-run` | off | Report only; never write, never prompt |
| `--json` | off | Emit the machine report on stdout |
| `--yes` / `-y` | off | Alias for `--fix` |

| Exit code | Meaning |
|-----------|---------|
| `0` | nothing to repair |
| `1` | could not run |
| `2` | repairable issues found, advisories present, or a repair failed |

```bash
npx @chankov/agent-fleet doctor --workspace ~/projects/foo --dry-run
npx @chankov/agent-fleet doctor --fix
```

### `npx @chankov/agent-fleet verify`

Read-only report of the workspace against `install-manifest.json` — the
generated catalogue of every installable artifact. Compares three things per
item: what `.ai/agent-fleet-state.json` records, what is on disk, and what the
current package ships. Writes nothing and fixes nothing.

| Flag | Default | Purpose |
|------|---------|---------|
| `--workspace <path>` | `cwd` | Target workspace |
| `--agent <name>` | recorded → detected | Override the agent whose targets are checked |
| `--json` | off | Emit the machine report on stdout |
| `--no-doctor` | off | Skip the symlink/persona/overrides scan |

| Exit code | Meaning |
|-----------|---------|
| `0` | no broken items, no problem findings |
| `1` | could not run (bad flags, missing manifest, unreadable workspace) |
| `2` | problem findings, or items in a broken state |

Item states: `absent`, `linked`, `up-to-date`, `outdated`, `modified`,
`partial`, `conflict`, `missing`, `broken-link`, `foreign-link`, `gone`.
An available upgrade (`outdated`) and a deliberate local edit (`modified`) are
reported but do **not** fail the run — neither is a broken workspace.
Findings are likewise split into `problem` and `advisory`; only problems
affect the exit code.

```bash
npx @chankov/agent-fleet verify
npx @chankov/agent-fleet verify --agent pi --json
```

`--json` is also the interface `guided-workspace-setup` builds its menu from:
the report carries `groups` (agent-filtered headings), `profiles` (the
shortcuts), and per-item `subcategory`, `title`, `summary`, `recommended`,
`owned`, and `state` — everything a selection screen needs, from one command.

The manifest itself is generated from the repository tree, never hand-written:

```bash
node bin/build-manifest.js          # regenerate install-manifest.json
node bin/build-manifest.js --check  # fail if the committed copy is stale
```

### `npx @chankov/agent-fleet install` / `upgrade` / `uninstall`

Three verbs over the same manifest, differing only in which action classes they
admit. `install` acts on a selection you name; `upgrade` acts on whatever the
workspace already has; `uninstall` removes what the state file records.

All three write the machine state file `.ai/agent-fleet-state.json` and render
`.ai/agent-fleet-setup.md` from it. No coding agent and no model is involved at
any point.

| Flag | Applies to | Purpose |
|------|-----------|---------|
| `--profile <name[,name]>` | install | Named selections, unioned |
| `--items <id[,id]>` | install, uninstall | Explicit item ids |
| `--all` | uninstall | Remove everything the state file records |
| `-y, --yes` | all | Apply without the confirmation prompt |
| `--allow-exec` | install, upgrade | Include items that run a command |
| `--accept-theirs` / `--accept-ours` | install, upgrade | Resolve conflicts non-interactively |
| `--dry-run` | all | Print the plan, write nothing |
| `--json` | all | Emit the machine plan/result on stdout (needs `--yes` or `--dry-run`) |

| Exit code | Meaning |
|-----------|---------|
| `0` | applied, or nothing to do |
| `1` | could not plan, or a step failed partway |
| `3` | conflicts — changed both locally and upstream |

```bash
npx @chankov/agent-fleet install --agent pi --profile recommended --yes
npx @chankov/agent-fleet install --items skill:test-driven-development --dry-run
npx @chankov/agent-fleet upgrade --dry-run
npx @chankov/agent-fleet upgrade --yes --accept-ours
npx @chankov/agent-fleet uninstall --items skill:peer-coms --yes
npx @chankov/agent-fleet uninstall --all --dry-run
```

Installing into a brand-new repository takes one command and no LLM:

```bash
npx @chankov/agent-fleet@latest install --agent pi --profile recommended --yes
```

Run it without `--profile`, `--items`, or `--yes` in a terminal and it asks
which profile to use; piped or scripted, it requires the flags rather than
guessing a catalogue for you.

Profiles available: `minimal`, `recommended`, `full`, `pi-fleet-core`,
`hermes-plugins`, `codex-bridge`.

**The two verbs treat a local edit differently, on purpose.** Selecting an item
in `install` is your consent to overwrite your edits to it — those items are
listed as `overwrites` in the plan. `upgrade` carries no such consent, so a file
you edited is preserved (`keep`) whenever the source did not also move. When
*both* changed, it is a conflict: the incoming version is written beside yours
as `<file>.new`, your file is left exactly as it is, and the run exits `3`.

Files shared with you — the `justfile` managed region and merged JSON targets
— are only partly ours. Recipes outside the `agent-fleet:harnesses` sentinels
and settings keys we did not write are never read as drift and never rewritten.

A selection never removes anything — installing a narrower profile keeps what is
already there. Upgrade never widens the install either; newly catalogued
artifacts are counted as available and added only by an explicit `install`.

**Artifacts are installed as copies, always.** `--method symlink` is accepted only when the
workspace is itself an agent-fleet checkout (its `package.json` names `@chankov/agent-fleet`) —
the one place where editing an installed artifact is *meant* to edit the source. Anywhere else a
symlink install is a trap: the link target can never move again, an npx cache clean breaks every
link at once, a `git pull` in the source silently rewrites artifacts the workspace never agreed to
change, and Windows needs Developer Mode. A copy plus `agent-fleet upgrade` gives the same
freshness with a real three-way merge behind it.

A workspace that recorded `symlink` before this restriction is not left half-supported: `verify`
reports it as an advisory finding, and the next `install` or `upgrade` re-materialises every
linked item as a real file and flips the recorded method to `copy`. An explicit
`--method symlink` outside a checkout is refused rather than silently downgraded.

**`uninstall` is bound by the ownership rule.** Only paths recorded in
`.ai/agent-fleet-state.json` are eligible, and a recorded file whose bytes no
longer match what we wrote is kept and listed as skipped. Removing an item takes
its companions with it *unless* another installed item still needs them, and an
item another installed item pins is refused by name — so removing one pi
extension cannot delete the `package.json` five others run from, and removing
`damage-control-continue` while `agent-hub` is installed is refused rather than
silently leaving the hub without its safety harness. Removing the last pi
harness strips the `agent-fleet:harnesses` region from the `justfile` and leaves
the rest of the file alone.

**Some items the engine will not apply, by design.** Each carries a `consent`
class: `file` (plain writes, covered by `--yes`), `exec` (runs a command,
requires `--allow-exec`), `external` (a package you install yourself), and
`operator` (a Hermes profile, a user systemd unit, device pairing). Operator and
external items print their declared steps in the plan and are never performed —
including by `--yes`:

```bash
npx @chankov/agent-fleet install --agent pi --profile hermes-plugins --dry-run
npx @chankov/agent-fleet install --agent pi --profile codex-bridge --dry-run
```

Both print the exact command list for a human to run and touch nothing. Their
targets are outside the workspace, which is the one place the engine is allowed
to write — so they stay reported rather than automated, and no out-of-workspace
path ever enters the state file.

### `npx @chankov/agent-fleet update`

Reads the workspace's `.ai/agent-fleet-setup.md`, compares the recorded
package version against the installed package version, and **re-installs the
runtime's setup command** so it is always available after an update.
`guided-workspace-setup` removes the installer command at the end of a run by
default, so a workspace that has completed setup once would otherwise have no
command to hand off to. The actual refresh then runs inside the coding agent via
that command — or, with no agent at all, via `upgrade`.

The agent and install method are recovered from the bootstrap marker written
at init time; if that marker was cleaned up too, `update` auto-detects the
agent (and prompts only when the workspace has more than one agent dir).
Override with `--agent` / `--method`, or preview with `--dry-run`.

```bash
# Upgrade the package itself first, then check the delta:
npm install -g @chankov/agent-fleet@latest
npx agent-fleet update --workspace .
# The setup command is now back — run the command printed by update to review diffs.
```

## Versioning

The package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

| Change | Bump |
|---|---|
| Skill removed, renamed, or its documented workflow changes; persona retired; command removed; install-record schema breakage | **major** |
| New skill, new persona, new command, new option in an existing skill | **minor** |
| Wording fix, doctor scan improvement, CLI bug fix | **patch** |

### Pinning

To pin a workspace to a specific version, install the package as a project
dependency instead of using `npx`:

```bash
npm install --save-dev @chankov/agent-fleet@0.0.1
npx agent-fleet init   # resolves to the pinned 0.0.1
```

Or pin globally:

```bash
npm install -g @chankov/agent-fleet@0.0.1
```

### What "update" actually changes

The package update is just `npm`'s usual upgrade. The interesting part runs
inside the agent: `guided-workspace-setup` reads the `version:` line from
`.ai/agent-fleet-setup.md`, computes the delta against the current package
version, and surfaces per-artifact `Status` based on a three-way diff:

| Status | Means |
|---|---|
| `installed · upgrade available` | Source changed upstream; user copy still matches the old source → clean refresh |
| `installed · conflicting upgrade` | Source changed upstream AND user modified the copy → three-way diff shown, write requires explicit consent |
| `installed · removed upstream` | Artifact gone in the new version → proposed for deletion (subject to the removal-scope rule) |
| `not installed · new in this version` | New artifact added in the new version → offered, marked `★` if recommended |

The diff is sourced from `.versions/<recorded-version>/` inside the package —
a snapshot the release pipeline writes for every published version.

## Other install paths

npm is the recommended path for most users. The other two stay supported:

- **Git clone** — best for skill authors and contributors. Clone the repo and
  work in it directly; inside an agent-fleet checkout `--method symlink` is
  available, so an edit to an installed artifact edits the source. For any other
  workspace, install copies and run `agent-fleet upgrade` after a `git pull`.

All three paths converge on the same `guided-workspace-setup` skill — the
difference is only in how the source files reach the workspace.

## CI usage

Every verb is scriptable, and a complete install needs no agent and no model:

```bash
mkdir fresh-repo && cd fresh-repo && git init
npx --yes @chankov/agent-fleet@latest install --agent pi --profile recommended --yes
npx --yes @chankov/agent-fleet@latest verify
```

Gate on the exit codes: `verify` exits `2` on drift or problem findings,
`upgrade` exits `3` when a file changed both locally and upstream, and `doctor`
exits `2` when anything repairable is left. `--json` puts the machine report on
stdout and nothing else.

Running the same install twice produces zero actions on the second run — that
is asserted by test, not left to discipline.

The conversational flow (`init` → the runtime's setup command) stays interactive
by design; its confirmation gates exist so a human approves every write. Pass
`--agent` explicitly to `init` in CI so it never prompts.

## Receiving update notifications

Three independent mechanisms surface "a new version is published" without
you having to remember to check. All three share a single cache at
`$XDG_CACHE_HOME/agent-fleet/latest-version.json` (24h TTL) so the
registry is hit at most once per day.

### 1. CLI update-notifier (always on)

Every `npx @chankov/agent-fleet <cmd>` invocation runs a fast cache read
on entry. If the cached latest version exceeds the running CLI version, a
banner prints to stderr before the command output:

```
┌──────────────────────────────────────────────────────────────┐
│ agent-fleet update available: 0.1.0 → 0.2.0                 │
│   Run: npx @chankov/agent-fleet@latest update               │
│   Releases: https://github.com/chankov/agent-fleet/releases │
└──────────────────────────────────────────────────────────────┘
```

If the cache is stale, a detached background process refreshes it for the
*next* invocation — the current run is never blocked.

### 2. pi extension (`agent-fleet-update-check`)

When installed from the Pi setup flow, the extension fires on the
first `agent_start` event of each pi session and emits a `ctx.ui.notify`
message in the pi UI if a newer version is published. Reads the same cache
as the CLI — no double-fetching.

### Opting out

Any of these environment variables disables all three:

```bash
export AGENT_SKILLS_NO_UPDATE_CHECK=1   # agent-fleet-specific
export NO_UPDATE_NOTIFIER=1             # conventional, also honoured
# CI=true is auto-detected — banners never appear in CI logs
```

### Forcing a manual check

```bash
# Block on a single registry fetch; print the banner if outdated
npx @chankov/agent-fleet check-update

# Bypass the cache entirely
rm ~/.cache/agent-fleet/latest-version.json
npx @chankov/agent-fleet check-update
```

## Troubleshooting

- **`update` says "no install record".** Run `init` once first; the install
  record is what `update` reads.
- **The version-aware menu shows `(snapshot missing)`.** The recorded version
  is older than the snapshot retention in this package. The skill falls back
  to "treat installed copy as canonical" — refresh manually if you want to
  reset the baseline.
