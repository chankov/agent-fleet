# agent-skills-update-check

A pi extension that surfaces an "update available" banner once per session when `@chankov/agent-skills` has a newer published version than the one recorded in `.ai/agent-skills-setup.md`.

## What it does

On the first `agent_start` event of a pi session, the extension:

1. Reads `version:` from `.ai/agent-skills-setup.md` in the current working directory. If the record is missing (workspace was never set up via `/setup-agent-skills`), the check is skipped.
2. Reads the cached latest version from `$XDG_CACHE_HOME/agent-skills/latest-version.json` (falling back to `~/.cache/agent-skills/`).
3. If the cache is older than 24 hours or absent, fetches the latest version from the npm registry with a 3-second timeout.
4. If the published version is greater than the recorded version, emits an `info`-level notification via `ctx.ui.notify`.

The check runs **once per session** and is bounded to a single network call. It shares its cache file with the CLI update-notifier so the two never double-fetch.

## When the banner fires

```
agent-skills update available: 0.1.0 → 0.2.0. Run "npx @chankov/agent-skills@latest update" then /setup-agent-skills to apply.
```

The banner appears in pi's UI notification area — the same surface used by other extensions for non-fatal status. It does not block, prompt, or modify any file. The user decides when to act on it.

## When the banner does NOT fire

- The workspace has no `.ai/agent-skills-setup.md` install record.
- The published version equals or is older than the recorded version.
- The cache shows the published version is current (≤24h since last fetch).
- The registry is unreachable, returns non-200, or times out.
- `AGENT_SKILLS_NO_UPDATE_CHECK=1`, `NO_UPDATE_NOTIFIER=1`, or `CI=true` is set in the environment.

Every error path silently aborts. Update checks must never disrupt a session.

## Install

Installed via `/setup-agent-skills` as part of Group 10 — pi extensions. Or symlink manually:

```bash
ln -s /path/to/@chankov/agent-skills/.pi/extensions/agent-skills-update-check \
      .pi/extensions/agent-skills-update-check
```

No runtime deps beyond pi's own `@mariozechner/pi-coding-agent` types and Node built-ins (`fs`, `os`, `path`, `https`).

## Opt-out

The check honours three environment variables (any of them disables it):

- `AGENT_SKILLS_NO_UPDATE_CHECK=1` — agent-skills-specific opt-out
- `NO_UPDATE_NOTIFIER=1` — the conventional opt-out used by many CLI tools
- `CI=true` — auto-disabled in CI so the banner never spams build logs

## Behavior notes

- The check runs once per pi session; restarting pi triggers a new check.
- The cache file is shared with the CLI (`agent-skills check-update`) so both update paths benefit from a single fetch per 24h window.
- If the install record is *pre-versioning* (no `version:` line), the check is skipped — there's no recorded baseline to compare against. Run `/setup-agent-skills` once to stamp the current version.
- The extension only reads; it never writes the install record itself.
