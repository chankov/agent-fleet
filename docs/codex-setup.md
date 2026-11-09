# Codex MCP setup for Agent Fleet

Register the native `af-local-read` MCP server and install the `fleet-native-voice` skill at the **user level** of a local Codex host with one explicit, deterministic command:

```bash
agent-fleet set-codex-mcp status
agent-fleet set-codex-mcp install
```

This guide covers installation, verification, migration, and removal only. Tool usage, permissions, observations, instructions, state layout, and error codes are in the [native Codex MCP guide](codex-local-mcp.md); the conversational layer is in the [voice workflow](fleet-native-voice.md). Installing Fleet itself is covered by [Fleet setup](agent-fleet-setup.md).

## Status and decision

**Status:** implemented on 2026-11-07 as `agent-fleet set-codex-mcp`. The decisions below were taken by the maintainer on 2026-11-04 and are recorded here instead of in an ADR directory.

- **D1 — scope.** The user level is the default: the MCP entry lives in `$CODEX_HOME/config.toml` and the skill copy in `~/.agents/skills/`. This explicitly replaces the earlier guidance, which configured a project-local `.codex/config.toml` table and a project-local skill symlink or ZIP extraction. That project-local setup remains a manual alternative (below), not the recommended path.
- **D2 — who installs.** A separate command, invoked explicitly by the operator: `agent-fleet set-codex-mcp <status|install|update|uninstall>`. `agent-fleet setup` does not call it, installs nothing for Codex, and still writes only inside the workspace. Like `set-hermes-watchdog`, writing outside the workspace is an operator decision.
- **D3 — where the decision is recorded.** Here, at the top of the guide operators read.
- **D4 — state namespace (delegated).** A new namespace with the defaults below. An earlier smoke or manual namespace is neither migrated nor touched; see [Migrate from a project-local configuration](#migrate-from-a-project-local-configuration).

Why user level: `codex mcp add` has no scope flag and always writes `$CODEX_HOME/config.toml`; a user-level entry follows the operator into every project; and the skill is a package artifact, not a per-project file.

## Requirements

- A POSIX host (Linux or macOS) with the same OS user running Codex and the Fleet/Pi sessions. The server and the command refuse Windows.
- Node.js **22.18 or newer** for the launcher. `--node` defaults to the Node that runs the command. A lower or undeterminable version is refused; the package's general Node 18 engine requirement is not sufficient for this server.
- A stable Agent Fleet runtime: a checkout or a global install (`npm install -g @chankov/agent-fleet`). A temporary `npx` cache is refused as a launcher location, because Codex would keep a path that disappears.
- The Codex CLI with `codex mcp add`, `codex mcp remove`, and `codex mcp list --json` (verified with codex-cli 0.166.0). The command never edits `config.toml` itself.
- Running Fleet/Pi sessions are not required to install; they are required to use the tools.

## What the command does

| Action | Writes | Effect |
| --- | --- | --- |
| `status` | nothing | Reports the resolved launcher, the `af-local-read` entry state, a project shadow if any, the skill copy state, both receipts, warnings, and refusals. Exit 2 when a refusal is present. |
| `install`, `update` | `$CODEX_HOME/config.toml` through `codex mcp add`; `~/.agents/skills/fleet-native-voice`; receipts and backups under `$CODEX_HOME/agent-fleet/` | The same behaviour, chosen by intent: probe the launcher, back up, register, re-read, then install the skill copy. |
| `uninstall` | the same places | Removes only the entry and skill tree that a receipt proves this command created. Keeps every state root, journal, archive, and backup. |

Output is JSON. Exit `0` is success or no change, `1` a failure, `2` a `status` with refusals. `--dry-run` prints the planned modes, the exact `codex` arguments, and the backup paths; it neither probes nor writes. `--force` is required to replace an entry or tree that differs from what the command would write, or to remove one without a matching receipt.

An `install` or `update` runs in this order, and stops at the first failure without writing anything further:

1. `status` is evaluated. Any refusal stops the run before a probe.
2. The exact launcher is started once over STDIO, exchanges `initialize` (protocol `2025-06-18`) and `tools/list`, and is terminated. The server must identify itself as `af-local-read` and advertise at least one tool. No tool is called, so no policy state is created. The tool count is reported, never compared with a fixed number.
3. `config.toml` is copied to `$CODEX_HOME/agent-fleet/backups/config.toml-<timestamp>` with mode `0600`. `codex mcp add` rewrites the file and drops inline comments inside other tables, so this copy is the only place those comments survive.
4. `codex mcp add af-local-read -- <node> <runtime> --registry-root … --policy-root … --host-profile … --principal …` runs. It always writes `$CODEX_HOME/config.toml`.
5. `codex mcp list --json` is re-read. The entry must match the launcher exactly before the receipt is written; otherwise the run fails and names the backup.
6. The skill is extracted from the packaged `skills/fleet-native-voice.zip` into a private staging directory, verified against the package, and moved into place atomically. Directories end up `0700` and files `0600`.

Entry and skill states, as `status` reports them:

| State | Meaning | `install` / `update` |
| --- | --- | --- |
| `missing` | no entry, or no skill directory | add the entry / install the copy |
| `current` | matches the launcher or the package, and the receipt is `managed` | no change |
| `adoptable` (entry), or `current` with an `unmanaged` receipt (skill) | matches, but was not written by this command | only the receipt is written |
| `drifted` | differs from the launcher, the package, or the receipt; for the entry also `enabled = false`, an `env`, `env_vars`, `cwd`, or a non-STDIO transport | refused; `--force` backs it up and replaces it |
| `broken` (entry) | the recorded command or runtime path does not exist | refused; `--force` backs it up and replaces it |
| `symlink` (skill) | the skill path is a symlink | always refused; remove the symlink yourself |

Receipts are `managed` when they match what is installed, `unmanaged` when absent, and `drifted` when present but unreadable or mismatched. A stale receipt without an entry or tree is removed by `uninstall`.

### Defaults

| Setting | Default | Override |
| --- | --- | --- |
| Codex home | `$CODEX_HOME`, else `~/.codex` | environment only |
| Node | the Node running the command | `--node <path>` |
| Runtime | `<package>/.pi/agent-fleet/scripts/fleet-codex-local-mcp.mjs` | derived from the installed package |
| `--registry-root` | `$PI_COMS_DIR`, else `~/.pi/coms` | `--registry-root <dir>` |
| `--policy-root` | `$CODEX_HOME/agent-fleet/state/fleet-native` | `--policy-root <dir>` |
| `--host-profile` | `desktop` | `--host-profile <name>` |
| `--principal` | `local-user` | `--principal <name>` |
| `--legacy-state-root` | not set | `--legacy-state-root <dir>` |

The launcher flags mean what the [native guide](codex-local-mcp.md#persistent-state-and-journal-upgrades) describes: the registry root is the existing COMS root (`projects/<project>/agents/*.json`, `sockets/<sessionId>.sock`), the policy root is a dedicated private directory for native bindings, and the host profile and principal are stable labels that partition state without proving OS identity. The server creates the policy root on first enrollment and uses the sibling directories `.observations`, `.instructions`, `.reports`, and `.permissions` next to it. For the default policy root the command creates its parent `state/`; an explicit `--policy-root` must already have an existing parent.

Registry, policy, and legacy roots must be normalized absolute paths with no symlink in their existing prefix, and must not overlap each other or the derived siblings; the command applies the same check as the server before writing. Keep the profile, principal, and policy root stable: changing any of them selects a different namespace, not a migration. The optional `--legacy-state-root` is the read-only archive of the retired CLI described under [preserving existing CLI data](codex-local-mcp.md#preserve-existing-cli-data-without-replaying-it); the command validates the path and passes it through, nothing more.

`enabled_tools` is deliberately **not** set. The whole catalogue is exposed, so the tools loaded in a chat match the installed source and the entry does not go stale when a release adds a tool. The Pi-side event relay readiness check also requires the complete loaded catalogue; a filtered list makes it refuse.

## Verify

1. Run `agent-fleet set-codex-mcp status`. Expect `mcpState: "current"`, `skillState: "current"`, both receipt states `managed`, `projectShadow.shadowed: false`, and an empty `errors` list.
2. Reload Codex through the host's supported procedure, open a **new** chat, and call `fleet_diagnostics {}`. It reports the Node runtime, protocol, and loaded tool names without touching the registry or policy state. A host that was already running may still show an older catalogue until it is reloaded.
3. In the same chat call `fleet_discover` for an explicit running project. `STATE_MISSING` or `NOT_ALLOWED` is the expected answer for a conversation that has not enrolled; it is not a setup error.

Registration exposes the tools in every Codex chat of this user. It grants nothing: each chat still enrolls each target through the reviewed `fleet_binding_prepare` / `fleet_binding_commit` flow under [connect a target](codex-local-mcp.md#connect-a-target-and-manage-permissions), and answers and approvals retain their separate per-action confirmation requirements. An explicit user send to one unambiguous, already selected current session with read+send uses technical prepare/commit without a second conversational confirmation; model-initiated or substantively expanded instructions still require a fresh preview confirmation, while ambiguity or a changed session stops the send. See [send an instruction](codex-local-mcp.md#send-an-instruction). Review the host's normal project-trust and MCP approval settings; do not disable protections to make this server load.

### nvm and other version managers

When `--node` resolves under `~/.nvm/versions/`, `status` and `install` print a warning rather than refusing. The entry stores that Node binary's absolute path, so after switching or upgrading Node the recorded path can disappear or stop matching. Run `agent-fleet set-codex-mcp update` afterwards so Codex keeps a working launcher; until then `status` reports the entry as `broken` or `drifted`. `uninstall` still works in that state, because it judges the entry against its receipt, not against the current Node.

## What this command does not install

These are separate, user-owned, Pi-side opt-ins. `set-codex-mcp` neither creates, reads, nor manages them, and `uninstall` leaves them alone:

- **Event relay.** `/af-codex-events prepare|enable <private-config>`, its private JSON config, and its `.event-ingress` / `.desktop-events` journals — see [explicit production event ingress](codex-local-mcp.md#explicit-production-event-ingress-disabled-until-approved).
- **Damage Control auto policy.** The optional `.pi/damage-control-auto-policy.yaml` — see [machine Damage Control permissions](codex-local-mcp.md#machine-damage-control-permissions-source-checkpoint).
- **Desktop queue adapter.** The experimental private Unix-socket queue path — see [the opt-in Desktop queue adapter](codex-local-mcp.md#experimental-opt-in-desktop-queue-adapter).

## Manual project-level alternative

A project-local configuration is still possible and is **not** managed by the command. Codex reads a trusted project's `.codex/config.toml` when its working directory is inside that project, and an entry there with the same server name **shadows** the user-level entry for that project. `status` reports this as `projectShadow.shadowed: true` with the shadowing transport, and never edits the project file.

Merge the following table into `<project>/.codex/config.toml` without replacing unrelated configuration. Every `/absolute/path/...` value is a placeholder; TOML paths are literal and do not expand `~` or environment variables.

```toml
[mcp_servers.af-local-read]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/agent-fleet/.pi/agent-fleet/scripts/fleet-codex-local-mcp.mjs",
  "--registry-root", "/absolute/path/to/coms",
  "--policy-root", "/absolute/path/to/private-state/fleet-native",
  "--host-profile", "desktop",
  "--principal", "local-user"
]
```

Use the `.mjs` bootstrap for both checkout and package installs: it loads this distribution's TypeScript sources through Node's scoped loader, whereas Node's automatic TypeScript stripping refuses files beneath `node_modules`. Configure it as local STDIO, not an HTTP service; the launcher reads no roots or identity from environment variables. A manual table has no backup, no probe, no re-read, and no receipt; keep `enabled_tools` unset for the reasons above, or maintain the list yourself on every release.

For a project-local skill, Codex also scans `<project>/.agents/skills/`. From a checkout, link the source; from a package, extract the archive. Both commands refuse to touch an existing destination, including a dangling symlink:

```sh
mkdir -p .agents/skills
test ! -e .agents/skills/fleet-native-voice && test ! -L .agents/skills/fleet-native-voice && \
  ln -s ../../skills/fleet-native-voice .agents/skills/fleet-native-voice
```

```sh
mkdir -p .agents/skills
test ! -e .agents/skills/fleet-native-voice && test ! -L .agents/skills/fleet-native-voice && \
  unzip -n /absolute/path/to/agent-fleet/skills/fleet-native-voice.zip -d .agents/skills
```

Keep one copy of the skill per host where you can; a user-level copy and a project-local copy of the same skill are two things to keep in step.

## Migrate from a project-local configuration

1. Inside the project, run `agent-fleet set-codex-mcp status`. `projectShadow` shows the project table and the policy root, profile, and principal it uses.
2. Decide which namespace the user-level entry should select. Rights are bound to one Codex conversation (its thread UUID) and one target epoch, so a **new** chat has no rights in either namespace and nothing needs migrating for it. To keep using an existing chat's bindings, pass that chat's `--policy-root`, `--host-profile`, `--principal`, and `--legacy-state-root` explicitly to `install`. Otherwise accept the defaults; the old namespace stays on disk untouched, and deleting it later is your decision, never the command's.
3. Run `agent-fleet set-codex-mcp install`.
4. Remove the `[mcp_servers.af-local-read]` table from the project `.codex/config.toml` yourself, or the whole file when it holds nothing else. Until you do, `status` keeps reporting the shadow and Codex keeps using the project entry inside that project. Any manual `enabled_tools` list goes with it.
5. Remove the project-local skill symlink or directory under `<project>/.agents/skills/` so one copy remains.
6. Reload Codex, open a new chat, and run the [verification](#verify) steps.
7. If an `/af-codex-events` private config exists, it names a binding and epoch of the old namespace and chat. After enrolling in the new chat, update that config and run `/af-codex-events prepare` again; the command does not touch it.

## Remove

Removing the registration does **not** revoke persisted permissions, so remove rights first, while the tools are still available:

1. In every chat that holds rights, use the reviewed `fleet_binding_prepare` intents: `forget` removes read, send, and approve for a binding; `revoke_send` or `revoke_approve` remove one right while keeping read. Verify afterwards with `fleet_check_read` and `fleet_permissions`. Historical receipts remain readable; that is not a live grant. See [security limits and removal](codex-local-mcp.md#security-limits-and-removal).
2. Run `agent-fleet set-codex-mcp uninstall`. It backs up `config.toml`, runs `codex mcp remove af-local-read`, re-reads the list, deletes both receipts, and moves the skill tree to `$CODEX_HOME/agent-fleet/backups/fleet-native-voice-uninstall-<timestamp>`. An entry or tree without a matching receipt needs `--force`; a skill symlink is refused regardless.
3. Reload Codex through the host's supported procedure.

The result reports `bindingsRetained: true`. Policy roots and their siblings, the legacy archive, the backups, any `/af-codex-events` config and journals, and the auto policy file all stay in place. Deleting them is a separate decision; the command never does it, and it never stops Fleet peers.

## Files this command touches

| Path | Written by |
| --- | --- |
| `$CODEX_HOME/config.toml` | `codex mcp add` / `codex mcp remove` only |
| `$CODEX_HOME/agent-fleet/af-local-read.receipt.json`, `fleet-native-voice.receipt.json` | `install`, `update`, `uninstall` (mode `0600`) |
| `$CODEX_HOME/agent-fleet/backups/config.toml-<timestamp>` | every `install`, `update`, or `uninstall` that changes the entry |
| `$CODEX_HOME/agent-fleet/backups/fleet-native-voice-<timestamp>`, `fleet-native-voice-uninstall-<timestamp>` | a replaced or removed skill tree |
| `$CODEX_HOME/agent-fleet/state/` | created empty as the parent of the default policy root |
| `~/.agents/skills/fleet-native-voice/` | `install`, `update`, `uninstall` |

Never touched: a project `.codex/config.toml` or `.agents/skills/`, the contents of any policy root or sibling, the legacy archive, the `/af-codex-events` config, `.pi/damage-control-auto-policy.yaml`, and anything inside the workspace.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| `status` exits 2 with `errors` | A refusal: Node too old, an `npx` runtime, a relative or overlapping root, a symlinked state root, an unsafe profile or principal name, or an unsupported platform. Nothing was written; fix the listed cause. |
| `codex mcp list --json` returned unexpected output | The installed Codex CLI differs from the verified one; check `codex --version`. |
| `af-local-read probe failed … LOCAL_MCP_START_FAILED` | The runtime distribution is incomplete or the Node is too old. Nothing was written. |
| `codex reports no af-local-read entry after add` | Codex did not persist the entry as expected. No receipt was written; inspect `config.toml` and the named backup. |
| `projectShadow.shadowed: true` | A project table shadows the user entry in this project. Remove that table yourself. |
| entry `drifted` or `broken` after a Node change | Run `agent-fleet set-codex-mcp update`. |
| skill `symlink` | The command never follows or replaces it; remove the symlink yourself first. |

For tool-level error codes such as `IDENTITY_REQUIRED`, `STATE_MISSING`, or `NOT_ALLOWED`, see the [native guide's troubleshooting table](codex-local-mcp.md#troubleshooting).
