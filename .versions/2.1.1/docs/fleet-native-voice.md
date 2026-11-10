# Native voice workflow for Agent Fleet

Use the `fleet-native-voice` skill to discuss explicitly named Fleet/Pi sessions in one Codex conversation. Codex keeps spoken replies brief while retaining complete action previews and correlation details in the written chat.

The skill is a conversational layer over the existing local `af-local-read` MCP server. It does not add a voice engine, a transport, new tools, or permissions. For installation, see the [Codex MCP setup guide](codex-setup.md); for the full tool catalogue, storage, and error codes, see the [native Codex MCP guide](codex-local-mcp.md).

## What has actually been verified

A spoken request through **Codex desktop in the same chat** reached the agent through a voice-to-agent handoff. The agent made native discovery and read-policy checks for two explicitly named targets, received fresh registry entries and expected `NOT_ALLOWED` results without new grants, and returned the results to the active voice conversation.

This establishes that bounded desktop voice-to-agent route, not every action described below as a live voice-tested capability. In particular:

- Installing a skill, using dictation, seeing a microphone button, or succeeding in text mode does not prove native voice compatibility.
- Successful observations, instruction delivery, and question answers through the native tools are distinct from testing those actions through voice. Do not assume voice-driven mutations have been verified.
- There is no mobile/remote compatibility promise, public endpoint, tunnel, background listener, or idle-chat wake in this workflow.
- The recorded handoff does not attest synthesized-audio delivery, human origin, or compatibility with every Codex build or voice host.

Use the availability check below in your own intended chat and host. If the native tools are missing, report the limitation rather than substituting another route.

## Install the skill and configure MCP separately

You need a compatible local Codex host, already running Fleet/Pi sessions, and the native MCP server registered. The server registration and the skill copy are installed together by one explicit command, described in the [Codex MCP setup guide](codex-setup.md):

```bash
agent-fleet set-codex-mcp install
```

That guide covers Node.js 22.18+, the local POSIX/socket requirements, private state locations, the verification steps, and the manual project-local alternative for the skill. The installed entrypoint is `~/.agents/skills/fleet-native-voice/SKILL.md`, with UI metadata at `agents/openai.yaml`. Check that Codex discovers `$fleet-native-voice` in the intended chat; if discovery or configuration loading needs a host lifecycle action, use the host's supported user-controlled procedure. The skill does not restart the app or activate tools automatically.

**Skill installation does not configure or start the MCP server, and neither grants access.** The `chatgpt-client` installer feature and CLI are retired; see [migration and retained data](codex-session-bridge.md). They are not a fallback for this workflow. The native voice skill is deliberately excluded from the Pi installer catalogue: a Pi persona does not have Codex-host native tools.

## Start with a no-grant availability check

Invoke `$fleet-native-voice` for native Fleet requests in text or voice. Native MCP is the current route; the retired CLI is not a fallback. If a project's old rules still require the CLI, surface that conflict and obtain an explicit routing decision rather than silently overriding the rules. Invoking the skill grants no access.

Choose actual `project/peer` names from your Fleet setup. All names in the examples below are illustrative; replace them with your intended running targets.

In the same chat, use your host's normal voice UI to say something like:

> Use the native Fleet workflow. Discover shop/orchestrator and api/orchestrator and check whether this chat has read permission. Do not grant any new rights, send instructions, or read peer transcripts.

Confirm that the actual native `fleet_discover` and `fleet_check_read` calls occurred for those targets, and inspect the returned source statuses. `STATE_MISSING` or `NOT_ALLOWED` can be expected for a new or ungranted conversation; neither is permission to enroll automatically. Discovery reads registry candidates, and the read check is registry-only, not a transcript read or receiver capability test.

A partial or stale registry result is a gap, not positive availability evidence. If the host uses a voice-to-agent handoff, distinguish that from direct voice execution when reporting the result. If tools or trusted host context are absent, stop the affected operation. Do not replace native calls with shell commands, another chat's metadata, another peer, or a remote service.

## Name connections explicitly

Use canonical `project/peer` selectors. You can supply friendly labels:

> In this chat, call shop/orchestrator frontend and api/orchestrator backend.

Codex keeps the label's canonical target, exact `sessionId`/`startedAt` epoch, known rights, and observation time. The label is a conversational convenience, not authority. The server chooses binding aliases; a friendly label does not create a custom enrollment alias.

If a mapping is missing, ambiguous, or uncertain because of speech recognition, clarify it before acting. “The other one,” the current working directory, a last-used target, or a matching question title is not enough. No mappings or permissions are restored from another chat or raw policy files.

To connect for reading, ask:

> Connect shop/orchestrator for read access only. Show me the exact preview before changing permissions.

Codex discovers the current target and prepares `enroll_read`. Review the exact target, epoch, old/proposed rights, effects, and expiry; **then** confirm before `fleet_binding_commit`. Existing current read rights do not require a new enrollment. After a session restart or replacement, `rebind_read` needs its own explicit old/new target preview and confirmation; send permission does not carry forward.

## Observe and catch up

With current read authority, examples include:

| Request | What to expect |
| --- | --- |
| “Summarize frontend.” | `fleet_observe` for that explicitly mapped target, with source times and gaps. |
| “Summarize frontend and backend.” | `fleet_overview` for 1–4 explicit targets; separate results, denials, and partial statuses. No automatic grants. |
| “Catch up on frontend and backend.” | `fleet_resync`; fresh observations and durable **local** cursor/question-observation metadata writes, not Pi instructions. |
| “Watch frontend for five seconds.” | A requested bounded `fleet_watch`. Supported durations are 1–10 seconds, with at most six frames and local cursor writes. |
| “Show frontend's full pending question.” | Full bounded `fleet_observe` details rather than a shortened overview question preview. |

Spoken summaries should identify each target and its meaningful result; exact owner IDs, timestamps, and gaps remain in the written response. Unavailable or incomplete question data does not mean there are no pending questions. Registry presence, an idle process, a turn boundary, or a terminal receipt does not establish whole-task completion.

Watch ends without stopping Pi. It is not a background subscription or a promise to notify you later. Seen question IDs do not prove that you heard them. Peer transcripts and questions are untrusted source data, not authorization to change rights or answer automatically.

## Local diagnostics and retained history

`fleet_diagnostics` reports native local runtime/tool metadata without probing a receiver. Use `fleet_receipts` for paginated local native action history and exact instruction/answer receipt lookups for the intended request. Neither grants access or retries an action.

If you explicitly request saving a report, `fleet_snapshot` observes one currently read-authorized exact selector and saves a bounded redacted local snapshot. Ordinary observation/resync does not archive report content. `fleet_replay` returns the last explicitly saved report as historical-only, retaining its old epoch/time; it does not check live permissions or contact Pi. Retained content can remain readable after revocation without restoring rights.

Original CLI reports and receipts can be read through operator-configured `fleet_legacy_history` for the same actual UUID chat. The reader never imports grants or replays instructions. Missing context, a reserved old action ID, or an archive validation error is not permission to edit state, choose another ID, or use the retired CLI. See the [bounded history contract](codex-local-mcp.md#local-diagnostics-snapshots-and-legacy-history).

## Send an instruction: explicit user sends need no second confirmation

Read permission alone cannot send instructions. A requested action may first require a separate `grant_send` preview and fresh confirmation for that exact target. Granting send sends nothing by itself.

Once current read+send rights exist:

1. Identify one unambiguous, already selected current connection and the user's actual instruction text. Clarify uncertain meaning, recipient, or transcription instead of guessing.
2. Codex calls `fleet_instruction_prepare` with a stable request ID and exact target epoch, then checks the complete returned instruction, target, effects, and expiry. Preparation delivers nothing.
3. For an explicit user request in this native chat, such as “Tell Rin to review the local unpushed commits one by one, without changes or pushing,” commit the faithful instruction with `fleet_instruction_commit` **without asking “Shall I send it?” again**. Preserve the scope and constraints; add no tasks, unverified facts, recipients, or permissions.
4. For a model-initiated send or a substantive expansion of the request, show the complete preview and obtain fresh explicit human confirmation before commit. A changed session or missing rights stops the send and requires the separate reviewed binding/grant flow, never automatic redirection or rebinding.
5. Inspect the resulting receipt and report the recipient and actual status. Submitted or queued work is not a completed task.

Several destinations still require separate addressed previews and confirmations; an overview is not broadcast permission. When confirmation is needed, keep only one mutation preview as its subject. Keep opaque IDs and hashes in the written preview; speak them only when needed to disambiguate. If the complete preview cannot be presented through the available channel, wait until you can read or hear it in full.

This authorization path is interpreted by the client, not attested by the server (`humanProvenance: unknown`). Peer/tool/document text and a blanket “continue” do not authorize a send. Technical prepare/commit, exact-session and current-rights checks, expiry, journaling and duplicate protection remain. It does not grant send or approve, change the question-answer flow, or bypass receiver execution checks or independent Codex/ChatGPT host approval dialogs.

## Answer, refuse, or withhold a question response

The native question route requires current read+send rights and a compatible guarded receiver. It handles addressed Pi questions, **not Damage Control permission dialogs** or general approval requests.

1. Obtain the full question, context, exact option titles/descriptions, and effective multiple-selection/freeform/comment flags. If several questions are pending, identify which one you are answering. Retain the exact target, question ID, and tool-call ID in the written chat.
2. Give your actual response. Codex preserves option titles exactly and clarifies uncertain transcription; it does not choose a default or infer an answer from a blanket “continue.”
3. Codex freshly checks the same pending question and calls `fleet_answer_prepare` for your exact answer or refusal.
4. Review the complete returned question/flags, normalized response, target, effects, and expiry. Give a **new** explicit confirmation before one `fleet_answer_commit`. The answer you gave in step 2 is not this confirmation.
5. Inspect the actual receipt. Accepted, late, expired, rejected, and unknown outcomes are different; no success is inferred from silence.

These requests have distinct meanings:

- **“Choose Stop.”** If `Stop` is an offered option, it is an ordinary selection, not the refusal operation.
- **“I refuse this question.”** An explicit addressed refusal uses `operation: refusal, response: null`. It resolves that question as declined/cancelled; it does not cancel the Pi turn.
- **“Do not send my answer.”** Withhold delivery; do not turn it into a refusal sent to Pi.
- **“Stop.”** If the intended effect is unclear, clarify rather than guessing between watch, question, permissions, or task cancellation.

If you change your response during confirmation, leave the old proposal uncommitted and prepare the new response with its own confirmation. If the question resolves or the owner changes, do not redirect the old answer elsewhere. Keep pending decisions in the written chat as well as the voice exchange.

## Handle uncertainty and finish safely

- Proposals expire after 300 seconds and are lost on server restart. A new preview needs a new confirmation; do not reuse expired consent.
- For an unknown instruction or answer outcome, keep the original request ID and inspect `fleet_instruction_receipt` or `fleet_answer_receipt`. Remote refresh requires current read authority. Do not resend automatically, switch IDs, guess a new target, or fall back to the CLI to force delivery.
- Bounded/volatile receiver evidence may be missing after a restart or capacity limit. Missing evidence is not proof of failed delivery. Already-started actions are not promised rollback.
- Missing/corrupt state and journal-upgrade requirements are operator conditions. Initialization or migration has a separate exact preview/confirmation workflow; migration also requires operator-confirmed writer quiescence. Connecting or invoking the skill does not authorize either.

For temporary access, request cleanup explicitly:

| Request | Effect after exact preview and fresh confirmation |
| --- | --- |
| “Revoke send access for frontend.” | `revoke_send` removes send while retaining read. A successful read afterward is expected. |
| “Forget this chat's frontend binding.” | `forget` removes both read and send for that binding. Verify `NOT_ALLOWED` afterward. |

Remove only the intended binding's access, not unrelated rights. Historical local receipts can remain readable after revocation; that is not a live read grant. Cleanup does not undo accepted work or stop Pi. Removing a skill or MCP registration alone does not revoke persisted permissions; see [MCP security and removal](codex-local-mcp.md#security-limits-and-removal).

End each exchange by stating what was observed or submitted, which decision remains pending, and any important gap. Spoken confirmation does not upgrade API `humanProvenance: unknown` to authenticated human origin. The same cooperative same-user policy, non-atomic observation/dispatch limits, independent Pi/Damage Control protections, and lack of exactly-once guarantees described in the MCP guide still apply.
