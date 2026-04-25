---
description: Run the pre-launch checklist and prepare for production deployment
---

Use the `shipping-and-launch` skill.

Run through the complete pre-launch checklist:

1. Code quality: tests pass, build clean, lint clean, no stray TODOs or console logs.
2. Security: dependency audit checked, no secrets in code, auth in place, headers configured where applicable.
3. Performance: Core Web Vitals or relevant performance checks are acceptable, no N+1 queries, images and bundles are reasonable.
4. Accessibility: keyboard navigation works, screen reader semantics are acceptable, contrast is adequate.
5. Infrastructure: environment variables are set, migrations are ready, monitoring is configured.
6. Documentation: README is current, ADRs are written when needed, changelog is updated when relevant.

Report any failing checks and help resolve them before deployment. Define the rollback plan before proceeding.
