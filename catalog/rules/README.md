# Reusable rule index

Catalogue templates are starting points, not target policy. Select only entries supported by target-repository evidence; adapt the content, not merely paths. Target files belong in `.ai/rules/`, not here. Read this index first; do not load the full catalogue by default.

| When | Template | Target use |
| --- | --- | --- |
| Planning or changing dependencies across repository areas | [repository-boundaries.md](architecture/repository-boundaries.md) | Map the actual owners and consumers; keep existing explicit boundaries and exceptions. |
| Planning, changing, or reviewing C# code | [languages/csharp.md](languages/csharp.md) | Bind to the target language version, nullable context, and analyzer policy; never inherit project layering or version pins. |
| Planning, changing, or reviewing JavaScript code | [languages/javascript.md](languages/javascript.md) | Bind to the target runtime, module format, and formatter/linter; never inherit bundler, store, or client defaults. |
| Planning database schema or data changes | [languages/sql.md](languages/sql.md) | Bind to the target engine and migration mechanism; dialect-aware guidance only, never a deployment pipeline. |
| Planning, changing, or reviewing Vue components | [frameworks/vue.md](frameworks/vue.md) | Bind to the installed Vue version and API style; framework profile, never a language rule or component inventory. |
| Creating or maintaining documentation | [docs/docs-maintenance.md](docs/docs-maintenance.md) | Bind to the target's accepted document types, paths, and index; no imported taxonomy. |
| Binding policy to observable checks | [testing/verification-conventions.md](testing/verification-conventions.md) | Link every rule to a real checker or assign review; no invented thresholds. |
| Authoring repository AI rules or task prompts | [policy-authoring.md](ai/policy-authoring.md) | Clear triggers, scope, rationale, and checkable outcomes without model-specific prescriptions. |
| Changing externally consumed interfaces | [public-contracts.md](architecture/public-contracts.md) | Bind compatibility checks and exceptions to actual consumers and accepted policy. |
| Collecting or sharing diagnostic evidence | [diagnostic-data-safety.md](security/diagnostic-data-safety.md) | Minimize collection and avoid secret-returning endpoints and sensitive artifacts. |
| Refreshing mixed generated and human-maintained data | [mixed-ownership-data.md](data/mixed-ownership-data.md) | Preserve annotations and distinguish unknown observations from deletions. |
| Creating or changing enums, named codes, or their persisted and serialized representations | [Explicit enum semantics](data/enum-semantics.md) | Adapt to accepted target contracts; no imported stack defaults. |
| Changing exports, reports, heavy read-only projections, or shared query loading shapes | [Reporting query correctness and efficiency](data/reporting-queries.md) | Adapt to accepted target contracts; no imported stack defaults. |
| Changing ui request handling, loading indicators, or error states | [Complete asynchronous UI states](frontend/async-ui-states.md) | Adapt to accepted target contracts; no imported stack defaults. |
| Changing routes, navigation, or query-string handling | [Navigation and URL consistency](frontend/navigation-contracts.md) | Adapt to accepted target contracts; no imported stack defaults. |
| Adding or changing form validation and input error display | [Consistent form validation](frontend/form-validation.md) | Adapt to accepted target contracts; no imported stack defaults. |
| Changing protected resource operations | [Authorization before side effects](security/authorization-before-effects.md) | Check actual resource permissions before mutation or queued effects. |
| Changing tenant-scoped access | [Trusted tenant scope](security/trusted-tenant-scope.md) | Derive and enforce scope from trusted identity across execution boundaries. |
| Refactoring existing behavior without an accepted functional change | [Behavior-preserving refactoring](architecture/behavior-preserving-refactoring.md) | Adapt to accepted target contracts and actual consumers. |
| Adding, moving, renaming, or removing files that participate in discovery, packaging, or runtime registration | [Structural-change registration completeness](architecture/structural-change-registration.md) | Adapt to accepted target contracts and actual consumers. |
| Changing a reusable package or component consumed by other applications | [Shared-package consumer verification](testing/shared-package-consumers.md) | Adapt to accepted target contracts and actual consumers. |
| Building or changing ui controls for which the target has shared visual primitives | [Reuse established UI primitives](frontend/established-ui-primitives.md) | Adapt to accepted target contracts and actual consumers. |
| Designing or changing externally exposed responses or their intermediate projections | [Response-data minimization](security/response-data-minimization.md) | Adapt to accepted target contracts and actual consumers. |
| Formatting dates or times in email, in-app, or other notification channels | [Notification date and time consistency](backend/notification-date-time.md) | Adapt to accepted target contracts and actual consumers. |
| Loading task-shaped rule sets | [bundles/](bundles/) | Compose rules per task; docs-only work never loads implementation bundles. |

A code pattern without explicit policy is evidence for a *proposal*, not an adopted rule. Ask for acceptance before writing normative repo-derived policy.
