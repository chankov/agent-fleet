---
fleet-template: policy-authoring
fleet-source-version: 1
---
# Rule: Repository AI policy authoring

Load when creating or changing target-local rules or task prompts. Adapt to existing policy owners; this is not a replacement for Fleet skill-authoring workflows.

Disposition: retain model-independent clarity and maintenance principles; exclude model tuning, performance claims, and instruction-priority shortcuts.

## Rules
- State a specific loading trigger, scope, and intended outcome; keep each rule focused.
- Explain non-obvious constraints and use concrete, checkable language instead of vague quality demands.
- Reference canonical policy rather than duplicating it. Resolve conflicting instructions against accepted decisions; ask about unresolved conflicts rather than inventing precedence.
- Separate examples and input data from instructions. Observed conventions are proposals until accepted, not automatic policy.
- Name completion criteria and real verification evidence. Add guidance for demonstrated needs, not speculative failure modes.

## Scope and exceptions
Applies to repository rules and task prompts, not runtime configuration or global instruction hierarchy. Bind references to target files; retain explicitly accepted local exceptions.

## Verification
Review triggers, scope, rationale, references, contradictions, and completion criteria. Distinguish structural checks from observed model behavior; document untested behavior rather than claiming compliance.
