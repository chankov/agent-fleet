---
description: Conduct a five-axis code review - correctness, readability, architecture, security, performance
---

Invoke the `code-review-and-quality` skill via the `skill` tool.

Review the current changes, staged changes, or scope specified in `$ARGUMENTS` across these axes:

1. Correctness: Does it match the spec? Are edge cases handled? Are tests adequate?
2. Readability: Are names clear? Is the logic straightforward and well organized?
3. Architecture: Does it follow existing patterns? Are boundaries clean? Is the abstraction level right?
4. Security: Is input validated? Are secrets safe? Is authorization checked? Invoke `security-and-hardening` via the `skill` tool when relevant.
5. Performance: Are there N+1 queries, unbounded operations, or avoidable frontend regressions? Invoke `performance-optimization` via the `skill` tool when relevant.

Categorize findings as Critical, Important, or Suggestion. Output a structured review with specific file and line references plus fix recommendations.
