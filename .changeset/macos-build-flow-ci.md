---
"@chankov/agent-fleet": patch
---

Give the full nested-repository build-flow CI fixture a bounded integration
timeout and report subprocess errors and signals before checking acceptance.
This avoids premature termination on slower macOS runners without changing
production deadlines or weakening flow acceptance checks.
