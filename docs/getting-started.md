# Getting started

Agent Fleet installs deterministic pi workspace content. The public lifecycle is
**setup**, **doctor**, and **uninstall**; no coding agent or model is required.

## Install a new repository

From the target repository, run the package command. `just fleet` does not exist
yet — the managed justfile region is one of the things setup writes — so a first
install always goes through `npx`:

```bash
cd ~/projects/my-app
npx @chankov/agent-fleet@latest setup
```

In a real TTY that opens the installer: choose **Default** or **Full** plus
optional comma-separated features, read the exact plan, and confirm once. For
automation, name the selection and consent:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
```

Choose **Default** for stable Fleet Core or **Full** for all stable,
platform-applicable catalogue roots. Default creates neither voice configuration
nor `.claude/`; Full may install the recorded Claude Code coms bridge. Features
are named additions after preset selection. In an Agent Fleet source checkout,
use `node bin/cli.js setup` instead.

Setup writes files but runs no commands, so finish the install with the npm
steps it deliberately skipped — the workspace is not launchable until they run:

```bash
just fleet deps     # npm install in .pi/extensions, .pi/harnesses, and scripts
just fleet doctor   # exit 0 = nothing to repair
```

(Or pass `--allow-exec` to setup and let it run them in the same pass.)

## First session

```bash
just fleet                                      # Hub/operator; empty native roster
just fleet --agents default --project af        # Hub/orchestrator + native roster
just fleet --agents default --peers docs --project af
                                                # Hub + standing Herdr peers
```

## Run and maintain deterministic flows

When the workflow runtime is selected, `just flow` runs code-owned workflows outside the interactive hub:

```bash
just flow scout "where is authentication configured?"
just flow quality
just flow build-test "add the validated endpoint"
```

Each run creates a `flow/<name>-<runId>` branch. Use the numbered maintenance selector to remove an empty/integrated branch or squash-merge an accepted result back to the branch from which it started:

```bash
just flow cleanup       # list flow branches and prompt for a number
just flow cleanup 1     # safely remove selection 1 through Worktrunk
just flow merge         # list flow branches and prompt for a number
just flow merge 2       # squash-merge selection 2 through Worktrunk
```

Maintenance requires [Worktrunk](https://worktrunk.dev). It refuses dirty worktrees, rejected runs, and unknown merge targets. See [workflows.md](workflows.md#clean-up-and-merge-flow-branches) for `--discard`, `--target`, full branch selectors, non-interactive `--yes`, and safety details.

## Update an existing install

A pi session tells you when a newer version is published. To act on it:

```bash
just fleet setup --dry-run   # preview: what changes, what gets overwritten
just fleet setup             # apply; shows the plan and asks once
just fleet deps              # if the plan skipped the npm steps
just fleet doctor
```

Your preset and features are remembered in `.ai/agent-fleet.json`, so a plain
`setup` reconciles to the selection you already chose.

Two things to know before your first update:

- **`setup` reconciles toward the package.** A file you edited in place is
  refreshed and your edit is overwritten — no prompt, no conflict. Customize
  through `.ai/agent-fleet-overrides.md` instead, which the lifecycle never
  touches.
- **A conflict stops the run.** If you *and* the new version changed the same
  file, setup exits `3` having written nothing; re-run with `--on-conflict
  theirs` or `--on-conflict ours`.

`pi update --extensions` updates pi's own extensions only — never this installer
or what it wrote. Full update reference, including what happens to every file
state: [npm-install.md](npm-install.md#updating-an-existing-install).

## Uninstall

`just fleet uninstall --yes` is for the self-hosted workspace lifecycle; it
removes the launcher last. Reinstall after that with the package CLI, not `just`:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
```

## Pi package-native skills and prompts

For pi package-native skills/prompts instead of copied ones:

```bash
pi install -l npm:@chankov/agent-fleet
```

Do not mix copied and package-native skills/prompts. `doctor` identifies that
ownership overlap. Read [pi-setup.md](pi-setup.md) for runtime composition,
[agent-fleet-setup.md](agent-fleet-setup.md) for project configuration, and
[MIGRATION-agent-fleet.md](MIGRATION-agent-fleet.md) for the major-release matrix.
