---
"@chankov/agent-skills": minor
---

Add a `deep-researcher` research persona (`gpt-5.5` / xhigh) alongside the existing `researcher` (`gpt-5.3-codex-spark`), so the agent-hub orchestrator routes read-only reconnaissance by difficulty: the light persona for simple reads, the deep persona for ambiguous, cross-cutting, or high-stakes investigation. The orchestrator's research-persona catalog now shows each persona's model and thinking level, and both orchestrator personas were rewritten to pick the right research tier — and to escalate non-research complexity by dispatching the right specialist, since `dispatch_agent` takes no model argument.
