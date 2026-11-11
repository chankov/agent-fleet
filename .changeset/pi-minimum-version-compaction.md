---
"@chankov/agent-fleet": patch
---

Fix automatic compact-and-continue being disabled on newer Pi releases. The context-continuity gate was an exact list of Pi versions (1.1.0–1.3.0), so Pi 1.4+ fell back to a hard stop at the context limit. It is now a minimum version (1.1.0): later Pi releases work without a new Agent Fleet package.
