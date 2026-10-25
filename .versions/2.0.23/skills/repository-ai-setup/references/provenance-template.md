# Accepted target-file metadata template

For accepted template-derived Markdown files under `.ai/rules`, `.ai/commands`, or `.ai/agent-prompts`, prepend:

```yaml
---
fleet-template: <stable catalog entry id>
fleet-source-version: <source version>
---
```

The repository-specific content follows. Native slash adapters must first satisfy their runtime dialect's metadata/registration requirements. For repo-derived files, do **not** invent either template field. The exact final target bytes (including frontmatter) are hashed in the separate sidecar; never put `appliedHash` in the file itself.

Read/write `.ai/agent-fleet-ai-state.json` via `bin/lib/project-provenance.js`. Each entry is keyed by a repo-relative path within the three `.ai` catalogues and records `origin`, `evidence` (repo-relative references), `acceptedDecision` (the actual accepted decision), `inputs` (relevant generation inputs) and `appliedHash`. Template origin additionally requires `templateId`, `sourceVersion`, `sourceHash` (SHA-256 of source template bytes). The schema is version 1. A repo-derived origin has no template identity. The sidecar is not installer install-state/ownership and remains on uninstall.

The setup capability must resolve the catalogue from the installed Fleet **npm package** using `requirePackageCatalogue(packageRoot)` before any selection; failure is advisory to other Fleet functionality but blocks this setup capability. Never copy the catalogue beneath `.pi/`, infer one from a source checkout when missing from the package, or download it silently. Classification hashes distinguish changes; they are not old bodies or three-way merge bases. Show a candidate diff and require review for updates/conflicts, adopting unknown files explicitly. Do not turn code-derived evidence into normative policy without an accepted decision.
