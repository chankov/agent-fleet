---
description: Conduct a five-axis code review - correctness, readability, architecture, security, performance
---

Use the `code-review-and-quality` skill.

Review the current changes, staged changes, or scope specified in `$ARGUMENTS` across these axes:

1. Correctness: Does it match the spec? Are edge cases handled? Are tests adequate?
2. Readability: Are names clear? Is the logic straightforward and well organized?
3. Architecture: Does it follow existing patterns? Are boundaries clean? Is the abstraction level right?
4. Security: Is input validated? Are secrets safe? Is authorization checked? Use `security-and-hardening` when relevant.
5. Performance: Are there N+1 queries, unbounded operations, or avoidable frontend regressions? Use `performance-optimization` when relevant.

Categorize findings as Critical, Important, or Suggestion. Output a structured review with specific file and line references plus fix recommendations.
