---
"@chankov/agent-fleet": patch
---

Fix compiler diagnostic path attribution through symlinked worktrees, including macOS temporary directories. Make diagnostics tests independent of `/tmp` and the installed TypeScript version.

Prevent release-blocking false positives by parsing actual import syntax instead of fixture text and checking untracked source files before commit. Run the shared Linux/macOS validation matrix on pull requests with read-only permissions, plus alternate-temp-directory regressions; reserve publishing permissions for validated main-branch releases.
