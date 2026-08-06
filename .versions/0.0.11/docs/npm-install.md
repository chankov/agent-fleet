# Install and lifecycle

`@chankov/agent-fleet` is a deterministic pi workspace installer. It needs no
coding agent or model: `setup`, `doctor`, and `uninstall` are the public
lifecycle commands.

## First install

Interactive use tracks the newest release:

```bash
npx @chankov/agent-fleet@latest setup
```

For repeatable automation, pin the exact major/minor/patch and state the
selection explicitly:

```bash
npx @chankov/agent-fleet@1.0.0 setup --preset default --features none --yes
npx @chankov/agent-fleet@1.0.0 setup --preset full --features none --yes
```

**Default** is the launchable, stable Fleet Core and creates neither `.claude/`
nor voice configuration. **Full** selects every stable, platform-applicable
catalogue root; it may install the recorded Claude Code coms bridge. Features
are additive named capabilities, not an arbitrary package-entry mode. Use
`setup --help` to see feature names. Experimental Codex Remote remains opt-in
and operator-applied.

`init`, `install`, `upgrade`, and `update` are compatibility aliases for
`setup`; new scripts should use `setup`.

## Desired state and migration

The desired selection lives in `.ai/agent-fleet.json`. Command-line preset and
feature flags are ephemeral over an existing file unless `--save-desired` is
passed. When the file is missing, setup writes the selected desired state in
the same transaction as its artifacts.

The first major-release migration is deliberately strict:

```bash
# Preview is safe and does not require consent.
npx @chankov/agent-fleet@1.0.0 setup --migrate --dry-run

# Automation must name the desired state and explicitly consent to migration.
npx @chankov/agent-fleet@1.0.0 setup --migrate --preset default --features none --yes
```

Migration lists each exact removal before consent and removes only unchanged,
state-owned legacy artifacts. Foreign or locally modified files survive.

## Doctor and uninstall

```bash
npx @chankov/agent-fleet doctor                 # read-only; never prompts
npx @chankov/agent-fleet doctor --fix
npx @chankov/agent-fleet uninstall --all --yes
npx @chankov/agent-fleet uninstall --all --purge-config --yes
```

Uninstall removes only paths recorded in `.ai/agent-fleet-state.json` and
preserves modified recorded paths. It also preserves human configuration by
default: `.ai/agent-fleet.json`, `.ai/agent-fleet-overrides.md`, `.ai/stt.json`,
and environment files. `--purge-config` is the separate destructive gate for
the three human config files; environment files are never removed.

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
and prompts into `.pi/`; `doctor` reports that ownership overlap. Harness-only
composition is supported: package-native skills/prompts with copied Fleet Core
harnesses.

## Safety contract

All lifecycle commands support `--dry-run`; JSON output requires either
`--dry-run` or `--yes`. Exit `0` means success/no-op, `1` failure, `2` doctor
findings, and `3` unresolved merge conflicts. Files outside state ownership are
never adopted for removal. See [Migration](MIGRATION-agent-fleet.md) for the
full major-release matrix.
