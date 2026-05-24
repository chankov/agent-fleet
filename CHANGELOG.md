# agent-skills changelog

## 0.2.0

### Minor Changes

- 7f2be04: Initial npm release. Ships the full skills catalog, agent personas, slash
  commands, and pi extensions as an installable package, with a thin CLI
  (`npx agent-skills init`) that hands off to the LLM-driven
  `guided-workspace-setup` skill. Adds version-aware updates: the install record
  now embeds the package version, and re-running `/setup` after a version bump
  surfaces a per-artifact three-way diff (source@recorded vs installed copy vs
  source@current) before touching any file.
- Add three layered update-notification paths so users are told when a newer
  version is published, without having to remember to check:

  1. **CLI update-notifier** (`bin/lib/update-notifier.js`) — every
     `npx @chankov/agent-skills <cmd>` reads a shared 24h cache; if the cached
     latest exceeds the running CLI version, a banner prints to stderr. Stale
     caches are refreshed by a detached background process so the current run
     is never blocked.
  2. **`check-update` CLI subcommand** — standalone entry point used by hooks
     and extensions; blocks on a single registry fetch (2s timeout) and prints
     the banner to stdout if outdated. Always exits 0.
  3. **Claude Code session-start hook** (`hooks/session-start.sh`) — extended
     to call `check-update` with a 3s wall-clock cap and inject the banner into
     the session context so Claude can surface it on its first turn.
  4. **pi extension** (`.pi/extensions/agent-skills-update-check/`) — fires on
     the first `agent_start` event of each pi session, reads the same shared
     cache, emits `ctx.ui.notify` if outdated. Offered as a `★`-recommended
     pick in install-menu Group 10.

  All three share the cache at `$XDG_CACHE_HOME/agent-skills/latest-version.json`
  so the registry is hit at most once per 24h window across all runtimes.

  Opt-out via any of `AGENT_SKILLS_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`,
  or `CI=true`.

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries below 0.1.0
are pre-npm history captured in git.

The file is rolled forward by [changesets](https://github.com/changesets/changesets) —
do not edit it by hand. Add a `.changeset/<name>.md` file describing your
change and let `changeset version` aggregate it.

## Unreleased

Pending changesets in `.changeset/` will roll into the next release.
