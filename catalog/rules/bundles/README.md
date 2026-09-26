# Rule bundles

Bundles compose catalogue rules into task-shaped loading sets. A bundle is a selection, not a copy: targets adapt the referenced rules, never this index. Read the task row, load only the listed rules, and never bulk-load the catalogue.

| Task | Load | Notes |
| --- | --- | --- |
| Planning (including before any diff exists) | [repository-boundaries](../architecture/repository-boundaries.md), [verification-conventions](../testing/verification-conventions.md) | Planning selects by the future change, not by a diff. |
| Backend change | planning bundle + [csharp](../languages/csharp.md) and/or [sql](../languages/sql.md) as the target stack requires | Only the languages present in the target. |
| Frontend change | planning bundle + [javascript](../languages/javascript.md) and/or [vue](../frameworks/vue.md) as the target stack requires | Only the stack present in the target. |
| Cross-stack change | backend + frontend bundles | Resolve shared-contract ownership first. |
| Review | planning bundle + the stack rules of the touched code | Reviewer checks claims against evidence. |
| Docs-only task | [docs-maintenance](../docs/docs-maintenance.md) | Implementation bundles are not loaded for docs-only work. |
| Testing and verification | [verification-conventions](../testing/verification-conventions.md) | Binds policy to real checkers; workflow stays with Fleet skills. |
| Monorepo area change | The bundle of the affected area only | One shared root never imposes one stack on all packages. |

A docs-only task never loads implementation bundles. No bundle duplicates rule content; policy lives in the rules.
