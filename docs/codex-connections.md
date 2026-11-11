# Native chat connections (explicit preview/commit)

## 2.1.1 patch scope and verification boundaries

The pending 2.1.1 patch includes the three connection tools, separate default 12-hour leases for new connections, live-safe renewal of an already configured mapping, the Fleet View chat panel, bounded opaque question references, and the separate private-configuration verification mode. See [operator current-state verification](operator-current-state.md#private-codex-notification-configuration-current-state) for the private mode's constraints; its whole-feature independent review is still a release-readiness obligation, not completed by a changeset.

Explicit faithful user sends to one selected read+send target do not require a redundant second human confirmation. Technical prepare/commit and all separate grant/question/permission/host-approval requirements remain; see the [send contract](fleet-native-voice.md#send-an-instruction-explicit-user-sends-need-no-second-confirmation). The source skill and packaged voice archive contain this rule, but an older installed skill can still request the second confirmation until it is updated and reloaded through the managed host workflow.

Recorded implementation checks include isolated connection prepare/commit/status over STDIO, exact temporary Unix-socket transport tests, lease and no-replay regressions, and bounded/sanitized/scrollable Fleet View tests. Separately authorized operational work verified an exact new AF epoch, explicit notification prepare/enable and one actual message delivery to the selected Codex chat. It did not newly exercise question responses or Damage Control after that reload, and it does not close the private-verification feature's independent review. The actual Fleet View panel's visual acceptance in the live TUI remains pending; a live status API response is not a visual test.

Full final-response reading appends `fleet_response_read` as the 28th source tool. It uses existing read rights and the exact live Fleet session, not a new archive or direct Codex file access; see [the response contract](codex-local-mcp.md#read-a-full-final-fleet-response). A source-only change does not reload a receiver or Desktop.

A fresh 28-tool runtime and managed registration are not proof that a running Desktop host has refreshed its cached 24/27-tool catalog. The deployment steps below remain necessary where the old catalog or skill is loaded. This is a verification boundary, not a promise of automatic publication, refresh, binding, activation or renewal.

## Scope and acceptance

The native MCP workflow removes Fleet command/copy-paste steps for **rights enrollment** and for **renewal of an already configured, active exact notification mapping**. It does not implement or claim automatic first-time Desktop mapping, daemon start, background delivery after restart, host reload, or model delivery from a queue ACK.

Approved product decisions:

- `read` remains mandatory. `send` and `approve` are independent additions.
- New connections created by this workflow have a 12-hour rights lease by default; notification proposals also default to 12 hours. `durationHours` accepts 1–720 hours, explicitly reviewed. Deadlines are fixed at prepare, not extended by a slow commit.
- Existing policy entries and legacy binding tools retain their prior contract. Existing rights are neither silently shortened nor extended. Use the explicit binding transition tools to change them; expired leases require explicit forget/re-enrollment.
- `message`, `question`, and `permission` are three notification kinds, not three rights. A question still requires an actual human answer. A permission event still requires full fresh inspection and an independently justified one-use Codex machine decision with separate `approve` authority.

## UX

The optional repository skill is `skills/fleet-connect/SKILL.md`. Its installation/availability depends on the host's supported skill loader; it is not automatically installed by this change.

1. Discover and choose exactly one current target. Never infer a target from a friendly alias alone.
2. Call `fleet_connect_prepare` with `{target, rights:["read", "send", "approve"]}` as explicitly selected. Rights must be unique and in canonical read/send/approve order. Omit optional rights, never assume them.
3. The notification default is on, but requires `desktopConfirmed:true` and an already active, configured mapping for the exact current native chat. Missing evidence yields a blocker and no grant. Use `notifications:false` only if the human wants rights-only enrollment.
4. Present the returned target, rights, both deadlines and effects; obtain explicit human confirmation. New policy-v3 leases also require explicit old-writer quiescence confirmation.
5. Call `fleet_connect_commit` once. For a new lease pass `quiescentWritersConfirmed:true` only after that confirmation. A proposal lasts 300 seconds and is current-chat scoped. It is lost on MCP restart.
6. Call `fleet_connection_status` for fresh policy/receiver observations. `committed` describes the local transition; inspect `notifications.status` separately. Unknown/partial effects never authorize replay.

The connection tools extend the current source catalog from 24 to 27 tools. Source availability is not proof that a running host has loaded them. Validate the actual host after an approved reload; do not restart a working Fleet instance automatically. The runtime explicitly accepts the pinned 24-tool and 27-tool catalogs for notification compatibility, alongside the current 28-tool catalog. Those older catalogs do not establish full-response support. Partial/unexpected catalogs are refused.

## Policy and expiry

New `connect` grants use canonical private allowlist schema v3, adding per-binding `expiresAt`. Existing v1/v2 entries remain readable and unchanged. All policy actions rehydrate through the lease check; expiry denies read/send/approve while preserving historical stored rights. Before-write authority checks in instruction/permission transports remain in force. Granting approve on v3 must not downgrade the file to v2. Old readers/writers refuse v3; stop those writers before an upgrade, do not downgrade or restore old snapshots.

Rights and notification deadlines are distinct. A notification renewal never grants/extends rights, changes recipients, resets epoch/revision, creates a namespace, or clears receipts. The receiver rechecks fresh read authority and refuses a notification extension beyond an existing rights lease. Legacy unleased rights are explicitly reported as such. Revocation and expiry do not erase historical receipts.

## Receiver control and live-safe renewal

`connection_request` / `connection_response` v1 use the bounded, exact-owner COMS transport with the same socket/registry/correlation/before-write checks as permission RPC. They are cooperative same-UID interfaces, not human authentication or attested host origin.

- `status`: current native namespace policy and notification runtime state; no enable or daemon start.
- `prepare`: creates a short-lived in-memory renewal proposal for the **same active chat and exact AF owner** after explicit loaded-Desktop confirmation.
- `commit`: rechecks current rights, expiry, mapping and prior deadline, then makes one attempt. An uncertain attempt is retained, never repeated automatically. Restart loses the proposal, not durable policy/journals.

Renewal atomically persists a private replacement config, then updates the existing runtime in memory. The file contents must still match the expected configuration. The binding, epoch, authority revision and both journal roots stay unchanged. No consumer stop/start, queue write or replay is needed for renewal itself. Failure after persistence can remain uncertain/fail-closed; do not claim rollback.

This path becomes available only after the new AF receiver **and** native MCP tools are actually loaded. It cannot hot-patch an old running receiver. An active configuration must not be edited behind its runtime: that invalidates the owner's configuration check. A controlled rollout/enable requires a separate operational review. Source changes or a release alone perform no live renewal or restart; any separately authorized operational activation needs its own evidence.

## Fleet View

Open Fleet View and press **2** for the scrollable chat-connections panel (arrows/PgUp/PgDn/Home/End, Esc back). This leaves the ordinary agent/pool layout intact.

The view reads the explicitly configured private native policy directory, bounded to 256 directory entries/64 namespaces in the configured host namespace. Each candidate must have a private regular file, matching namespace hash and strict policy validation before rights are shown. Root/file symlinks, foreign ownership, unsafe permissions and hardlinks are not accepted. This is grant metadata inventory, never auth-file discovery.

Defaults follow the native Desktop setup:

- `AF_CODEX_POLICY_ROOT`: `~/.codex/agent-fleet/state/fleet-native`
- `AF_CODEX_HOST_PROFILE`: `desktop`
- `AF_CODEX_PRINCIPAL`: `local-user`

These optional process settings are source-level integration points, not installed settings. Custom launchers must point Fleet at their matching policy root/namespace. No environment file is read by this feature.

The panel refreshes on demand every two seconds, reports both deadlines and remaining time, stored rights, expiry/staleness/mapping/configuration reasons, and unknown delivery. Cached policy older than five seconds is marked unverified. Missing/unreadable inventory is not proof of no saved grants. A stopped consumer, expired confirmation, or changed mapping is not reported as enabled. Queue ACKs never become model-delivery proof.

## Restart and first-time bootstrap limits

- A new AF `sessionId`/`startedAt` is a different target; rebind explicitly. No automatic retargeting.
- Native host restart preserves policy but loses uncommitted proposals; no implicit confirmation refresh.
- AF restart stops notification runtime; the saved config does not auto-enable it.
- Desktop restart requires re-confirming the loaded chat and supported daemon/Desktop/schema tuple. Saved thread metadata alone is insufficient.
- First-time notification bootstrap for another chat has no trusted host-mapping provider here. `host_mapping_required` is an intentional blocker. Do not clone another recipient's approval or invent host evidence to hide it.
- A service auto-start alone does not solve these identity/consent requirements. A durable host bootstrap provider is a separate design/security change.
- Existing journal capacity and no-replay behavior still apply; this feature does not prune/rotate unknown attempts.

## Deployment and actual host catalog

A matching package version or `set-codex-mcp status: current` is not a catalog check. That command compares the managed launcher/receipt. A separate installed package can still contain 24 tools while a workspace with the same package version contains 27.

For a reviewed local deployment, use a versioned runtime snapshot containing the fixed `.mjs` bootstrap and its stripped-JS runtime import closure, plus a manifest of source hashes. Keep it outside the mutable worktree and do not delete it while a launcher references it. The existing managed installer can register this package root through `codex mcp add`, backing up `config.toml` and retaining the same registry root, policy root, host profile and principal. No host refresh is implied by registration.

The local release's `manage.mjs status` uses the same managed installer implementation, pinned with the release. Use that release manager rather than forcing an older global package's updater back to its 24-tool runtime. The preserved global package may intentionally report launcher drift relative to its own older runtime path. Do not restore old policy snapshots or downgrade v3 grants to work around that difference.

Safe completion steps:

1. Finish the current operation and ensure MCP calls in affected chats are idle. Keep the AF session and its notification consumer running.
2. In the **actual Desktop host**, use Settings → MCP servers → Restart, as described by the [official MCP guide](https://developers.openai.com/codex/mcp). Do not substitute an AF reload or full app restart. If the installed UI offers only a broader restart, stop and review its consequences separately.
3. The measured Desktop request schema includes `config/mcpServer/reload` with null parameters, not a per-server selector. Treat its scope as potentially all host MCP connections. Pending server-memory proposals are lost on MCP restart; durable policy and attempted-action receipts stay. Never repeat unknown actions.
4. The separate queue daemon's control socket is **not** the Desktop stdio app-server that owns the active MCP clients. Refreshing that daemon is not proof of a Desktop catalog refresh. Do not inject into existing stdio pipes or kill MCP clients as a replacement for the supported host action.
5. In a fresh turn in the same chat, obtain actual native diagnostics/tool availability. Require all 28 current names, including the three connection tools and `fleet_response_read`. A separately spawned `initialize`/`tools/list` probe proves the registered runtime starts, not that the active host has adopted it.
6. Verify `fleet_connection_status` against the exact existing target first. It must not change rights, expiry or delivery state. A rights-only `fleet_connect_prepare` with `notifications:false` can preview the existing connection without renewal; present its complete effects before any real commit. Isolated fixture commit tests are preferable to touching an active connection solely for a test.

A MCP-only refresh is not intended to change the native thread UUID or the AF epoch, but verify them rather than assuming. Existing 24-tool notification catalogs remain explicitly supported, so loading the connection trio does not require disabling/re-enabling notifications or extending their deadline. Initial notification bootstrap still has the host-mapping limitation described above.

### After the official 2.1.1 package is published

Install the published package through the normal [npm workflow](npm-install.md), then use the **updated** package's `set-codex-mcp` managed update workflow. Review a dry run first, preserving any custom registry/policy roots, Node path and host/principal namespace. Replacing a previous managed launcher or updating its managed voice skill may require `--force`; use it only after verifying ownership and the exact preview, never to overwrite an unknown entry or private skill edits.

The release includes the updated voice skill archive, unlike a local runtime-only snapshot that deliberately preserves an older installed skill. Updating only the server without the skill, or only the skill without actual host adoption, does not prove that the double-confirmation UX is fixed. After the reviewed update, wait for affected work to finish, use the supported host MCP/skill reload procedure, and inspect the actual tool catalog and discovered skill. No AF reload, permission re-grant, policy reset or notification deadline extension is implied.

Do not run `version:changeset`, publish, overwrite an existing local release, or refresh a live host as an incidental documentation task. The normal Changesets release PR generates the package/lockfile/changelog versions; this pending patch targets 2.1.0 → 2.1.1.

## Verification

Use the connection, allowlist, native MCP, notification runtime, permission/instruction and Dashboard/extension-loader test suites. Tests use isolated temporary stores, mocked hosts and exact temporary Unix sockets. They are not a new live-delivery claim. A live release still needs actual native catalog validation, receiver rollout review, incoming event evidence in the target chat, and separate permission decision/action receipts when testing Damage Control.
