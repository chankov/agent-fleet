---
"@chankov/agent-fleet": patch
---

Remove the unreleased shared installation-owner mode in favor of a standalone Fleet installation at the common parent of independent Git repositories. Keep non-Git parent evidence capture, scoped rules/docs and bounded no-symlink local installation-state reads.

Old `installationOwner` configurations now fail explicitly instead of being silently normalized as local or redirected. No runtime, ledger or human configuration is migrated or deleted automatically. Remove shared-owner preview/doctor metadata and replace owner-specific tests with local-state safety and parent lifecycle regressions.
