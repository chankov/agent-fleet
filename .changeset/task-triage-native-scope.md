---
"@chankov/agent-fleet": patch
---

Fix unnecessary `/af-task-triage-recover` requests for native Fleet tasks:

- Permit initial read-only classification and a read-only-to-edit scope change
  after reload when no interactive triage input exists.
- Preserve baseline requirements, persisted review and exact-action confirmation
  obligations, and refusal on missing pending input or actual persistence failures.
- Report a post-commit process block instead of successful task classification.
- Include the connection-history runtime dependency in workspace installations
  so the installed Hub can load the existing connection diagnostics.

Existing workspaces must update their installed Fleet runtime and reload Pi to
use the fix; updating the package alone does not replace a running harness.
