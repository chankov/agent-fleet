---
name: repository-ai-setup
description: Sets up repository AI rules from the packaged Fleet catalogue — discover target evidence, propose semantic adaptations, grill unresolved decisions one question at a time, then diff, apply, and verify. Use for initial .ai/rules setup and repeated additions or updates via an optional change request.
---

# Repository AI Setup

Initial and repeated setup of a target repository's `.ai/rules`, `.ai/commands`,
and `.ai/agent-prompts` from the Fleet catalogue, plus the Fleet settings handoff
that makes the result load automatically. Follow
`references/setup-flow.md` for the phase checklists,
`references/apply-contract.md` for the deterministic write rules, and
`references/provenance-template.md` for the file metadata contract.

## When to Use

Apply this skill when the user invokes `/af-setup-rules` (optionally with a
free-text change request such as "add API compatibility rules"), or asks to set
up, review, or extend a repository's AI rules from the Fleet catalogue.

**When NOT to use:**

- Ordinary planning, building, or reviewing — read the already-installed
  `.ai/rules` index instead of re-running setup.
- Deterministic installation (`agent-fleet setup`) — that path stays
  non-interactive and never runs this interview.
- Editing Fleet settings by hand or via any path other than the CLI below.

## Non-negotiable boundaries

1. **Catalogue source is the installed Fleet npm package only.** Resolve it with
   `requirePackageCatalogue(packageRoot)` from `bin/lib/project-provenance.js`
   before any selection. If the package has no `catalog/` payload, stop this
   capability with a clear error — other Fleet functionality keeps working.
   Never copy the catalogue beneath `.pi/`, never infer one from a source
   checkout, never download it silently. This skill consumes the library; the
   library is not part of any repository's own policy.
2. **Missing rules/docs paths warn and continue, never fail setup.** A
   configured root that does not exist on disk is advisory, not fatal.
3. **This skill never edits overrides and contains no overrides merge
   algorithm.** All settings changes go through the deterministic CLI:
   preview with `agent-fleet configure --rules <dirs> --docs <paths> --dry-run`,
   then apply the reviewed preview with `--expect-hash <expectedHash> --yes`.
   There is no second Markdown merge writer in this skill or its references.
4. **Provenance is the single sidecar `.ai/agent-fleet-ai-state.json`.**
   Read, classify, and write it only via `bin/lib/project-provenance.js`
   (`readProjectProvenance`, `classifyProjectFile`, `applyAcceptedProjectFiles`).
   Template-derived files carry `fleet-template` / `fleet-source-version`
   frontmatter; repo-derived files never get an invented template identity.
   `appliedHash` lives in the sidecar, never in the hashed file. The sidecar is
   preserved on uninstall and is not installer ownership.
5. **Existing explicit policy is preserved without redundant confirmation.**
   A rule inferred only from code frequency or consistency is a proposal with
   cited evidence — never normative — until the user explicitly accepts it.

## The workflow

Run these phases in order. The detail for each step lives in
`references/setup-flow.md`; the gates below are normative.

### 1. Discover before asking

Resolve target root and git state. Read existing `.ai/` files, Fleet overrides,
the docs policy and indexes. Inventory manifests, formatter/linter/analyzers,
build/test commands, CI, module boundaries, and templates using representative
implementations and callers — not extension counts. Skip generated, vendor,
build, and cache trees; never read secret values. For each recommendation
record evidence source, scope, status (confirmed / proposed / conflicting),
proposed file, reason, and check. Unknown stays unknown.

### 2. Present a concrete proposal

Show the proposed tree, selected profiles/roles/commands, files to update, new
files, and conflicts. Keep working structure; never move an intact catalogue to
match a template. Adaptations are complete project files with concrete rules,
paths, templates, and verification steps — never placeholder-only substitution,
never imported reference-repository defaults without target evidence.

### 3. Grill unresolved important decisions

Follow `skills/_internal/grilling.md`. Never re-ask what is already explicit in
chat, plan, spec, rules, or a recorded decision. For each remaining
load-bearing fork ask **one question at a time**, each with the found evidence,
2–4 real options, your **recommendation with reason**, and the material
trade-off. Use the native user-question tool; where none exists, ask a real
text question and wait — never simulate a tool call or an answer. Let each
answer shape the next question. Record accepted / rejected / deferred in the
proposal; a deferred decision never authorizes its dependent change. If every
decision is already explicit, report the zero-open-decisions case instead of
inventing questions. Headless runs may produce analysis and a proposal only:
no fake interview, no auto-acceptance, no apply of undecided policy.

### 4. Apply reviewed changes and verify

Show the concrete diff with the recorded decisions before writing. Honor
authorization already given; do not re-ask for the same actions. Re-check file
bytes immediately before writing if the repo changed since preview. Apply
content and provenance per `references/apply-contract.md` (current bytes vs
`appliedHash`: no-op, local-edit, source-update, conflict, unknown); settings
go through the CLI handoff. On error report exactly what was written and what remains, and
restore only your own changes when safe. Then verify per `references/verify-setup.md`: links, triggers, stale
placeholders, overrides content, target-local command discovery, prompt
reference resolution, and clean-session policy use. An unchanged accepted state
is a byte-identical no-op with no regeneration.

## Repeated runs and change requests

Rules and commands are the default scope; include agent prompts when the change
needs them or the user asks. A scoped request updates only affected files and
their necessary indexes, references, and adapters. Repeating a fulfilled
request adds no duplicates. A new change request re-opens its affected scope
even when template versions are unchanged.

## Headless and unanswered decisions

Without a live user: discover, propose, stop. Unanswered decisions never lead
to dependent apply. Say what is blocked and what the user must decide.
