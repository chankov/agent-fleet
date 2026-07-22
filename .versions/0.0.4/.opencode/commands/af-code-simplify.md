---
description: Simplify code for clarity and maintainability without changing behavior
---

Invoke the `code-simplification` skill via the `skill` tool.

Simplify recently changed code, or the scope specified in `$ARGUMENTS`, while preserving exact behavior:

1. Read the project's agent instructions and study project conventions.
2. Identify the target code: recent changes unless a broader scope is specified.
3. Understand the code's purpose, callers, edge cases, and test coverage before touching it.
4. Scan for simplification opportunities: deep nesting, long functions, nested ternaries, generic names, duplicated logic, or dead code.
5. Apply each simplification incrementally and run relevant tests after each change.
6. Verify tests pass, the build succeeds, and the diff is clean.

If tests fail after a simplification, revert only that simplification and reconsider. Invoke `code-review-and-quality` via the `skill` tool to review the result.
