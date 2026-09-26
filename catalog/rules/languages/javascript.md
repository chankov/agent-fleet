---
fleet-template: javascript
fleet-source-version: 1
---
# Rule: JavaScript conventions

Load when planning, changing, or reviewing JavaScript code. Adapt this profile to the target's runtime, module system, and formatter/linter; it is a starting point, not target policy.

Disposition: partial extraction — portable contracts kept, project and provider specifics excluded.

## Rules
- Use descriptive, consistent identifiers. Candidate conventions are camelCase functions/variables and PascalCase classes; UPPER_SNAKE_CASE is an optional convention for semantic constants, not for every `const` binding.
- Preserve module contracts and side-effect import ordering. Import grouping, named/default exports, and quote/indentation choices follow the selected formatter/linter; do not convert exports or reorder side effects for style.
- Release listeners and timers when their owner no longer needs them. Observe async failures and restore operation state on success and error, using `finally` where appropriate.
- Document non-obvious behavior and public parameter/return contracts; use JSDoc where applicable without requiring boilerplate for every function.
- Use dynamic imports only at useful loading boundaries supported by the target build and runtime. Do not impose a bundler, state library, HTTP client, browser-only globals, or a file layout.

## Scope and exceptions
Applies to JavaScript sources in the target. Excluded source assumptions, never carried over: prescribed bundler or store, concrete HTTP wrapper, browser-only APIs, and file-layout mandates. The target adaptation must name its runtime, module format, and the formatter/linter actually enforced.

## Verification
Run the target's tests and lint on touched files; confirm no export or import-order change alters runtime behavior. Flag environment-specific behavior against the target runtime instead of asserting it.

## References
Use the target rule index and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
