---
"@chankov/agent-fleet": patch
---

Unify System 1 configuration in a single human-owned `.ai/system1.json` v2 document, with shared provider settings and separate watchdog, proactive review, dispatch triage, and task triage policies.

**Migration required for existing System 1 workspaces:** v1 configuration reports `migration_required`; runtime no longer reads the separate legacy consumer JSON files or the Markdown `watchdog-system1` setting. Run `setup --workspace <repo> --migrate-system1-config --dry-run`, review the proposed settings, then apply with `--migrate-system1-config --expect-digest <digest-from-preview> --yes`. Repeat the preview for each target repository. Migration preserves existing permissions, budgets, profiles, local bindings, and unrelated Markdown, refuses conflicting or duplicate inputs, and retains a protected, Git-ignored recovery backup. It does not grant new consent or make inference requests. Consumer-only legacy workspaces without a provider document require the documented manual v2 configuration procedure; no provider/model is inferred.

Use one immutable configuration snapshot and shared service per Hub session. Root inference-off preserves independently enabled proactive local checks, and persisted Task Triage process obligations remain enforced when inference is off or unavailable. Start a new Fleet session after changing configuration.

Update setup, offline doctor diagnostics, the demo, and live dispatch evaluation to use v2. Harden configuration I/O and transaction recovery against symlinks, changed preview inputs, invalid recovery metadata, and accidental exposure of private Markdown buffers. Include shared JavaScript validators in installed packages, verify the packaged migration CLI on Node 18, and add configuration/migration regressions to the fast CI test lane.
