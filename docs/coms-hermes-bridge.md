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
2. The bridge derives `qid` from `prompt.msg_id`, formats the question, and runs `hermes send --to <target> <message>` (`<target>` defaults to `telegram`).
3. The human replies in Telegram; the Hermes gateway/liaison writes the answer file.
4. The bridge polls the questions directory, validates the file, maps the answer, sends a coms `response` envelope, and removes the answer file.

## Protocol contract v1

### qid and correlation

`qid` is exactly the prompt envelope's `msg_id`. It must match the 26-character Crockford ULID regex `^[0-9A-HJKMNP-TV-Z]{26}$`. The same `qid` is the only correlation key across coms, Telegram, answer files, state, and logs.

### Telegram question format

`formatTelegramQuestion` emits UTF-16 text capped at 4096 code units:

```text
❓ [HUB-Q:<qid>] <question>

Контекст: <context, truncated if needed>

Опции:
1. <title> — <description>
...

↩ Отговори с reply на това съобщение, или напиши: HUB-Q:<qid>: <отговор>
```

`Контекст:` is omitted when absent. `Опции:` is omitted when no options are supplied. Context receives the remaining budget after the header, options, and reply instruction.

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

For a pending qid, cancel clears the timeout, removes the pending question, records terminal state `cancelled`, appends a `cancelled` log event, and sends a Telegram note: `✖ [HUB-Q:<qid>] Въпросът е отменен — отговорено е от конзолата.` Cancel for a non-pending or invalid qid is a no-op after the envelope ack. A later answer file for a closed qid is treated as `late_answer`: logged, removed, and answered in Telegram with a polite ignored note; no response envelope is sent.

### Timeouts

The per-question remote timeout defaults to `PI_COMS_TIMEOUT_MS`, or `1800000` ms when unset/invalid; `--timeout <ms>` overrides it. On timeout, the bridge removes the pending question, records terminal state `timeout`, logs `timeout`, sends the Telegram note `⌛ [HUB-Q:<qid>] Въпросът изтече след <ms>ms.`, and sends an error response envelope with error `no remote answer within <ms>ms` and `response: null`.

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

The live recipe reuses `scripts/team-up.ts --conductor`: it creates a normal herdr workspace labeled `pi-conductor-<team>`, places a `conductor` pane running `hermes -p dev`, and tiles the chosen team beside it. Team peers keep their normal coms harness and herdr presence reporting, so they continue to show agent state in the sidebar; Hermes' own herdr-agent-state plugin is responsible for the conductor pane's state.

Hard boundary: the Hermes conductor must not run `herdr` commands, drive panes, create/kill workspaces, or manage fleet lifecycle. Herdr driving stays with the human/orchestrator so the damage-control model remains intact; see `.pi/damage-control-rules.yaml` for the authoritative no-herdr boundary. Hermes may only operate inside the project coms pool through the documented coms CLI commands.

## Deferred

- Standing conductor peer for pi → Hermes inbound messages.
- Telegram-driven conductor profile.
- Group/multi-recipient questions and non-text answers.
- Kanban-driven orchestration on top of the same conductor contract.
