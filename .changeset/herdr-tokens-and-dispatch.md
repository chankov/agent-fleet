---
"@chankov/agent-fleet": minor
---

Fix herdr presence against herdr 0.7.4+ and let the Agent Fleet panel dispatch prompts.

herdr 0.7.4 removed `custom_status` from `pane.report_metadata`, so every presence report had been failing silently — `HerdrPresence.report()` swallows errors — leaving every pane unannotated and every fleet view stuck on `detached`/`unknown`. Presence now writes herdr's `tokens` (`coms`, `proj`, `ctx`, `q`), negotiating the dialect by trying and latching rather than version sniffing, with an `onError` hook that both harnesses log to `coms-log` as `presence_dialect_rejected`.

The Claude Code bridge (`scripts/coms-claude-bridge.ts`) had its own second copy of the annotation call and stayed on the removed `custom_status` field, so every bridged Claude peer read `detached` no matter what it was doing. It now goes through the shared `HerdrPresence.annotate()` — annotation only, never `pane.report_agent`, since the bridge polls that same `agent_status` back as its turn-completion signal.

Because tokens carry the coms project, the `agent-fleet-herdr` join key is now `(project, name)` instead of `name` — two projects each running an `orchestrator` resolve to their own panes instead of both collapsing to `unknown`. A missing pane is reported as `detached`; `unknown` is now reserved for genuinely competing evidence.

The panel gained an ask box: `POST /sessions/{project}/{name}/prompt` hands a coms prompt envelope to a live peer and shows the answer when it lands. The renderer names `(project, name)` only — the socket path is resolved server-side from a freshly re-read registry, so no endpoint reaches a file running with the app's full privileges.
