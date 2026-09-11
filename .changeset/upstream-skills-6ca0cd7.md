---
"@chankov/agent-fleet": minor
---

Update the vendored upstream skill library to `addyosmani/agent-skills@6ca0cd7` and add `constraint-driven-development`.

**New skill and command.** `constraint-driven-development` (phase: Plan) records a project's quality bar as numbers with stated reasons in `CONSTRAINTS.md` and guards the diff against a quietly lowered bar — new suppressions, skipped or deleted tests, stripped assertions, unimplemented stubs, thresholds edited down. It ships with a skill-local `references/floor-guard.md` reference implementation. The new `/af-constraints` command drives it in two modes: `setup` runs the four-question interview and writes the file; `check` runs the guard over the current diff with no interview. In a Fleet project the two halves stay apart on purpose — `CONSTRAINTS.md` holds the dimensions, numbers, and reasoning; `quality:` under `## workflows` stays the single executable gate that `just flow` obeys.

**Substantially expanded skills.** `performance-optimization` gains a keep-or-revert verification step, regression budgets, and deeper index, connection-pool, and cache-correctness material. `security-and-hardening` gains a Data Privacy & Compliance section, destructive-operations-on-derived-paths guidance, and shared-store rate limiting. `api-and-interface-design` gains idempotency-key handling. `context-engineering` gains Context Budget Management. `spec-driven-development` gains a Phase 0 scope check with a capability map, adapted to Fleet's own spec output location. `observability-and-instrumentation` gains runbook guidance and entry-point stamping. `shipping-and-launch` gains an error-budget release gate.

**Planning task list target.** `planning-and-task-breakdown` now defines a single task list target, selected by the existing `todo` override key, which accepts a third value: `tracker` routes tasks to a designated issue tracker instead of a markdown checklist. It also refuses to overwrite a plan that still has unchecked tasks for different work.

**Reference link resolution fixed.** Shared checklists are now addressed as `../../references/<file>.md`, which is what resolves from an installed skill at `.pi/skills/<name>/`. The previous `references/<file>.md` form pointed nowhere. Skill-local `references/` subdirectories keep the relative form.

**Shadow cleanup.** `code-review-and-quality`, `deprecation-and-migration`, `frontend-ui-engineering`, `performance-optimization`, and `security-and-hardening` were carrying no Agent Fleet customization — only stale upstream text — and are now synchronized verbatim with the vendored copies.

**Install manifest fix.** `companion:fleet-client-runtime` no longer lists a deleted documentation file as a source, which was failing manifest validation and every test that loads the real manifest.
