---
"@chankov/agent-fleet": patch
---

Add explicit Fleet client question listing, addressed answers and cancellation for compatible Pi ask-user wrappers. Validate question flags and session ownership in Pi, arbitrate local/Hermes/client answers with one latch, and reject late or stale submissions. Persist client receipts before sending and recover lost acceptance only from the matching Pi question and wire request ID. Include bounded question pagination, session lifecycle handling, CLI/skill documentation and isolated socket integration coverage.

Discover pending questions automatically in status, summary, activity, resync and bounded watch. Keep question availability separate from transcript evidence, preserve per-chat observation state and relay only explicit human answers after a fresh identity check.

Add a versioned machine-readable operation catalog shared by `--help` and CLI argument validation. The new `describe` command checks current per-operation prerequisites using read-only source, question-protocol and visible-Pi/ping probes, with explicit unavailable/unsupported reasons. It does not submit prompts, answer questions or update client state.

Share question state across Pi's independently loaded extensions. Restart an existing Pi process to activate updated native JavaScript race code; `/reload` may retain the previous Node ESM cache. Resume the exact saved Pi conversation and explicitly reselect its new owner. Android's supported question route is ordinary chat text; native mobile dialog rendering is not guaranteed.

Refresh locked transitive dependencies `fast-uri` to 3.1.7 and `qs` to 6.16.0 to address the URI normalization/host-confusion and query-parser advisories found during release preparation. Direct dependency ranges are unchanged.
