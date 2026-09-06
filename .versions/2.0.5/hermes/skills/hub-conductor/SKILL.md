---
name: hub-conductor
description: Conducts local pi hub-team peers from Hermes through coms-cli list/send --await, while preserving no-herdr and pool-scope damage-control boundaries.
---

# Hub Conductor

## Overview

You are the human-facing conductor for a local pi coms pool. Your job is to decompose the human's request, discover live hub-team peers, delegate bounded tasks through `scripts/coms-cli.ts`, wait for results, and synthesize a final answer.

This is conductor-side orchestration only: the existing coms CLI is the bridge. You do not need a daemon or standing Hermes peer to ask pi peers for work.

## When to Use

Use this skill when:

- the human asks Hermes to coordinate pi hub-team peers;
- a task benefits from parallel specialist work such as research, implementation, docs, review, or testing;
- you need to inspect which local peers are alive before deciding who should do what;
- a previous peer response needs follow-up, retry, or synthesis.

Do not use it for single-step work Hermes can safely complete alone without peer help.

## Process

1. Identify the repository root and set a shell variable for it when useful:

```bash
REPO=/home/nchankov/repos/agent-fleet
```

2. Discover live peers in the current coms project:

```bash
node --experimental-strip-types "$REPO/scripts/coms-cli.ts" list
```

Use `--project <name>` when the human or launch recipe specifies a non-default project.

3. Choose peers by their listed name and purpose. Send bounded, self-contained prompts that include the expected deliverable and any acceptance assertions the peer must prove.

4. Delegate with an explicit timeout and wait for the response:

```bash
node --experimental-strip-types "$REPO/scripts/coms-cli.ts" send <peer-name> \
  "<bounded task; include required output and evidence>" \
  --await --timeout 300000
```

Use a longer timeout for build/test/review tasks when needed. Every `send --await` must include `--timeout <ms>`.

5. If a peer times out or is missing, retry at most once when the task still matters. Otherwise report that peer as unavailable and continue with the best available evidence.

6. Synthesize peer outputs for the human. Name which peers were asked, what each returned, what evidence supports the result, and what remains unproven.

7. For inbound conversational requests, answer directly in chat after any peer delegation; keep the final response self-contained because the human sees your synthesis, not the peer transcript.

## Hard Boundaries

- **Advisory contract only.** This skill runs in an external Hermes process. Pi damage-control wraps Pi tool calls, not Hermes; this contract and any human confirmation reduce risk but do not provide an OS command allowlist or technical enforcement.
- **No herdr driving.** Do not run `herdr pane`, `herdr workspace`, pane lifecycle commands, workspace lifecycle commands, or any command that creates, closes, restarts, or drives panes. Rationale: fleet lifecycle belongs to the human/orchestrator so the `.pi/damage-control-rules.yaml` model remains intact and Hermes cannot accidentally destroy or commandeer active work.
- **Pool scope only.** Operate only through peers visible in the current project coms pool (`coms-cli list`, then `coms-cli send ... --await`). Do not widen to unrelated projects, global registries, hidden explicit peers, or external agent pools unless the human explicitly starts that topology and names the target project. Rationale: coms pool boundaries keep delegation auditable and prevent cross-project leakage.
- **No secret or bulk-data relay.** Send bounded prompts and path references, not secrets or whole-file dumps. Rationale: peers need task context, not uncontrolled data replication.

## Red Flags

- Running or proposing `herdr` pane/workspace commands yourself.
- Sending to a peer that was not shown by `coms-cli list` for the intended project.
- Omitting `--await` or `--timeout` for delegated work that the human expects you to synthesize.
- Retrying repeatedly after a timeout instead of one retry then reporting the gap.
- Treating a peer's prose success claim as proof when it lacks named evidence.
- Expanding beyond the repository/project pool without explicit human direction.

## Verification

Before reporting done, check:

- [ ] `coms-cli list` was run for the intended project and the selected peers were visible.
- [ ] Every delegated task used `coms-cli send <peer> ... --await --timeout <ms>`.
- [ ] Peer responses were synthesized with named evidence and unresolved gaps.
- [ ] At most one retry was used for any timeout or missing peer.
- [ ] No `herdr` command was run or requested by Hermes.
- [ ] No delegation crossed outside the intended project coms pool.
