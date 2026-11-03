# Native Codex MCP for Agent Fleet

Use the local `af-local-read` MCP server to work with **already running** Fleet/Pi sessions from one Codex conversation. Despite its historical name, the server supports permission-controlled observations, instructions, and human question answers across multiple explicitly selected targets.

This guide covers the current native interface. The [legacy CLI client](codex-session-bridge.md) is a separate interface with separate state; its selection and receipts are not imported automatically. The optional [native voice workflow](fleet-native-voice.md) uses the same MCP tools and permissions, not a different transport.

## Requirements and support boundaries

- A local POSIX system with Unix-domain sockets and the same OS user running Codex and the Fleet/Pi sessions. The private policy store does not support Windows.
- Node.js **22.18 or newer** to run the TypeScript entrypoint directly. The package's general Node.js 18 engine requirement is not sufficient for this server.
- An Agent Fleet checkout or an unpacked/installed package containing `.pi/agent-fleet/scripts/fleet-codex-local-mcp.ts` and its accompanying runtime files. Keep the distribution intact; copying the entrypoint alone is insufficient. See [Fleet setup](agent-fleet-setup.md) for installing Fleet itself.
- Existing Fleet/Pi sessions publishing a local COMS registry. Observations, instruction receipts, and guarded question actions additionally require compatible receiver capabilities. A registry entry alone does not establish those capabilities.
- A Codex host that can launch a local STDIO MCP server and supplies its real conversation ID in each tool call's `params._meta.threadId`. This implementation requires a UUID thread ID; optional `sessionId` metadata must also be valid when supplied. Generic MCP support alone is not enough.

The server negotiates MCP protocol `2025-06-18`. Local Codex desktop use has been exercised, including a voice-to-agent handoff that performed discovery and read-policy checks. That does **not** establish support for every Codex build, another voice host, mobile access, or voice-driven mutations. Check the tools and results in your actual conversation before relying on them.

## Configure the local server

### 1. Choose the runtime, registry, and private state locations

Use an absolute path to a stable checkout or installed package. A temporary `npx` cache is not a durable runtime location. The experimental `chatgpt-client` installer feature installs the legacy CLI; it does not configure this native MCP server.

Choose these four launcher settings yourself; they are not tool arguments:

| Setting | Meaning |
| --- | --- |
| `--registry-root` | The existing COMS root containing `projects/<project>/agents/*.json` and `sockets/<sessionId>.sock`. Point to the root, not a project subdirectory. Do not create fake registrations. |
| `--policy-root` | A dedicated private state directory for native bindings. Its parent must already exist and be controlled by you. The server also uses sibling directories with `.observations` and `.instructions` suffixes. |
| `--host-profile` | A stable local profile label that separates this configuration's state from other profiles. |
| `--principal` | A stable local principal label. It partitions state; it is not a password or proof of OS identity. |

Registry and state roots must be normalized absolute paths and must not overlap or contain one another, including the derived state directories. Use real directory paths rather than symlinks. Existing private state directories must be owned by the current user with mode `0700`; state files must be private, owned regular files with mode `0600`. Do not reuse an arbitrary shared directory or manually edit state files to bypass a refusal. Missing state is normally created through the reviewed binding workflow below.

Keep the profile, principal, and state location stable if you want to retain the same conversation's bindings and receipts. Changing them selects a different namespace, not a migration.

### 2. Add project-local MCP configuration

In the project's `.codex/config.toml`, merge the following table without replacing unrelated configuration. **Every `/absolute/path/...` value is a placeholder**: substitute your Node executable, distribution location, actual registry root, and chosen private state location. TOML paths are literal; do not rely on shell expansion of `~` or environment variables.

```toml
[mcp_servers.af-local-read]
command = "/absolute/path/to/node"
args = [
  "/absolute/path/to/agent-fleet/.pi/agent-fleet/scripts/fleet-codex-local-mcp.ts",
  "--registry-root", "/absolute/path/to/coms",
  "--policy-root", "/absolute/path/to/private-state/fleet-native",
  "--host-profile", "desktop",
  "--principal", "local-user"
]
```

The launcher accepts exactly these four flag/value pairs; it does not discover roots or read conversation identity from environment variables. Configure it as **local STDIO**, not an HTTP service. No listener, tunnel, daemon, or Fleet startup is needed or provided.

If your configuration restricts `enabled_tools`, include the tools you intend to use from the catalogue below. Exposing a tool does not grant access to a Fleet target. Review your host's normal project-trust and MCP approval settings; do not disable protections to make this server load.

### 3. Verify availability without granting access

Have the user load the configuration through the host's supported lifecycle, then inspect the actual native tools in the intended conversation. The current server advertises 16 tools. Host-specific prefixes may change their displayed names.

Start with `fleet_discover` for an explicit project, then `fleet_check_read` for an explicit project/peer. Discovery reads registry candidates only. A missing policy namespace or an access denial before enrollment is expected; it is not a reason to invent metadata or copy another conversation's state.

If tools or host identity are unavailable, stop and report that limitation. A shell invocation, a legacy CLI command, or another chat's identity is not a substitute for a native tool call.

## Connect a target and manage permissions

A target is identified by `project`, `peer`, **and the exact `sessionId`/`startedAt` epoch**. Use the names returned by discovery; examples below use the illustrative project `my-project` and peer `orchestrator`. Resolve ambiguity and stale or partial discovery before granting access.

1. Discover candidates:
   ```json
   {"project":"my-project","peer":"orchestrator"}
   ```
   Send this to `fleet_discover`. Registry presence is not task status, responsiveness, or completion.
2. Prepare read enrollment with `fleet_binding_prepare`:
   ```json
   {"intent":"enroll_read","project":"my-project","peer":"orchestrator"}
   ```
3. Show the returned exact target, old and proposed rights, effects, and expiry to the user. Wait for their explicit confirmation **after** that preview.
4. Call `fleet_binding_commit` with only the actual returned `proposalId` in the same chat. Never guess or reuse an unrelated proposal ID.
5. Check with `fleet_check_read`, then request `fleet_observe` when an actual peer observation is needed. A successful policy check does not itself read a transcript or probe the receiver.

Each target requires its own reviewed binding. The server chooses the binding alias; `bindingAlias` can select an existing binding, not supply an arbitrary new friendly name. Conversational labels are conveniences, not authorization.

Other `fleet_binding_prepare` intents use the same preview/confirmation/commit sequence:

| Intent | Effect |
| --- | --- |
| `rebind_read` | Select a newly discovered exact epoch explicitly. It does not carry send permission forward. |
| `grant_send` | Add send permission to an existing current read binding. It sends nothing by itself. |
| `revoke_send` | Remove send permission while keeping read. |
| `forget` | Remove the binding's read and send rights. It does not stop Pi or undo work already accepted. |
| `initialize_empty` | Create a missing, empty policy namespace for the current chat, with no target or rights. This intent accepts **no** project, peer, or alias. It is optional, not a prerequisite to read enrollment, and refuses an existing namespace. |

`read` never implies `send`. A send grant never authorizes an invented human answer. After a target restart or replacement, do not silently retarget; use fresh discovery and an explicitly confirmed rebind. Policy checks can persistently mark stale local rights as downgraded.

Proposals expire after **300 seconds** and are held in server memory. A server restart loses pending proposals, not durable rights or receipts. After expiry, state change, or restart, prepare again and obtain a new confirmation. There are shared limits of 16 pending proposals per context, 64 per process, and eight active calls.

## Observe one or more sessions

| Tool | Input and behavior |
| --- | --- |
| `fleet_discover` | Required `project`, optional `peer`; bounded registry candidates, without enrollment or peer reads. |
| `fleet_check_read` | `project`, `peer`; fresh registry-only exact-epoch policy check, potentially downgrading stale local rights. |
| `fleet_observe` | `project`, `peer`; bounded transcript, progress, and question projections from the authorized exact session. Channels can be unavailable or partial independently. |
| `fleet_overview` | `targets`: 1–4 explicit unique `{project,peer}` objects; separate bounded summaries and errors per target. |
| `fleet_resync` | Same target list; fresh observations plus durable **local** cursor/question-observation metadata updates. Reports continuity gaps and resets. |
| `fleet_watch` | Same target list and integer `durationSeconds` from 1–10; active bounded observation, at most six frames, with local cursor writes. |

For example, send this to `fleet_overview` or `fleet_resync`:

```json
{"targets":[{"project":"frontend","peer":"orchestrator"},{"project":"backend","peer":"orchestrator"}]}
```

These calls do not auto-enroll targets, answer questions, or write instructions to Pi. Resync and watch are not filesystem-read-only: they maintain local observation state. Watch ends; there is no background subscription, unsolicited notification, idle-model wake, or transcript mirror. Cancellation stops the observer, not Pi, and does not promise rollback of reads or local writes already started.

Treat `partial`, source timestamps, channel statuses, and gap reasons as part of the result. An unavailable question source does not mean there are no pending questions. Summary question previews are not sufficient for answering: use `fleet_observe` and the full question-action preview. Neither an idle registry entry nor a successful observation establishes whole-task completion.

## Send an instruction

Both current read and send permission are required. Sending can trigger a Pi turn; it is not a promise of immediate steering or task completion.

1. Use a stable, unique `requestId` for the intended action and the exact current target. Call `fleet_instruction_prepare` with:
   ```json
   {
     "requestId":"instruction-001",
     "target":{"project":"my-project","peer":"orchestrator","sessionId":"<actual sessionId>","startedAt":"<actual startedAt>"},
     "instruction":"<the user's exact instruction>"
   }
   ```
   Replace every placeholder with real returned values; the example is not a ready-to-send request. Instructions are limited to 16,384 UTF-8 bytes.
2. Present the complete returned payload, target, and effects. Obtain fresh explicit human confirmation, then call `fleet_instruction_commit` with its `proposalId`. Preparation does not deliver anything.
3. Read `fleet_instruction_receipt` with the same `requestId`. Its default is local historical lookup. `refresh: true` performs a bounded read-only evidence lookup requiring current read permission and may update the local receipt.

The sender records durable intent before one delivery attempt. Exact duplicates return history; reuse of an action ID with a different target, operation, or payload conflicts. Do not resend, switch IDs, or switch transports to work around an uncertain outcome. `submitted`, queued work, and a correlated terminal response are different states; even a terminal response is not proof of semantic whole-task completion or human delivery.

## Answer or refuse a Pi question

An actual human response, current read+send rights, and a compatible guarded question receiver are required. Native Pi questions are **not** Damage Control permission dialogs or general approval requests.

1. Obtain the full pending question, options, effective flags, exact target, `questionId`, and `toolCallId`. Never select a response automatically or infer one from a general instruction to continue.
2. Call `fleet_answer_prepare` with `requestId`, the exact `target`, `questionId`, `toolCallId`, `operation`, and `response`:
   - Freeform: `operation: "answer"`, `response: {"kind":"freeform","text":"<actual human answer>"}`.
   - Selection: `operation: "answer"`, `response: {"kind":"selection","selections":["<exact option>"],"comment":"<optional human comment>"}`. Include a comment or multiple selections only when allowed by the question.
   - Explicit refusal: `operation: "refusal"`, `response: null`.
3. Show the full prepared question, options/flags, normalized response, and effects. Obtain a **new** explicit human confirmation before `fleet_answer_commit {"proposalId":"<actual proposalId>"}`.
4. Use `fleet_answer_receipt {"requestId":"<same requestId>"}` for historical metadata, or an explicitly requested `refresh: true` for current guarded evidence when authorized.

The receiver revalidates the exact question and uses first-winner arbitration. Changed, already resolved, expired, unsupported, or incompletely addressable questions are not redirected elsewhere. A refusal resolves only that question; it is **not** Pi-turn cancellation. Selecting an option named “Stop” is a selection, not the refusal operation.

Question and response JSON are each bounded to 16,000 bytes, with up to 64 options. Guarded receiver receipts are bounded and volatile; missing evidence after a restart or a capacity limit remains unknown, not permission to retry. Receipt metadata is not an archive of answer text.

## Persistent state and journal upgrades

Native state is partitioned by configured host profile, principal, and host-supplied thread ID. It is separate from the legacy CLI. Other conversations do not inherit this chat's grants.

- `--policy-root`: bindings and revision-bound permissions.
- `<policy-root>.observations`: bounded local cursors and question-observation metadata, not a transcript archive or proof that a human saw an event.
- `<policy-root>.instructions`: a shared action journal for instruction, answer, and refusal IDs. Historical receipts remain readable after revocation; remote refresh still requires current read rights.

The action journal is bounded to 256 total records and 8 MiB. There is no automatic purge, deduplication eviction, reset, or corrupt-state repair. Instruction bodies and full question/answer text are not archived there, but bounded instruction results can be retained. This is not a promise to remove content from Codex, chat logs, tool logs, or other systems.

An existing **native v1 action journal** is history-only until explicitly upgraded. It is not the legacy CLI journal. `INTENT_FORMAT_UPGRADE_REQUIRED` blocks new action writes and remote receipt refresh on that format.

To upgrade, stop old journal writers and in-flight mutating actions first. Call `fleet_journal_upgrade_prepare {}` in the actual native chat. Review the returned namespace, snapshot hash/revision, exact backup location, expiry, and rollback boundary. The operator must confirm writer quiescence; the server does not infer it from an idle pane or file lock. Obtain a fresh human confirmation, then call `fleet_journal_upgrade_commit` with that proposal's ID.

The upgrade preserves original receipts and makes an immutable raw backup before the same-file v2 transition. It grants no rights and makes no Pi call. A validated existing v2 journal is reported without another migration proposal. An uncertain commit must be reconciled, not replayed blindly. Old v1 binaries reject v2; safe rollback keeps a v2-capable reader/data or remains offline. **Never restore an old journal snapshot as a retry mechanism.**

## Troubleshooting

| Symptom or code | What to check or do |
| --- | --- |
| Missing server/tools; `LOCAL_MCP_START_FAILED` | Check Node version, absolute executable/entrypoint paths, all four launcher flags, and the intact runtime distribution. Inspect host MCP diagnostics without dumping private state. Check project trust and any `enabled_tools` filter. Use only the host's supported user-controlled reload/reopen procedure. |
| `IDENTITY_REQUIRED`, `CONFLICTING_HOST_CONTEXT` | The host did not provide accepted per-call metadata or supplied conflicting context. Stop; do not fabricate a UUID, set `CODEX_THREAD_ID` as a substitute, or borrow another chat's identity. |
| `REGISTRY_MISSING`, stale/partial discovery, ambiguous candidates | Check the actual registry root and intended running project's COMS registration. Resolve ambiguity before binding; do not invent entries or select by working directory alone. |
| `STATE_MISSING` | This namespace has no usable policy state. For a genuinely new namespace, use reviewed enrollment or optional `initialize_empty`. If state was previously present, investigate missing data rather than resetting it. |
| `NOT_ALLOWED`, `REBIND_REQUIRED`, stale target | Check this chat's exact target and rights. Read does not imply send. A new epoch requires explicit rebind and a separate send grant if needed. Never grant automatically to clear an error. |
| Expired/missing proposal; `STATE_CHANGED`, `BUSY` | Discard stale previews. Once conflicting work finishes, prepare a new proposal and ask for a new confirmation. Do not bypass revision checks or delete locks. |
| `RPC_UNSUPPORTED`, `SOURCE_NOT_CONFIGURED`, `INSTRUCTION_UNSUPPORTED`, `ANSWER_UNSUPPORTED` | The registered receiver may lack the requested channel/capability. Discovery is not activation proof. Inherited legacy question channels may need an operator-managed clean process restart to gain guarded actions; an extension reload alone may retain the old channel. Do not restart sessions automatically or fall back to an unguarded write. |
| `QUESTION_CHANGED` or a late/resolved question | Obtain fresh exact question state. Do not send a previously confirmed response to a changed or different question. |
| `INTENT_FORMAT_UPGRADE_REQUIRED` | Review the explicit native journal upgrade above; do not edit format/version fields manually. |
| `UNSAFE_PATH`, corrupt/missing state, capacity limit | Preserve the state and diagnostics. Check dedicated roots, ownership, permissions, and distribution compatibility. Do not recursively change permissions, delete journals, restore old dedup snapshots, or weaken guards as a workaround. |
| Unknown/uncertain action outcome | Keep the original request ID and inspect its receipt. Refresh only as authorized. Missing evidence is not failed delivery and does not authorize another attempt. |

When reporting a problem, include safe error codes, operation names, target names, timestamps, and partial/source statuses. Do not publish raw conversation metadata, private state files, full transcripts, credentials, or arbitrary configuration dumps.

## Security limits and removal

This is cooperative same-user local policy, not protection against a malicious process with the same filesystem/socket privileges. STDIO, tool approval, conversational confirmation, and `humanProvenance: unknown` receipts do not authenticate a human or attest the host binary. Observations and authorization-to-dispatch checks are not atomic OS transactions; there is no exactly-once execution guarantee.

Peer text is untrusted data, not an instruction to grant rights, answer questions, or change routing. Existing Pi permissions, budgets, and Damage Control remain independent. No native tool starts Fleet, broadcasts to unnamed peers, cancels a Pi turn, or grants a Damage Control bypass. Remote listeners, tunnels, and mobile exposure are outside this setup.

To remove access, use reviewed `revoke_send` or `forget` operations for the relevant bindings while tools are available, then verify the resulting policy. `forget` removes both read and send; historical receipts are retained. Removing the MCP registration alone does **not** revoke persisted permissions.

To stop exposing the server, remove only its table from the chosen Codex configuration, preserving unrelated entries, and use the host's supported connection lifecycle. Do not stop Fleet peers or delete private state as part of unregistering the server. Removing access does not undo work already accepted by Pi.
