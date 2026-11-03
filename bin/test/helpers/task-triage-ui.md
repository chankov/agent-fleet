# Human UI verification — System 1 task triage

**Status:** T6 cases 1–5 were personally confirmed in the conversation and C3 was independently accepted; this checklist remains repeatable and does not automatically record new observations. **The new exact-action UI test was personally performed and approved according to the user's confirmation; the post-fix C4 review is still open and the original BLOCK remains preserved.** The user gave overall approval of the presented test, not a detailed case-by-case report, screenshots, or terminal information. Passing tests, a PTY smoke test, or opening the window do not constitute human approval.

All cases launch the actual production Hub from the checkout, but in a new temporary workspace with a fake Jev transport and a fixed synthetic Pi provider. No data is sent to APIs and no real keys are inherited. There is no real model or automatic human response. Cases 1–5 execute no tools; only case 6 proposes the exact fixed synthetic bash/write/edit requests below. Do not enter real tasks, @files, shell commands, or other Hub execution commands in these sessions.

## Launch

From the agent-fleet root:

```bash
node bin/test/helpers/task-triage-ui.mjs applied --keep
```

Replace `applied` with `waived`, `timeout`, `oversized`, `stale`, or `action` for the next case. Each launch creates a new session/workspace. `--keep` preserves only synthetic records after `/quit`; the launcher displays the directory. Without `--keep`, it is removed on exit. This does not run setup or change the current repository workspace.

**Common actions:** `/af-agents-list` opens Fleet. `1` opens the communication viewer. `e` enables session-only capture; `d` disables and clears it. `Esc` returns to Fleet; `q` closes Fleet. `/af-audit` displays metadata JSON. `/quit` exits.

## 1. Applied and capture

1. Open `/af-agents-list`, press `1`: verify **capture OFF** and no restored payloads.
2. Press `e`, then `Esc`, `q`.
3. Run `/triage-ui-fill applied`. It only places text in the editor. Press **Enter** to submit.
4. Open `/af-agents-list`: check `experimental`, `applied`, `current`, security probability, an active addition, and an open review. There are no worker rows or green task acceptance.
5. Press `1`, select a record, and press Enter. Check the request/response, probabilities, and warning that a provider result is not task acceptance.
6. Try the arrow keys, Enter to copy, and `d` to clear. The clipboard is not cleared automatically: use synthetic data only. After clearing, no payload remains to copy again.
7. Narrow the terminal to about 40 columns, then widen it. Nothing should extend beyond the viewport; some metadata is clipped on a narrow screen, with details available in `/af-audit`.

## 2. Waived

1. Launch `waived --keep`, run `/triage-ui-fill applied`, and press Enter.
2. Run `/triage-ui-waiver`. It only prepares the actual `/af-task-triage-waive …` command.
3. Press Enter; review the question. Choose **Yes — authorize once** only for this synthetic addition.
4. In Fleet and `/af-audit`: the source addition and review are `waived`, not `satisfied`. Baseline acceptance remains open. There is no automatic task acceptance or budget change.

## 3. Timeout

1. Launch `timeout --keep`, run `/triage-ui-fill timeout`, and press Enter.
2. After the bounded timeout, open Fleet and audit. The status is `unavailable`, with no new additions. Attempts/usage are not fabricated as a known zero. There is no endless retry.
3. If you enable capture before submitting, the viewer shows a failed/unavailable result, not success.

## 4. Oversized and viewer withholding

1. Launch `oversized --keep`, run `/triage-ui-fill oversized`, and press Enter. The editor contains 40961 ASCII bytes.
2. Fleet/audit show `oversized_input`, zero new provider calls, and no additions. The viewer has no request that was never sent.
3. For the separate viewer boundary: enable capture through Fleet → `1` → `e`, then return with `Esc`, `q`.
4. `/triage-ui-fill viewer-withheld`, Enter: the 33792-byte task is valid for the consumer but exceeds the viewer payload limit.
5. In the viewer, the request shows `payload withheld or too large`, not truncation or restored content. Copy request copies nothing; the small response remains separately available.

## 5. Stale/pending

1. Launch `stale --keep`, run `/triage-ui-fill applied`, and press Enter.
2. Then run `/triage-ui-fill stale`, Enter.
3. Fleet/audit: the new input does not release old obligations; the old addition is `stale` and `task_transition_pending` is a blocker. Process completion is unknown, not accepted.
4. Do not use reset/waiver for this test; the goal is the visible pending fence.

## 6. New exact-action prompt — separate C4 human observation

```bash
node bin/test/helpers/task-triage-ui.mjs action --keep
```

1. Run `/triage-ui-fill action`, then **Enter**. The command itself only places the reviewed synthetic text in the editor. Do not submit real tasks or use waiver/reset for this case.
2. You will receive four **separate production questions**. Before choosing, check `Operation`, the `Target` hash, a distinct `Action` ID, `Working directory (JSON)` containing the temporary workspace, and the **entire** content between `BEGIN ACTION INPUT JSON` and `END ACTION INPUT JSON`. Do not consider a hash or partial preview sufficient detail. If you cannot read everything, choose **No — deny** and report BLOCK.
3. Details and expected human decisions:

| Question | Full synthetic inputs | Decision only after review |
|---|---|---|
| bash | `command: "printf 'synthetic bash preview\\n'"`, `timeout: 5` | Yes — authorize once |
| write | `path: "action-write.txt"`; `content: "synthetic write line 1\nsynthetic write line 2\n"` | Yes — authorize once |
| edit | `path: "action-edit.txt"`; **two** `edits`: `alpha-before` → `alpha-after`, `beta-before` → `beta-after` | Yes — authorize once |
| subsequent separate write | `path: "action-denied.txt"`; `content: "later action needs its own decision"` | **No — deny** |

4. `1`/`2` selects Yes/No; **Enter** confirms. Do not press Enter blindly. Use **PgUp/PgDn** for the prompt. If context is collapsed, follow the displayed `expand context` shortcut. Narrow the terminal for the edit question (for example, to 48 columns), inspect both replacements and the final JSON boundary, then widen it. Returning to a wide screen does not itself grant permission. **Esc** cancels the question.
5. After the fourth question come two automatically refused write requests: `action-sensitive.txt` with the fixed **fake** `password=synthetic-only-action-sentinel` and `action-large.txt` with 20000 `x` characters. They must not open a Yes/No prompt or create a file; Pi may display the request in the standard tool transcript, which is separate from the metadata audit. This personal test scenario has no ESC-control payload to avoid disrupting the terminal renderer; control refusal is checked separately in automated authority/RPC tests.
6. Wait for `Fixed action sequence finished`. `/triage-ui-action-status` should show `write: exact expected bytes`, `edit: exact expected bytes`, and `denied`, `sensitive`, `large`: `missing`. Status is a read-only check of the fixed temporary files; it is **not** a human or independent verdict. If you deny/cancel any of the first three actions, its expected bytes will naturally be absent — record your choice.
7. `/af-audit`: separate grant/consumption/result facts; subsequent effects still require confirmation. There is no semantic task acceptance. Action metadata must not contain content or raw paths; the ordinary Pi transcript has a different privacy boundary.
8. `/quit` exits. `--keep` preserves synthetic files/records in the **actually displayed** directory; the fixture uses `--no-session` and does not promise a persistent Pi transcript or screenshot. Do not share other terminal tabs/credentials.

This is a local-only **test fixture** with isolated HOME/agent settings and a no-network guard. Production confirmation is not promised to be local-only: the existing configured ask-user local/remote **human** channel may receive exact command/path/content details. 8 KiB is the cap on the complete action detail block, not a guarantee of readability in every terminal or remote renderer. Missing/unsafe/oversized inputs refuse a grant **without truncation or partial redaction**. Sensitive-data detection is heuristic, not a complete guarantee.

## Recording human observation

Complete this in the response or a separate review artifact:

| Case | Personally observed? | PASS / BLOCK / UNVERIFIED | Notes / record |
|---|---|---|---|
| Applied / capture / copy / clear | | | |
| Waived | | | |
| Timeout | | | |
| Oversized / viewer withholding | | | |
| Stale / pending | | | |
| Narrow and wide terminal | | | |
| **New C4:** bash command/timeout + cwd | | | |
| **New C4:** write path/full content + cwd | | | |
| **New C4:** edit path/both replacements + narrow/wide + JSON end | | | |
| **New C4:** separate No, sensitive/oversized refusal, and file status | | | |

If available, specify the OS/terminal, verified revision, and actual directories preserved by the launcher. Do not invent missing metadata, timestamps, or screenshots. Screenshots/terminal recordings must contain only synthetic fixture data, not other terminal tabs/credentials. Publishing clipboard contents or raw payloads is not required. If not personally observed, record **UNVERIFIED**, not PASS.

This verification does not prove live Jev accuracy, calibration, independent A1 review, universal remote effect coverage, or release readiness. For new case 6, a separately authorized post-fix C4 review and final maintainer technical acceptance remain after personal human confirmation. This checklist does not change the old C4 BLOCK.
