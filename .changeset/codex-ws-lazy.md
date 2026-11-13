---
"@chankov/agent-fleet": patch
---

The Hub loads again in a workspace whose dependencies do not include `ws`, such as a workspace with Fleet copied into it. The Codex notification bootstrap loaded `ws` as soon as the Hub started, so `agent-hub` failed with "Cannot find module 'ws'" before any Codex feature was used. `ws` now loads on the first Codex daemon connection.
