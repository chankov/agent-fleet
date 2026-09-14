# Install and lifecycle

<img src="https://raw.githubusercontent.com/chankov/agent-fleet/main/docs/assets/branding/agent-fleet-logo-white-v1.png" alt="Agent Fleet — Many agents. One direction." width="480">

`@chankov/agent-fleet` is a deterministic pi workspace installer. It needs no
coding agent or model: `setup`, `doctor`, and `uninstall` are the public
lifecycle commands.

- [First install](#first-install) — a repository that has never had Agent Fleet
- [Updating an existing install](#updating-an-existing-install) — a new version shipped
- [What reconcile does to each file](#what-reconcile-does-to-each-file) — **read this before your first update**
- [Doctor and uninstall](#doctor-and-uninstall)

## First install

Run the package command from the target repository. There is no `just fleet`
recipe yet — the managed justfile region is one of the things setup *writes* —
so the first install always goes through `npx`:

```bash
cd ~/projects/my-app
npx @chankov/agent-fleet@latest setup
```

In a real TTY this opens the installer: pick **Default**, **Full**, or **Full + all features**, edit the exact feature list, read the complete reconciliation plan, and answer `yes` to apply. Enter never approves mutation. For automation, name the selection and consent up front:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
```

Pin the exact version when the run has to be reproducible:

```bash
npx @chankov/agent-fleet@1.0.0 setup --preset default --features none --yes
```

**Default** is the stable Fleet Core selection and creates neither `.claude/` nor voice configuration. **Full** selects every stable, platform-applicable catalogue root; it may install the recorded Claude Code coms bridge. **Full + all features** is not a permanent preset: it stores `preset: "full"` and an explicit snapshot of every currently platform-compatible feature, including experimental ones, so future features are not silently enabled. Features are named capabilities (`browser`, `voice`, `hermes`, `telegram`,
`claude-bridge`, and the experimental `chatgpt-client`), not an arbitrary
package-entry mode — `setup --help` lists them.

### Then install the runtime dependencies

Setup writes files; it does not run commands for you, and a successful file commit is not reported as runtime readiness unless the existing dependency checks pass. The three `npm` steps for
`.pi/extensions`, `.pi/harnesses`, and `scripts` are planned as `skip` with the
reason *"runs a command — re-run with `--allow-exec` to include it"*. **A
workspace is not launchable until they run.** Either let setup run them:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --allow-exec --yes
```

…or run them afterwards through the recipe setup just installed:

```bash
just fleet deps      # npm install in .pi/extensions, .pi/harnesses, and scripts
just fleet doctor    # confirm the workspace is whole
```

`doctor` runs `npm ls --depth=0` against each installed root. Missing or invalid
runtime trees are launch-blocking findings (exit `2`) with the same two
remediation paths above; `doctor --fix` deliberately does not infer consent to
run a new npm install. The `just fleet` launcher performs the same check before
starting Pi, so an extension import failure cannot be misreported as an unknown
flag such as `--project`.

### Verify the result

```bash
just fleet doctor    # exit 0 = nothing to repair, 2 = repairable findings
just fleet           # Hub in operator work mode, empty native roster
```

From here on `just fleet setup`, `just fleet doctor`, and `just fleet uninstall`
are available as thin wrappers over `npx @chankov/agent-fleet@latest`. They are
a convenience for a workspace that already has the justfile — never the
first-install path.

### Source checkout

Inside an Agent Fleet checkout, use the local CLI instead of the published
package:

```bash
node bin/cli.js setup --workspace ~/projects/my-app --preset default --features none --yes
```

## Updating an existing install

### 1. Notice there is one

A `just fleet` session started from a workspace with an install record prints a
banner at session start when a newer package is published (the shared helper in
`damage-control-continue`, not a standalone pi extension):

```
agent-fleet update available: 0.1.0 → 0.2.0

In the workspace root:
  npx @chankov/agent-fleet@latest setup

Preview without writing:
  npx @chankov/agent-fleet@latest setup --dry-run

Releases:
  https://github.com/chankov/agent-fleet/releases
```

To ask directly, without a session — it prints one line when an update exists
and stays silent when you are current:

```bash
npx @chankov/agent-fleet check-update
```

`pi update --extensions` updates pi's own extensions. It does **not** update
this installer or anything it wrote.

### 2. Preview the reconcile

Always worth it, always free — `--dry-run` creates no lock, backup, journal, or target write and needs no consent. JSON preview uses a versioned public model that deliberately omits internal write buffers (including complete `.env` and config before/after text):

```bash
just fleet setup --dry-run
# or, without the justfile recipe:
npx @chankov/agent-fleet@latest setup --dry-run
```

The plan names every action and its reason. What you are reading for:

| Line in the plan | Means |
|---|---|
| `create` | New in this version, or a feature you added |
| `refresh … source is newer; the local copy is unmodified` | Clean update. Safe. |
| `refresh … locally modified — selecting it overwrites your edits` | **Your edit is about to be lost.** See below. |
| `conflict … changed both locally and upstream` | The run will exit `3` and write nothing until you choose a policy |
| `keep` | Unchanged, or installed but outside this selection |
| `remove` | Retired upstream and recorded as ours |
| `skip … runs a command` | The `npm` steps — follow with `just fleet deps` |

### 3. Apply it

```bash
just fleet setup                # interactive: shows the plan, asks once
just fleet setup --yes          # non-interactive
just fleet deps                 # if the plan skipped the exec steps
just fleet doctor               # verify
```

Your `--preset` / `--features` selection is **remembered**. `.ai/agent-fleet.json`
is the desired state, so a plain `setup` reconciles to whatever that file says —
you do not restate the preset on every update. Flags passed on an update are
ephemeral for that run only unless you add `--save-desired`:

```bash
just fleet setup --features voice,browser --stt-provider groq --yes                  # this run only
just fleet setup --features voice,browser --stt-provider groq --save-desired --yes   # persisted
```

### 4. Handle a conflict

A conflict is *both* sides changing: you edited an installed file **and** the new
version changed the same file. Setup refuses to guess — it exits `3` before
writing anything:

```
conflict  skill:code-review-and-quality  changed both locally and upstream
exit 3
```

Resolve by naming a policy for the run:

```bash
just fleet setup --on-conflict theirs --yes   # take the package version
just fleet setup --on-conflict ours --yes     # keep your copy
```

`theirs` writes the incoming file and your version is gone; `ours` keeps your
file and this item stays behind the package until you reconcile it by hand. To
keep a local edit *and* pick up the new upstream content, copy your edit out
first, take `theirs`, then re-apply it.

### Keeping local edits across updates

If you have customized an installed artifact — a skill under `.pi/skills/`, a
persona under `.pi/agents/personas/` — understand that `setup` is a **reconcile to the
package**, not a merge in your favour. A file you edited where upstream did not
change is refreshed and your edit is overwritten, without a conflict and without
a prompt. `--dry-run` is what makes this visible before it happens.

The durable ways to customize:

- **`.ai/agent-fleet-overrides.md`** — human-owned, never overwritten. Spec/plan
  paths, dev server, branch policy, per-persona models, dispatcher language.
  See [agent-fleet-setup.md](agent-fleet-setup.md). This is the intended door.
- **Your own artifacts** — a skill under a name Agent Fleet does not ship is not
  in the catalogue, so no lifecycle command touches it.
- **Deselect the item** — `setup` never removes what falls outside the current
  selection, so a narrower preset leaves an item installed and frozen (`keep …
  installed but not in this selection`).

Editing a shipped artifact in place is the one approach the lifecycle actively
works against.

## What reconcile does to each file

The engine classifies every recorded file by comparing three things: the copy on
disk, the current package source, and the *baseline* — the same file as it
shipped in the version recorded in `.ai/agent-fleet-state.json`, read from the
package's `.versions/<x.y.z>/` snapshot tree.

| Disk vs source vs baseline | State | `setup` does |
|---|---|---|
| Disk matches source | `up-to-date` | `keep` |
| Disk matches baseline, source moved | `outdated` | `refresh` — clean update |
| Source matches baseline, disk moved | `modified` | **`refresh` — overwrites your edit** |
| Disk and source both moved, differently | `conflict` | exits `3` unless `--on-conflict` |
| Recorded, but no source in this version | `gone` | `keep` (the deprecated `upgrade` proposes removal) |
| Recorded, missing or mis-linked on disk | breakage | `repair`, regardless of selection |

Two things narrow this. If the `.versions/` snapshot for the recorded version is
missing (an unpublished local build, or a version older than retention), there is
no baseline: the comparison degrades to two-way, an edited file reads as
`modified`, and no `conflict` can be detected. And `keep`-on-local-edit is the
behaviour of the **deprecated `upgrade` verb**, not of `setup` — if you have
relied on `upgrade` preserving your edits, that is the difference to plan for.

## Upgrading across the `.pi/agent-fleet` move

Before 2.1 an install wrote `scripts/`, `hermes/`, `agents/` and
`.claude/hooks/` at the root of your project. They are now `.pi/agent-fleet/`
(`scripts/`, `hermes/`, `hooks/`, `docs/`) and `.pi/agents/personas/`, and the
only thing an existing workspace has to do is run `setup` once.

There is no migration script, because none is needed. Changing where an item
installs changes its binding, and reconcile already retires recorded files that
have left one — under the same ownership rule as everything else, so a file you
edited is kept, becomes yours, and is reported by name. Directories the move
empties are pruned; a directory that still holds a file of yours is not.

Two details worth reading before you run it:

- `verify` reports the whole move as one advisory finding
  (`19 item(s) moved: 111 old file(s) to remove, 2 kept`) rather than one per
  path. `verify --json` still lists every path under `items[].obsoleteFiles`,
  each flagged `retained` when it will be kept.
- The state file's `schemaVersion` goes `1` → `2`. A workspace still reading `1`
  is one that has not been reconciled yet; `setup` re-stamps it on the way out.
  The file's shape did not change — only the paths recorded in it.

The Claude Code bridge Stop hook is the one thing reconcile cannot finish for
you: it moves to `.pi/agent-fleet/hooks/coms-stop-hook.mjs`, and Claude Code
only runs it once `.claude/settings.json` names it. `setup` prints the snippet
with the current path when it installs the hook. Nothing else installs under
`.claude/` any more.

## Desired state and migration

The desired selection lives in `.ai/agent-fleet.json` — human-owned, meant to be
committed. Command-line preset and feature flags are ephemeral over an existing
file unless `--save-desired` is passed. When the file is missing, setup writes
the selected desired state in the same transaction as its artifacts.

The first major-release migration, from a workspace that predates the state
file, is deliberately strict:

```bash
# Preview is safe and does not require consent.
npx @chankov/agent-fleet@latest setup --migrate --dry-run

# Automation must name the desired state and explicitly consent to migration.
npx @chankov/agent-fleet@latest setup --migrate --preset default --features none --yes
```

Migration lists each exact removal before consent and removes only unchanged,
state-owned legacy artifacts. Foreign or locally modified files survive.

`init`, `install`, `upgrade`, and `update` are deprecated. `init` and `update`
dispatch to `setup`; `install` and `upgrade` keep their historical selection and
three-way-merge semantics and warn. New scripts should use `setup`.

## Transaction and recovery contract

Mutating lifecycle commands hold `.ai/agent-fleet.lock`; locks are never stolen automatically. Planning refuses an existing `.ai/agent-fleet-transaction.json`. Recovery pre-images live durably under `.ai/.agent-fleet-recovery/`, and journal phases are `prepared`, `applying`, and `committed`. `doctor --fix` restores pre-commit phases or only finalizes cleanup for a durable committed phase. A missing/corrupt backup leaves diagnostics in place and fails honestly. After an operator has verified that the recorded process is gone, `doctor --fix --force` is the explicit stale-lock recovery path.

Plans fingerprint every touched target before approval and re-check immediately before writing. Absolute/`..` journal paths, non-installer backup roots, and target paths crossing parent symlinks are refused. Runtime subprocesses have a 120-second bound and visible start/completion output. Retry state stores an action ID, but the command is always reloaded from the trusted current manifest; saved argv never grants execution authority.

JSON stdout is one clean document. Public plan schema `1` adds a `stage` (`preview`, `config-repair-preview`, or `apply`) while retaining safe plan fields for consumers. Secret-bearing buffers (`text`, complete before/after/original/replacement bodies, and recovery locations) are never serialized.

## Doctor and uninstall

```bash
npx @chankov/agent-fleet doctor                 # read-only; never prompts
npx @chankov/agent-fleet doctor --fix
npx @chankov/agent-fleet uninstall --all --yes
npx @chankov/agent-fleet uninstall --all --purge-config --yes
```

Uninstall removes only paths recorded in `.ai/agent-fleet-state.json`, and
preserves any recorded path whose bytes no longer match what we wrote. It also
preserves human configuration by default: `.ai/agent-fleet.json`,
`.ai/agent-fleet-overrides.md`, `.ai/stt.json`, and environment files.
`--purge-config` is the separate destructive gate for the three human config
files; environment files are never removed.

A self-hosted workspace may use `just fleet uninstall --yes`. It removes ordinary
owned artifacts first, then the managed justfile region and launcher scripts,
and finally lifecycle state/journal data; the already-running command prints its
final report from memory. Because that removes `just fleet`, reinstall with the
package CLI, then use `just fleet` again:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
just fleet doctor
```

## Package-native pi install

```bash
pi install -l npm:@chankov/agent-fleet
```

This exposes package-native skills and prompts. Do not also copy the same skills
and prompts into `.pi/`; `doctor` reports that ownership overlap as a read-only
`pi-package-ownership` advisory. Harness-only composition is supported:
package-native skills/prompts with copied Fleet Core harnesses.

## Safety contract

All lifecycle commands support `--dry-run`; JSON output requires either
`--dry-run` or `--yes`. Files outside state ownership are never adopted for
removal. A failed file transaction rolls back rather than reporting success, and
`.ai/agent-fleet-transaction.json` is the crash-recovery journal `doctor --fix`
reads.

| Exit | Meaning |
|---|---|
| `0` | Success, or nothing to do |
| `1` | Could not run |
| `2` | `doctor` found repairable or launch-blocking manual-action issues |
| `3` | `setup` hit unresolved conflicts and wrote nothing |

See [Migration](MIGRATION-agent-fleet.md) for the full major-release matrix.

## Release operator verification

CI runs the installer and packed-artifact regression suite on Linux and macOS, including the narrow PTY path, then checks `npm pack --dry-run`. Publishing remains a separate protected step. After publishing, the operator must smoke the exact immutable version in a disposable repository before checking the tag:

```bash
version=2.0.7 # released version, never `latest` for the first probe
repo="$(mktemp -d)"
(cd "$repo" && npx "@chankov/agent-fleet@$version" setup --preset default --features none --dry-run --json)
npm view "@chankov/agent-fleet@$version" version
npm view @chankov/agent-fleet@latest version # must equal $version only after the exact-version smoke passes
```

No release verification should target a real application workspace.
