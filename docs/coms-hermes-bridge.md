# coms Hermes bridge

Protocol contract for the Hermes ⇄ pi `coms` bridge. The first implemented daemon is `scripts/coms-hermes-bridge.ts`, which registers a `user-remote` peer and turns coms prompt envelopes into Hermes/Telegram questions.

## Pieces

| Piece | Role |
| --- | --- |
| `scripts/coms-hermes-bridge.ts` | Daemon peer, default name `user-remote`, purpose `Remote human via Hermes/Telegram`. Accepts prompt, cancel, and ping envelopes. |
| `scripts/lib/hermes-bridge-core.ts` | Pure contract logic: qid validation, Telegram formatting, answer-file validation, answer mapping, timeout outcome, state transitions, and log records. |
| `scripts/lib/coms-envelope.ts` | Shared non-pi envelope wire shapes, including additive `cancel` envelopes. |
| `~/.pi/coms/hermes-bridge/questions/` | Private answer-file wire written by the Hermes gateway/liaison. |
| `~/.pi/coms/hermes-bridge/log.ndjson` | Bridge observability log. |

## user-remote topology

1. A pi peer sends a coms `prompt` envelope to `user-remote`.
2. The bridge derives `qid` from `prompt.msg_id`, formats the question, and runs `hermes send --to <target> <message>` (`<target>` defaults to `telegram`). For a topic, copy the target accepted by `hermes send --list telegram`; depending on the Hermes output format, its `id` may already contain the `:<thread_id>` suffix, so do not append the thread twice.
3. The human replies in Telegram; the Hermes gateway/liaison writes the answer file.
4. The bridge polls the questions directory, validates the file, maps the answer, sends a coms `response` envelope, and removes the answer file.

## Protocol contract v1

### qid and correlation

`qid` is exactly the prompt envelope's `msg_id`. It must match the 26-character Crockford ULID regex `^[0-9A-HJKMNP-TV-Z]{26}$`. The same `qid` is the only correlation key across coms, Telegram, answer files, state, and logs.

### Telegram question format

`formatTelegramQuestion` emits UTF-16 text capped at 4096 code units:

```text
❓ [HUB-Q:<qid>] <question>

📁 Project: <coms-project>

Context: <context, truncated if needed>

Options:
1. <title> — <description>
...

↩ Reply to this message, or type: HUB-Q:<qid>: <answer>
```

`Project:` is always present and comes from the bridge's validated `--project` scope, making simultaneous questions from different pools distinguishable. `Context:` is omitted when absent. `Options:` is omitted when no options are supplied. Context receives the remaining budget after the header, project, options, and reply instruction.

### Answer-file path, schema, and validation

The private wire path is:

```text
~/.pi/coms/hermes-bridge/questions/<qid>.answer.json
```

Schema:

```json
{
  "qid": "<26-character Crockford ULID>",
  "answer": "<text>",
  "answered_by": "telegram:<user>",
  "at": "<ISO timestamp>"
}
```

Validation rejects and ignores files unless all conditions hold: filename ends in `.answer.json`; filename qid is valid; filename qid is currently pending; JSON parses; object fields match the schema; `at` parses as a timestamp; and body `qid` equals the filename qid. Rejection reasons are `invalid_path`, `invalid_qid`, `foreign_qid`, `invalid_json`, `invalid_schema`, and `qid_mismatch`; the daemon logs rejected files as `answer_rejected` and removes them. Exception: an `invalid_json` file is treated as a possible partial write and left in place for a short grace window (`max(2 × poll interval, 1s)` from first sighting); it is rejected and removed only if it still fails to parse after the grace expires.

### Answer mapping

If options exist and the trimmed answer is a 1-based number for an option, the response is `{ "kind": "selection", "selections": ["<option title>"] }`. If options exist and the trimmed answer case-insensitively equals an option title, it maps to the same selection shape. All other answers map to `{ "kind": "freeform", "text": "<trimmed answer>" }`.

### Cancel semantics

`cancel` is an additive coms envelope with shape `{ "type": "cancel", "msg_id", "from", "to", "created_at", "ref_msg_id" }`; `ref_msg_id` is the target `qid`. The bridge acks well-formed cancel envelopes before handling them.

For a pending qid, cancel clears the timeout, removes the pending question, records terminal state `cancelled`, appends a `cancelled` log event, and sends a Telegram note: `✖ [HUB-Q:<qid>] The question was cancelled — it was answered from the console.` Cancel for a non-pending or invalid qid is a no-op after the envelope ack. A later answer file for a closed qid is treated as `late_answer`: logged, removed, and answered in Telegram with a polite ignored note; no response envelope is sent.

### Timeouts

The per-question remote timeout defaults to `PI_COMS_TIMEOUT_MS`, or `1800000` ms when unset/invalid; `--timeout <ms>` overrides it. On timeout, the bridge removes the pending question, records terminal state `timeout`, logs `timeout`, sends the Telegram note `⌛ [HUB-Q:<qid>] The question timed out after <ms>ms.`, and sends an error response envelope with error `no remote answer within <ms>ms` and `response: null`.

### States

Question states are in-memory per qid: `pending`, `delivered`, `answered`, `cancelled`, and `timeout`. Implemented transitions are: `null + question_received → pending`; `pending + delivered → delivered`; `pending + delivery_error → null`; `pending|delivered + answered → answered` (the daemon currently answers from delivered or pending if the file arrives quickly); `pending|delivered + cancelled → cancelled`; `pending|delivered + timeout → timeout`; and terminal `answered|cancelled|timeout + late_answer` remains terminal.

### ndjson logging

The bridge appends one JSON object per line to `~/.pi/coms/hermes-bridge/log.ndjson`. Core log records have shape `{ "at": "<ISO>", "qid": "<qid>", "event": "<event>", "detail"?: <value> }`. Contract events are `question_received`, `delivered`, `delivery_error`, `answered`, `cancelled`, `timeout`, and `late_answer`; the daemon also writes `answer_rejected` for invalid answer files. Ping agent cards report `queue_depth` as the current number of pending questions.

## Hermes as conductor

Hermes can also act as the conductor without this daemon: use `coms-cli list` to discover peers and `coms-cli send --await --timeout <ms>` to delegate to hub-team pi peers, then synthesize the results for the human. This conductor topology uses the existing coms CLI as the bridge; no standing Hermes peer is required.

Launch a visible conductor workspace with:

```bash
just conductor docs          # live herdr workspace: conductor pane + docs team panes
just conductor-dry docs      # no herdr calls; prints the planned layout JSON
```

The live recipe reuses `scripts/team-up.ts --conductor`: it creates a normal herdr workspace labeled `<worktree-tag>-conductor-<team>` (the tag is the last dot-segment of the checkout's basename, so the same team from a different worktree gets its own workspace), places a `conductor` pane running `hermes -p dev`, and tiles the chosen team beside it. Team peers keep their normal coms harness and herdr presence reporting, so they continue to show agent state in the sidebar; Hermes' own herdr-agent-state plugin is responsible for the conductor pane's state.

### `/set-hermes-telegram` bridge control

The outbound `hermes send` path needs a configured Telegram channel but no skill. Full reply round-trip additionally needs Agent Fleet's `hub-liaison` skill in the profile that owns the running Telegram gateway. From Pi or Claude Code use:

```text
/set-hermes-telegram status --profile default
/set-hermes-telegram install --profile default
/set-hermes-telegram install --profile default --force --restart
/set-hermes-telegram on 7883056502:1735 --profile default
/set-hermes-telegram off 7883056502:1735
```

OpenCode exposes `/af-set-hermes-telegram`; the arguments and backend are identical. The deterministic CLI can also be called directly with `agent-fleet set-hermes-telegram ...`.

#### `status` and profile resolution

`status` is read-only. It verifies the Hermes executable/profile, compares the complete installed `hub-liaison` tree to the version packaged with Agent Fleet, asks Hermes whether the skill is enabled, checks `terminal` and `file` toolsets for the `telegram` platform, and reports gateway state. `--profile <name>` is recommended. Without it the controller selects a profile only when `hermes gateway list` reports exactly one running gateway; zero or multiple running gateways fail closed and require an explicit profile.

#### `install`

`install` writes to `<Hermes-profile-path>/skills/hub-liaison`, where the profile path comes from `hermes profile show <name>` (important because the `default` profile is normally `~/.hermes`, while named profiles normally live below `~/.hermes/profiles/`). Installation behavior is:

- missing skill: copied atomically from the packaged Agent Fleet source;
- byte-identical tree: no-op;
- differing tree: refused unless `--force` is explicit;
- forced replacement: the previous tree is moved first to `<profile>/backups/agent-fleet/hub-liaison-<timestamp>`;
- symlinks or unsupported filesystem entries in either skill tree are refused;
- the installed tree is fingerprinted again, then `hermes --profile <name> skills list --enabled-only` and `tools list --platform telegram` are run for verification.

The command does not silently broaden Telegram tool permissions. If `terminal` or `file` is disabled, it prints the explicit remediation:

```bash
hermes --profile <name> tools enable --platform telegram terminal file
```

If the skill itself is disabled, use `hermes --profile <name> skills config`. A running gateway is restarted only with explicit `--restart`; otherwise the command prints the required restart command. A stopped gateway is never started as a side effect. No install/status/on/off action sends a test Telegram message.

#### `on` and `off`

`on` fails before touching Herdr unless the selected gateway is running, `hub-liaison` is current and enabled, and both required Telegram toolsets are enabled. It then closes any existing pane labeled `hermes-bridge` in the current workspace, creates a new right-hand pane in that **same Herdr workspace**, labels it `hermes-bridge`, and starts the daemon with `telegram:<id>` as its exact target. The selected profile is forwarded as `--hermes-profile`, so every question, timeout, cancel, and late-answer send executes as `hermes --profile <name> send ...` rather than silently falling back to Hermes' sticky default. `off` remains available even when Hermes readiness is broken, closes the bridge pane, creates nothing, and is idempotent.

The Telegram destination must contain digits only (`<chat_id>`) or two digit groups separated by one colon (`<chat_id>:<topic_id>`). Values such as `telegram:123`, `123:`, `123:456:789`, spaces, signs, and letters are rejected. The controller infers the coms project independently from the current hub process's explicit `--project`, then `PI_COMS_PROJECT`, then `default`.

The manual equivalent is:

```bash
node --experimental-strip-types scripts/coms-hermes-bridge.ts \
  --project af \
  --hermes-profile default \
  --timeout 1800000 \
  --to 'telegram:<chat_id>:<thread_id>'
just hub-team docs --project af
```

Repeated value flags such as two `--to` arguments are rejected at startup rather than silently selecting one destination. The `ask-user-remote` wrapper resolves the explicit Pi `--project` flag when the tool executes, so non-default hubs discover `user-remote` in their own pool.

Hard boundary: the Hermes conductor must not run `herdr` commands, drive panes, create/kill workspaces, or manage fleet lifecycle. Herdr driving stays with the human/orchestrator so the damage-control model remains intact; see `.pi/damage-control-rules.yaml` for the authoritative no-herdr boundary. Hermes may only operate inside the project coms pool through the documented coms CLI commands.

## Hermes and the experimental Codex conductor

Hermes/Telegram remains the **inbound** human `ask_user` complement to the
experimental Codex remote-control conductor. Codex is outbound-initiated,
approval-gated, and serialized; it is not an inbound question channel. The Codex user service and control-pane lifecycle are
separate from Hermes. See the [experimental Codex operator runbook](codex-remote-conductor.md).

Both conductor contracts are advisory outside Pi damage-control: Pi wraps Pi
tool calls, not Hermes or Codex, and neither has an OS command allowlist.
Human confirmation, approvals, and sandboxing reduce risk but do not
technically enforce either external contract.

## Deferred

- Standing conductor peer for pi → Hermes inbound messages.
- Telegram-driven conductor profile.
- Group/multi-recipient questions and non-text answers.
- Kanban-driven orchestration on top of the same conductor contract.
