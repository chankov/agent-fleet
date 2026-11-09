# Migrating from the retired Fleet Codex CLI

The `fleet-session-client` skill, `fleet-codex-client.ts` command, Python read helper, and experimental `chatgpt-client` installation feature are retired. The older Codex Remote-Control conductor remains retired as well. Neither is a fallback for missing native tools.

Use the [native Codex MCP guide](codex-local-mcp.md) for current setup and operations, and the [native text/voice workflow](fleet-native-voice.md) for conversational use. The replacement requires real per-call native MCP conversation context from a compatible local Codex host. Hosts without that context, including older Desktop/Android routes that only supplied CLI environment identity, are no longer supported by this integration. No mobile or remote replacement is promised.

## Preserve data before changing routes

Do not delete or edit the original CLI selection files, `.runtime` journals, receipts, locks, or backups. A successful instruction, an unknown outcome, and an unavailable result are different records; none authorizes replay. Existing files remain historical evidence even when their writer is retired.

The CLI default was `$CODEX_HOME/fleet-client`, or the `fleet-client` directory under the default Codex home when `CODEX_HOME` was absent. A custom `--state-dir` could choose another location. Determine your actual original location yourself; the native server does not search the environment or import arbitrary directories.

For the same real conversation UUID, explicitly configure `--legacy-state-root` on the native launcher and use `fleet_legacy_history` to read redacted, paginated historical data. See [local history and archive access](codex-local-mcp.md#local-diagnostics-snapshots-and-legacy-history) for the exact limits and identity boundary. Original wire IDs, digests, timestamps, and unknown results are not transformed into new actions. A detached selection can be absent while its runtime journal remains readable. Old action IDs remain reserved against new native delivery when the archive is configured; configure it before overlapping new instructions or answers.

This is read-only compatibility, not automatic transfer of grants or a rewrite into the native action ledger. Different conversation IDs require an explicit mapping decision outside this automatic path; their archives must remain intact. A root or state validation error must not be worked around by resetting, copying another chat's files, or inventing identity.

## Replace the operations, not the old command

| Retired CLI use | Native replacement |
| --- | --- |
| sessions / select / detach | `fleet_discover`; reviewed binding enroll/rebind/forget with exact target/epoch and fresh confirmation |
| status | `fleet_check_read`; registry/policy evidence, not task completion |
| summary / activity / questions | `fleet_observe`; full bounded question data for addressing a question |
| resync | `fleet_resync`, with explicit local cursor writes and gaps |
| watch | Explicit bounded `fleet_watch` while the conversation is active; longer requested periods use bounded calls within that time budget, not a daemon |
| send | `fleet_instruction_prepare`, one commit, exact receipt; an explicit user send to one unambiguous selected current session with read+send needs no second confirmation; otherwise clarify or obtain preview confirmation as described in the [native send contract](codex-local-mcp.md#send-an-instruction) |
| answer / cancel-question | `fleet_answer_prepare`, actual human answer or explicit question-scoped refusal, fresh preview confirmation, one commit and receipt; not Pi-turn cancellation |
| replay | Explicit `fleet_snapshot` followed by local historical `fleet_replay`; legacy saved reports are available through the configured archive reader |
| receipts | `fleet_receipts`, exact instruction/answer receipt lookup, and opt-in `fleet_legacy_history` for old records |
| doctor / describe / help | `fleet_diagnostics`, actual MCP tool schemas, registry/read checks and authorized capability observations; static diagnostics are not receiver readiness proof |

The native interface changes authorization deliberately: legacy selection does not grant read or send, read does not grant send, and an old send grant does not supply a human answer. Keep technical prepare/commit for every send. Explicit user sends follow the limited no-second-confirmation path above; binding changes, answers, model-initiated sends and substantively expanded instructions retain their own reviewed confirmation requirements. Do not send an old uncertain action again to demonstrate migration.

## Repair retired installer selections

Requests for `--features chatgpt-client` or `--features codex-remote` are rejected without enabling another integration. If either name remains in `.ai/agent-fleet.json`, even as `false`, use the normal installer config-repair flow to review the exact removals and explicitly approve its backup. `--yes` alone is not config-repair approval. Keep the workspace's other feature selections.

Config repair removes only the retired desired-state settings; it does not install native MCP, enroll targets, copy history, remove private journals, or stop sessions. Review the normal installer plan before removing previously owned runtime/skill files. Modified or foreign files retain the installer's ownership/conflict protections. Old release snapshots remain for migration and are not an active source of the retired integration.

Install/configure the native server and skill separately using the linked guides. Removing an old skill or registration does not revoke existing native permissions, and no upgrade should silently rebind a target or change the running Pi session.

## Limits and evidence

Native operations and archive compatibility have local fixture, subprocess, and temporary-socket regression coverage. These are not proof that your host has loaded the new source or that all hosts work. The bounded real desktop voice route established native discovery/read-policy checks, not every mutation through voice. Verify actual native availability in your intended conversation without fabricating context, granting automatically, restarting Fleet, or restoring a retired transport.
