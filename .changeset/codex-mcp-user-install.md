---
"@chankov/agent-fleet": minor
# release: keep-bump
---

Add `agent-fleet set-codex-mcp <status|install|update|uninstall>`, an explicit operator command that registers the native `af-local-read` MCP server in the user-level Codex configuration through `codex mcp add`/`remove` and installs the packaged `fleet-native-voice` skill copy under `~/.agents/skills`. `status` is read-only and reports a project-level shadow; `install`/`update` probe the launcher over STDIO, back up `config.toml`, re-read the entry, and record receipts; `uninstall` removes only what a receipt proves the command created and keeps every policy state, journal, and binding. `--dry-run` writes nothing. `setup` does not call it, and installing the package registers nothing.

Add `docs/codex-setup.md`, which records the decision to prefer user-level registration and covers the defaults, verification, migration from a project-local table, and the removal order. The native MCP and voice guides link to it instead of repeating the steps, and the architecture guide names `set-codex-mcp.js`, `skill-zip.js`, and `mcp-probe.js` as the only modules besides the Hermes controllers that write outside a workspace. The package ships the new guide and the `fleet-native-voice.zip` archive the command extracts; the unpacked skill source stays excluded. This is the first release with a supported Codex registration path, so the minor bump is kept.
