---
"@chankov/agent-fleet": patch
---

Declare `@sinclair/typebox` and `typebox` as wildcard peer dependencies instead of runtime dependencies so Pi uses its host-provided modules without startup warnings. Keep both packages as development dependencies for local tests and typechecking. Fixes #36.
