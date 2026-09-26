---
fleet-template: public-contracts
fleet-source-version: 1
---
# Rule: Public contract protection

Load when planning, changing, or reviewing externally consumed APIs, libraries, events, file formats, or CLI interfaces.

Disposition: extract external/internal contract separation; exclude prescribed layers, frameworks, and repository paths.

## Rules
- Identify published interfaces and known consumers from target evidence. Keep public contracts distinct from internal implementation details; do not impose extra layers or duplicate types without need.
- Review compatibility of names, types, defaults, errors, serialization, exit codes, and behavior where applicable. A signature-only comparison does not prove compatibility.
- Follow the target's accepted compatibility and versioning policy. If none exists, propose the intended compatibility boundary for acceptance before a breaking change.
- Trace affected consumers and name unknown consumers explicitly. An internal refactor does not authorize an external contract change.
- For accepted breaking changes, record migration guidance and the target's agreed deprecation or rollout approach; never invent a universal support period.

## Scope and exceptions
Applies only to externally consumed surfaces identified in the target; internal interfaces stay under repository-boundary policy. Record deliberate compatibility exceptions with scope and rationale.

## Verification
Compare representative old and new consumer behavior using available contract tests and examples. Report gaps and unverified consumers; passing internal tests alone does not prove external compatibility.
