---
fleet-template: csharp
fleet-source-version: 1
---
# Rule: C# conventions

Load when planning, changing, or reviewing C# code. Adapt this profile to the target's language version, nullable context, and analyzer/editorconfig policy; it is a starting point, not target policy.

Disposition: partial extraction — portable contracts kept, project and provider specifics excluded.

## Rules
- Validate required arguments before dependent work; express optionality and nullability accurately for the target language version and nullable annotations. Use meaningful exception types and messages tied to the failure; do not impose a project validation base class or a shared `IsValid` gate.
- Use awaitable contracts for asynchronous operations and observe completion and failure. Preserve the target's supported `Task` / `Task<T>` / `ValueTask` contracts and framework event-handler exceptions; do not require every method or every database call to be async merely by category.
- Dispose resources the code owns according to their lifetime; do not impose a particular context factory and do not dispose externally owned or DI-managed objects.
- Catch exceptions where there is a concrete handling, translation, or cleanup responsibility. No blanket catch rule by layer, no mandatory try/catch around every body, and no claim that any single call pattern universally prevents deadlocks.
- Candidate conventions (adopt only what the target's editorconfig/analyzers or an explicit decision select): descriptive identifiers, conventional interface `I-` prefix and `Async` suffix for awaitable methods, built-in type aliases, consistent brace and property layout. Indentation, blank-line counts, and `var` preference follow existing tooling — they are not inherited defaults.

## Scope and exceptions
Applies to C# sources in the target. Excluded source assumptions, never carried over: project layer suffixes, API route shapes, mapper/repository placement, enum policy, pinned SDK/language versions, and ORM configuration. The target adaptation must name its language version, nullable context, and the analyzer rules actually enforced.

## Verification
Build the target, run its test suite, and confirm analyzer diagnostics for touched files. Flag version-specific behavior against the installed SDK documentation instead of asserting it.

## References
Use the target rule index and applicable project documentation. These catalogue paths are *source references*, not target runtime links: replace them with actual `.ai/` references when adapting.
