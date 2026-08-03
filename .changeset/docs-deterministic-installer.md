---
"@chankov/agent-fleet": patch
---

Rewrite the setup docs around the deterministic CLI installer.

`README.md`, `docs/getting-started.md`, `docs/pi-setup.md`, `docs/opencode-setup.md`, and `docs/pi-extensions.md` still described the pre-engine world: `ln -s` chains into `.agents/skills/` and `~/.config/opencode/`, "symlink mode in `/setup-agent-fleet`", and `git pull` as the update mechanism. All of that is replaced by the verbs that actually do the work.

- **The no-agent path is documented first.** `install --agent <a> --profile <p> --yes` needs no coding agent and no model; `init` is presented as the conversational front-end over the same engine, not as the only way in. Profiles, `--items`, `--dry-run`, `--json`, and the exit codes are named where a reader would look for them.
- **Every symlink recipe is gone from the install paths.** Artifacts install as copies; freshness comes from `agent-fleet upgrade` and its three-way merge, not from editing a link target. `--method symlink` appears only where it is still true — inside an agent-fleet checkout.
- **pi setup is restructured into three paths** (CLI installer, pi package, clone for contributors) with a table of where each artifact kind lands. The clone path now installs *from* the checkout (`node /path/to/agent-fleet/bin/cli.js install --workspace <project>`) instead of linking into it.
- **`--allow-exec` is explained where it bites**: the `npm ci` steps for `.pi/extensions/` and `.pi/harnesses/` are a separate consent class, printed and skipped without the flag.
- **OpenCode gains a project-scoped install section**; the manual `~/.config/opencode/` symlink recipe is kept but labelled as the advanced machine-wide alternative the CLI deliberately does not cover.
- Extension READMEs (`btw`, `compact-and-continue`, `agent-fleet-update-check`, `chrome-devtools-mcp`, `mcp-bridge`) and the `browser-testing-with-devtools` skill now give the `--items` command instead of an `ln -s`. `chrome-devtools-mcp` documents that `pi-extension:mcp-bridge` must be selected alongside it — it is not pulled in as a companion.

Every command added to the docs was verified against the CLI by dry-run.
