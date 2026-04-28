---
description: Run a TDD workflow - write failing tests, implement, verify
---

Invoke the `test-driven-development` skill via the `skill` tool.

For new features:

1. Write tests that describe the expected behavior and confirm they fail.
2. Implement the code to make them pass.
3. Refactor while keeping tests green.

For bug fixes, use the Prove-It pattern:

1. Write a test that reproduces the bug and must fail.
2. Confirm the test fails.
3. Implement the fix.
4. Confirm the test passes.
5. Run the relevant full test suite for regressions.

For browser-related issues, also invoke `browser-testing-with-devtools` via the `skill` tool to verify with Chrome DevTools MCP.
