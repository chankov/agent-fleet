---
"@chankov/agent-fleet": patch
---

Refresh shipped model defaults: `openai-codex/gpt-6-astra` → `gpt-6.2-astra`, `openai-codex/gpt-6.1-sol` → `gpt-6.2-sol`, and Anthropic models now route directly through the `anthropic` provider instead of GitHub Copilot, on current versions (`anthropic/claude-opus-5-5`, `anthropic/claude-fable-5-2`, `anthropic/claude-sonnet-5-5`, `anthropic/claude-haiku-5-5`) across personas, model profiles, peers, voices, and docs.
