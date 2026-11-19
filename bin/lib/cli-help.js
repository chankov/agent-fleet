export function printHelp(version, sub) {
  if (sub === "configure") {
    console.log(`agent-fleet configure --rules <dirs> --docs <paths> [options]

  Append and deduplicate requested repo-relative paths in Fleet overrides only.
  Omit either key to leave it unchanged. Conflicting sections/keys require manual resolution.
  --dry-run previews before/after bytes and expectedHash without writing.
  --yes applies; --expect-hash <expectedHash> refuses a stale preview.
  --workspace <path> selects the target (default: cwd); --json emits the apply result.
  Start a new session to load changed settings.`);
    return;
  }
  if (sub === "setup") {
    console.log(`agent-fleet setup [options]

  Reconcile the workspace to a Default or Full desired state. In a TTY without
  --yes, the interactive selector explains Default, Full, and experimental
  opt-in, then shows the exact plan before writing. Non-TTY mutations require
  --yes; --dry-run always writes nothing.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --preset <default|full>              Desired preset
  --repair-config                     With --yes, approve known retired config removal (backup saved)
  --features <name[,name]|none>        Exact feature snapshot (replaces, never adds)
  --stt-provider <openai|groq|azure|azure-openai>
                                        Select provider explicitly; non-OpenAI setup requires prepared .ai/stt.json
  --save-desired                       Persist CLI overrides to .ai/agent-fleet.json
  --migrate-system1-config            Explicit local v1 → v2 migration; preview with --dry-run
  --expect-digest <digest>             Apply the exact migration preview, together with --yes
  --task-triage-consent                Separately approve experimental remote task context (not implied by --yes)
  --migrate                            Permit non-interactive first migration (with explicit preset/features and --yes)
  --allow-exec                         Run consented runtime commands after the file transaction
  --on-conflict <ours|theirs>           Resolve a three-way conflict before the transaction
  --dry-run                            Print a plan; write nothing
  --json                               Emit a machine-readable plan/result (--yes applies)
  -y, --yes                            Consent to non-interactive mutation
  -h, --help                           Show this help

Resolve conflicts with --on-conflict theirs (take the package version) or
--on-conflict ours (keep the local copy).
`);
    return;
  }
  if (sub === "init") {
    console.log(`agent-fleet init [options]

  Materialize the package and hand off to the runtime's Agent Fleet setup command.

Options:
  --agent pi                          Coding agent (pi is the only target)
  --workspace <path>                  Target workspace (default: cwd)
  --launch                            Attempt to launch the coding agent after init
  -h, --help                          Show this help
`);
    return;
  }
  if (sub === "doctor") {
    console.log(`agent-fleet doctor [options]

  Find and repair breakage. Two sources, one report:

    • recorded items that are missing, dangling, or linked outside the source
      root — repaired through the same apply() path \`install\` writes with, so
      a repaired file is byte-identical to a freshly installed one;
    • broken symlinks and stale persona names the install record cannot own
      (pre-engine workspaces, hand-edited .pi/agents/*.yaml).

  Overrides problems and malformed peers.yaml entries are advisory: reported,
  never auto-fixed, because the fix is always a hand edit.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent pi                          Coding agent (pi is the only target)
  --fix                               Apply the repairs without prompting
  --dry-run                           Report only; never write, never prompt
  --json                              Emit the machine report on stdout
  -y, --yes                           Alias for --fix
  -h, --help                          Show this help

Exit codes:
  0   nothing to repair
  1   could not run
  2   repairable issues found, pending runtime repair, or a repair failed
`);
    return;
  }
  if (sub === "uninstall") {
    console.log(`agent-fleet uninstall [options]

  Remove artifacts agent-fleet installed. Bound by the ownership rule: only
  paths recorded in .ai/agent-fleet-state.json are eligible, and a recorded
  file whose bytes no longer match what we wrote is kept and listed as skipped.
  Nothing else in the workspace is ever touched.

  Removing an item takes its companions with it, unless another installed item
  still needs them; an item another installed item pins is refused by name.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --items <id[,id]>                   Item ids to remove
  --all                               Remove everything the state file records
  --agent pi                          Coding agent (pi is the only target)
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  --purge-config                       Also remove .ai desired/override/STT config (requires consent)
  -y, --yes                           Skip the confirmation
  -h, --help                          Show this help

Exit codes:
  0   removed (or nothing to remove)
  1   could not plan (no install record, no selection, unknown agent)
`);
    return;
  }
  if (sub === "inspect") {
    console.log(`agent-fleet inspect [options]

  Read-only JSON report that composes verify (item states, drift findings),
  doctor (scan findings, manifest preflight), the desired state with feature
  availability, and the project provenance status. Built for in-session
  consumers such as the /af-config screen. Writes nothing, never prompts,
  always emits JSON.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent pi                          Coding agent (pi is the only target)
  -h, --help                          Show this help

Exit codes:
  0   report produced (findings are inside the report, not in the exit code)
  1   could not run (bad flags, missing manifest, unreadable workspace)
`);
    return;
  }
  if (sub === "verify") {
    console.log(`agent-fleet verify [options]

  Read-only inspection of a workspace against the install manifest: what is
  recorded, what is on disk, what differs, and what is broken. Writes nothing.

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent pi                          Coding agent (pi is the only target)
  --json                              Emit the machine report on stdout
  --no-doctor                         Skip the symlink/persona/overrides scan
  -h, --help                          Show this help

Exit codes:
  0   no broken items and no findings
  1   could not run (bad flags, missing manifest, unreadable workspace)
  2   findings, or items in a broken state

An available upgrade (state "outdated") and a deliberate local edit (state
"modified") are reported but do not fail the run.
`);
    return;
  }
  if (sub === "install" || sub === "upgrade") {
    console.log(`agent-fleet ${sub} [options]

  ${sub === "install"
    ? "Install the selected artifacts into a workspace."
    : "Upgrade what this workspace already has to the current package, with a\n  three-way merge against the snapshot of the version it recorded."}

Options:
  --workspace <path>                  Target workspace (default: cwd)
  --agent pi                          Coding agent (pi is the only target)${sub === "install" ? `
  --profile <name[,name]>             Named selections, unioned
  --items <id[,id]>                   Explicit item ids, added to the profiles` : ""}
  --allow-exec                        Include items that run a command
  --accept-theirs                     Resolve conflicts by taking the new version
  --accept-ours                       Resolve conflicts by keeping the local copy
  --dry-run                           Print the plan, write nothing
  --json                              Emit the machine plan/result on stdout
  -y, --yes                           Skip the confirmation (required with --json)
  -h, --help                          Show this help

Resolve conflicts with --accept-theirs (take the new version) or --accept-ours
(keep the local copy). upgrade does not support setup's --on-conflict flag.

Exit codes:
  0   applied, or nothing to do
  1   could not plan, or a write failed partway
  3   conflicts — changed both locally and upstream, needs a decision

${sub === "install"
  ? "A selection never removes anything: installing a narrower profile keeps what\nis already there. Local edits to a selected item ARE overwritten — selecting\nan item is the consent — and every such item is listed as `overwrites`."
  : "Upgrade never widens the install. Locally modified files are preserved, not\noverwritten; artifacts retired upstream are proposed for removal by name."}

Artifacts are installed as copies. --method symlink exists only inside an
agent-fleet checkout, where editing an artifact is meant to edit the source; a
workspace that recorded symlinks before that restriction is migrated to copies
on the next install or upgrade.
`);
    return;
  }
  if (sub === "set-hermes-watchdog") {
    console.log(`agent-fleet set-hermes-watchdog <status|install|update|uninstall> [options]

Actions:
  status                 Inspect profile, packaged-skill drift, receipt, and active-lock state
  install | update       Atomically install/reconcile the optional foreground watchdog skill
  uninstall              Remove only a managed unchanged skill tree; preserve config and journals

Options:
  --profile <name>       Hermes profile; required unless exactly one gateway is running
  --force                Back up a drifted tree before replacement/removal
  --dry-run              Report the write that would occur without changing files
  -h, --help             Show this help

No action starts/stops/restarts a gateway, changes tools, kills a watcher, or enables delivery.
Gate O remains fail-closed: without genuine live origin proof the installed watcher is local-journal-only.
`);
    return;
  }
  if (sub === "set-codex-mcp") {
    console.log(`agent-fleet set-codex-mcp <status|install|update|uninstall> [options]

Register the Agent Fleet native MCP server (af-local-read) in the user-level
Codex configuration and install the fleet-native-voice skill under
~/.agents/skills. Codex owns config.toml: the entry is written only through
\`codex mcp add\` / \`codex mcp remove\`, never by editing TOML, and a backup of
config.toml is kept under $CODEX_HOME/agent-fleet/backups before every change.

Actions:
  status                 Read-only: launcher, entry state, project shadow, skill, receipts
  install | update       Probe the launcher, back up config.toml, register the entry, install the skill
  uninstall              Remove only the managed entry and skill tree; keep all Fleet state

Options:
  --node <path>              Node binary for the launcher (default: the running Node)
  --registry-root <dir>      COMS root (default: $PI_COMS_DIR or ~/.pi/coms)
  --policy-root <dir>        Private native state (default: $CODEX_HOME/agent-fleet/state/fleet-native)
  --host-profile <name>      State partition label (default: desktop)
  --principal <name>         State partition label (default: local-user)
  --legacy-state-root <dir>  Optional read-only archive of the retired CLI state
  --force                    Replace a drifted entry or skill tree after backing it up
  --dry-run                  Report the planned change without writing
  -h, --help                 Show this help

Registration exposes the tools in every Codex chat but does not grant access:
each chat still enrolls and confirms per action. Uninstall does not revoke
persisted bindings; use forget / revoke_send / revoke_approve in chat first.
A project .codex/config.toml with the same server name shadows the user entry
inside that project; status reports it and never edits it.
Exit 0 success, 1 failure, 2 status with refusals. POSIX only; Node >= 22.18.
`);
    return;
  }
  if (sub === "set-hermes-telegram") {
    console.log(`agent-fleet set-hermes-telegram <action> [arguments] [options]

Actions:
  install                Atomically install/reconcile the packaged hub-liaison skill
  status                 Inspect gateway, skill drift/enabled state, and Telegram tools
  on <id[:topic]>        Start a ready bridge in a new pane in this Herdr workspace
  off <id[:topic]>       Stop bridge panes in this Herdr workspace

Options:
  --profile <name>       Hermes gateway profile; auto-detect only when exactly one runs
  --force                Back up and replace a drifted installed skill
  --restart              Explicitly restart a running gateway after install
  -h, --help             Show this help

The on action fails closed unless hub-liaison is current and enabled, the
profile gateway is running, and Telegram terminal/file tools are enabled.
No action sends a test Telegram message.

Examples:
  agent-fleet set-hermes-telegram status --profile default
  agent-fleet set-hermes-telegram install --profile default
  agent-fleet set-hermes-telegram install --profile default --force --restart
  agent-fleet set-hermes-telegram on 7883056502:1735 --profile default
  agent-fleet set-hermes-telegram off 7883056502:1735
`);
    return;
  }
  if (sub === "update") {
    console.log(`agent-fleet update [options]

  Surface the version delta and re-install the runtime's Agent Fleet setup
  command so it is always present after an update (deterministic setup CLI
  removes it at the end of a run by default). The actual diff-aware refresh
  then runs inside your coding agent via that command.

Options:
  --agent pi                          Coding agent (pi is the only target)
  --workspace <path>                  Target workspace (default: cwd)
  --dry-run                           Show what would be written; touch nothing
  -h, --help                          Show this help

To upgrade the package itself first:
  npm install -g @chankov/agent-fleet@latest
  npx @chankov/agent-fleet@latest update
`);
    return;
  }
  console.log(`agent-fleet v${version}

Usage:
  npx agent-fleet <command> [options]

Commands:
  init                Compatibility alias for setup
  doctor              Find and repair breakage (--fix); advisory findings listed
  verify              Read-only report: manifest × install state × disk (--json)
  inspect             Read-only JSON composition of verify + doctor + desired state for in-session screens
  install             Install from a profile or explicit item ids
  upgrade             Upgrade what is installed, with a three-way merge
  setup               Reconcile Default/Full desired state (interactive in a TTY)
  configure           Preview/apply only requested rules/docs override roots
  uninstall           Remove recorded artifacts (--items / --all)
  update              Compatibility alias for setup
  check-update        One-line registry check (used by session hooks; safe to script)
  set-hermes-telegram Install/status the liaison and start/stop its Herdr bridge
  set-hermes-watchdog Install/status/update/uninstall the fail-closed watchdog skill
  set-codex-mcp       Install/status/update/uninstall the user-level Codex MCP server and skill

Options:
  -v, --version    Print the package version
  -h, --help       Print this help (or per-command help)

Examples:
  npx agent-fleet setup --preset default --features none --yes
  npx agent-fleet init
  npx agent-fleet doctor --workspace ~/projects/foo --fix
  npx agent-fleet verify --agent pi --json
  npx agent-fleet install --agent pi --profile recommended --yes
  npx agent-fleet install --agent pi --profile hermes-plugins --dry-run
  npx agent-fleet upgrade --accept-ours --yes
  npx agent-fleet uninstall --items skill:peer-coms --yes
  npx agent-fleet update
  npx agent-fleet set-hermes-telegram on 7883056502:1735
  npx agent-fleet set-hermes-watchdog status --profile default
  npx agent-fleet set-codex-mcp status

Environment:
  AGENT_SKILLS_NO_UPDATE_CHECK=1   Disable the background update check
  NO_UPDATE_NOTIFIER=1             Same (conventional opt-out, also honoured)
  CI=true                          Auto-disables the update check

Docs: https://github.com/chankov/agent-fleet#readme
`);
}
