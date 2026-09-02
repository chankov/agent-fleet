---
"@chankov/agent-fleet": patch
---

Stop copying Agent Fleet product runbooks into target repositories. Keep the workflow guide and Codex conductor contract under the managed `.pi/agent-fleet/` runtime tree, and safely retire unchanged files from their former repository-root locations during setup.
