---
name: hub-liaison
description: On any Telegram HUB-Q reply ALWAYS write the pi hub bridge answer file — even when the thread shows cancel/closed/timeout notes; the bridge classifies late answers itself. Use when a Telegram message replies to or contains a [HUB-Q:<qid>] marker.
---

# Hub Liaison

## Overview

You are the gateway-side liaison between a human Telegram reply and the pi `user-remote` coms peer. When a Telegram message correlates to a hub question marker, write one answer file for the bridge. Do not answer by paraphrasing in chat only; the bridge only consumes the file.

## When to Use

Use this skill when an incoming Telegram message either:

- replies to a message that contains `[HUB-Q:<qid>]`, or
- contains the explicit prefix `HUB-Q:<qid>:`.

`<qid>` must be a 26-character Crockford ULID matching:

```text
^[0-9A-HJKMNP-TV-Z]{26}$
```

Ignore non-matching messages. If a message is ambiguous and there is more than one plausible question marker, ask the human to reply to the original question or use `HUB-Q:<qid>: <answer>`.

## Correlation Rules

1. Prefer the qid from the replied-to message marker: `[HUB-Q:<qid>]`.
2. If there is no replied-to marker, accept a message prefix exactly shaped as `HUB-Q:<qid>: <answer>`.
3. The answer text is the Telegram reply body, except for prefix-form messages where the answer text is everything after `HUB-Q:<qid>:`.
4. Preserve the human's answer text exactly except for trimming leading/trailing whitespace around the extracted answer.
5. Never invent or alter the qid. If the qid does not match the regex above, do not write a file.
6. If a human message contains or replies to a `[HUB-Q:<qid>]` question, write the answer file even when the thread also contains a cancel/closed note or the user appears to be answering after cancellation. Do not decide whether the question is still open; the bridge validates pending vs. late and sends the appropriate polite closed note.

## Process

1. Extract `<qid>` and `<answer>` using the correlation rules.
2. Confirm `<answer>` is non-empty. If it is empty, ask the human for the answer text.
3. Do not suppress the write because the question appears canceled, closed, timed out, or answered locally. That state belongs to the bridge, not this skill.
4. Write exactly this file path, replacing `<qid>` with the extracted qid:

```text
~/.pi/coms/hermes-bridge/questions/<qid>.answer.json
```

5. The JSON content must use exactly these fields:

```json
{
  "qid": "<qid>",
  "answer": "<answer>",
  "answered_by": "telegram:<user>",
  "at": "<ISO timestamp>"
}
```

- `qid`: the extracted 26-character qid.
- `answer`: the extracted answer text.
- `answered_by`: `telegram:<user>`, using the Telegram username/handle when available; otherwise use a stable Telegram sender identifier.
- `at`: the current ISO-8601 timestamp.

6. After writing the file, briefly confirm to the human that the answer was delivered for `HUB-Q:<qid>`; if it was late, the bridge will handle the closed-question response.

## Write Boundary

Hard rule: never write outside `~/.pi/coms/hermes-bridge/questions/` for this skill. Do not create, edit, or delete files elsewhere. The bridge validates and consumes only `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json`; any other path is outside the private wire contract.

## Red Flags

- A message has no `[HUB-Q:<qid>]` marker and no `HUB-Q:<qid>:` prefix.
- The qid fails `^[0-9A-HJKMNP-TV-Z]{26}$`.
- The answer text is empty after extraction.
- The requested write path is not under `~/.pi/coms/hermes-bridge/questions/`.
- The human asks you to modify bridge logs, registry files, or any unrelated project files.
- Suppressing an otherwise correlated answer because a cancel/closed note is visible in the thread.

## Verification

- [ ] The qid came from `[HUB-Q:<qid>]` or `HUB-Q:<qid>:` and matches the regex.
- [ ] The answer file path is exactly `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json`.
- [ ] The JSON has exactly `qid`, `answer`, `answered_by`, and `at` with an ISO timestamp.
- [ ] No file outside `~/.pi/coms/hermes-bridge/questions/` was written.
- [ ] Correlated late/canceled answers were still written for the bridge to classify.
