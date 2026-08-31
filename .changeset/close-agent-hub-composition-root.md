---
"@chankov/agent-fleet": patch
---

Extract Agent Hub configuration and full session lifecycle orchestration so index.ts is a bounded composition root while preserving startup and shutdown order.

Closeout measurements:
- `wc -l .pi/harnesses/agent-hub/index.ts` → 1,850 lines.
- Unicode character count (`len(Path(...).read_text())`) → 99,182 characters; plan estimate `/ 4` → 24,795.5 tokens.
- Phase 6 production modules remain below 600 lines and extracted functions below 200 lines; registration remains 16 tools / 21 commands / 8 flags.
