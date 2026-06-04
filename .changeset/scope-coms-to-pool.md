---
"@chankov/agent-skills": patch
---

**agent-hub / coms:** scope coms reachability to the connected pool, closing a cross-project leak.

A peer that was reachable through the coms mesh but **not** shown in the default project-scoped pool widget could still be messaged — so an agent could talk to a peer it was never "connected" to (and, with `--explicit`, one deliberately kept private). `resolveTarget` matched a peer name by scanning *every* project and never checked the explicit flag, so the send scope was wider than the display scope.

Both `agent-hub` (embedded coms) and the standalone `coms` harness now treat the pool widget as the security boundary: `coms_list`, `coms_send`, and `/handoff` all resolve targets through one `peersInScope()` helper, so the reachable set is always a subset of what the widget shows. The two scope knobs — project (default: your own) and explicit-peer visibility (default: hidden) — are **human-only**: only `/coms --project <name>` / `/coms --all` can widen them. `coms_list`'s own `project` / `include_explicit` parameters may *narrow* within the human-set scope but can never widen it; a widening request is ignored and flagged with a notice instead of silently honored.

Out-of-pool `coms_send` / `/handoff` is refused with a message pointing at the human-controlled widening path — without confirming whether the peer exists elsewhere, since that existence is itself cross-project metadata. Tool descriptions and the dispatcher system prompt now teach the LLM that it can reach only pool peers and must ask the human to widen scope rather than attempt it, and not to pass cross-project context to a peer the human has not approved. `--explicit` peers are kept out of every pool until `/coms --all`.
