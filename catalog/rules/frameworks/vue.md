---
fleet-template: vue
fleet-source-version: 1
---
# Rule: Vue component conventions

Load when planning, changing, or reviewing Vue components. This is a framework profile, not a language rule: adapt it to the installed Vue version, SFC/in-DOM context, and existing API style.

Disposition: partial extraction — explicit contracts, request states, and recovery kept; project component inventory and provider specifics excluded.

## Rules
- Identify the installed Vue version, SFC versus in-DOM context, and existing Options/Composition API usage before selecting syntax. Preserve explicit prop/event contracts; avoid introducing implicit app dependencies into reusable components.
- Represent loading, error, and completion state and prevent duplicate submissions where the operation requires it. Restore state after success and failure using the target component's actual disabled/event contract, not a copied reference-project control.
- Clean up owned listeners and timers with lifecycle APIs valid for the selected Vue version and API style.
- Use consistent component naming and file casing compatible with the template context. PascalCase SFC names are an optional convention, not a ban on kebab-case. No mandatory single-root wrapper and no forced migration between Options and Composition API.
- Keep SFC sections and options readable and consistent with local tooling; source examples disagree on ordering, so neither ordering becomes a universal rule. Lazy-load only at meaningful bundle boundaries.

## Scope and exceptions
Applies to Vue components in the target. Excluded source assumptions, never carried over: shared-package placement and ownership mandates, store getters, validation-library defaults, base-component inventories, global CSS fixes, and CSS sizing policy. The target adaptation must name its Vue version, API style, and component library actually in use.

## Verification
Run the target's component tests, type checks, and lint on touched components; exercise loading/error/duplicate-submission states where the rule applies. Flag version-specific behavior against the installed Vue documentation instead of asserting it.

## References
Use the target rule index and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
