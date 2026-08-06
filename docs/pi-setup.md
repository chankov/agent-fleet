# pi setup

Agent Fleet is pi-first. Its deterministic lifecycle writes copied workspace
artifacts; the package-native path exposes skills/prompts directly.

## Lifecycle install

From the target repository in a real TTY, begin with:

```bash
just fleet setup
```

This is the easiest installer TUI entry point. It runs `npx
@chankov/agent-fleet@latest setup`, where you choose Default or Full and optional
comma-separated features, inspect the exact plan, and confirm once to apply. It needs
npm registry access unless `@latest` is cached. For automation or without `just`:

```bash
npx @chankov/agent-fleet@latest setup --preset default --features none --yes
```

These are published-package commands; source-checkout development uses
`node bin/cli.js setup`. `pi update --extensions` does not update the npm installer:
run `just fleet setup` to resolve `@latest` and reconcile. `just fleet deps` installs
nested runtime dependencies; `just fleet install` was removed. See
[npm-install.md](npm-install.md) for the canonical installer guide.

Default is launchable Fleet Core and does not create `.claude/` or voice
configuration. Full selects stable, platform-applicable roots and may add the
recorded Claude Code coms bridge. Feature flags are named additions over a
preset; they are not an arbitrary package picker. Flags do not rewrite an
existing desired file unless `--save-desired` is explicit.

The installer owns only paths in `.ai/agent-fleet-state.json`. Normal uninstall
preserves `.ai/agent-fleet.json`, `.ai/agent-fleet-overrides.md`, `.ai/stt.json`,
and environment files. See [npm-install.md](npm-install.md) for `--migrate`,
`--purge-config`, doctor exits, and self-uninstall recovery.

## Runtime closure

`just fleet` is the guarded Fleet Core launcher. It explicitly loads
`damage-control-continue`, `ask-user-remote`, compact-and-continue, BTW, and
the update checker. Voice is not a Default Core dependency. `just fleet hub`
adds agent-hub; `just fleet peer` adds coms; `just fleet team` uses Herdr.

```bash
just fleet help
just fleet setup
just fleet deps
just fleet doctor
just fleet uninstall --yes
```

Self-uninstall removes the managed justfile region and dispatcher scripts last,
so its report completes. Restore it only through `npx @chankov/agent-fleet
setup ...`; then `just fleet doctor` is available again.

## Package-native skills and prompts

```bash
pi install -l npm:@chankov/agent-fleet
```

Do not also copy the same skills/prompts into `.pi/`; that creates collisions.
Harness-only composition (package-native skills/prompts plus copied harnesses)
is supported. The package bundles `pi-ask-user`; copied plain-pi installations
need their own compatible `pi-ask-user` source.

## Project-owned configuration

`.ai/agent-fleet-overrides.md` is minimal committed project configuration;
`.ai/stt.json` contains provider names and environment-variable names, never
secret values. The root environment file is human-owned and append-only.
