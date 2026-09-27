# Setup flow: discovery → proposal → grilling → diff → apply → verify

Detailed checklists for the `repository-ai-setup` skill. Normative gates live
in `../SKILL.md`; this reference holds the executable shape of each phase and
the CLI handoff. It contains no overrides merge algorithm — settings changes
use `agent-fleet configure` only.

## 1. Discovery checklist

- Resolve target root and git state (`git status --short`, current branch).
- Read: existing `.ai/rules`, `.ai/commands`, `.ai/agent-prompts` (indexes
  first, then task-relevant entries); `.ai/agent-fleet-overrides.md` (`rules:`,
  `docs:` under `## agent-hub`); `AGENTS.md` / `CLAUDE.md` pointers; docs
  entry points and their index files.
- Inventory with representative evidence, not counts: language manifests and
  lockfiles; formatter / linter / analyzer configs; build and test commands;
  CI workflows; module boundaries with actual consumers; existing document
  templates (PRD / ADR / runbook); current quality gates (`quality:` under
  `## workflows`, CONSTRAINTS.md when present).
- Skip generated, vendor, build, and cache trees. Never read secret values.
- Classify every finding: **confirmed** (explicit policy — reuse without
  re-asking), **proposed** (code-observed practice with cited files, scope, and
  exceptions — needs acceptance), or **conflicting** (competing explicit
  policies or patterns — needs a decision). Missing or unverifiable facts stay
  unknown. Never create empty language directories or invent build commands.

## 2. Proposal shape

Present, in chat or a session artifact per the target docs policy:

1. Proposed `.ai/` tree (new files, files to update, files untouched).
2. Selected catalogue profiles / roles / commands with one-line reasons tied
   to discovery evidence.
3. For each new or changed file: evidence source, scope, status, and the
   observable check that will verify it.
4. Conflicts and material deviations from catalogue intent, each mapped to a
   grilling question — never resolved silently.
5. Settings delta as CLI arguments (roots only), not file edits.

Each adapted file must be a complete project file: concrete trigger, rules,
applicable paths, accepted exceptions, verification, and real `.ai/` or docs
references. Catalogue source paths are source references, never target links.

## 3. Grilling format

One question at a time. Each question carries:

- the evidence found (files, competing examples, tooling),
- 2–4 real options,
- the orchestrator's **recommendation with reason**,
- the material trade-off of deciding otherwise.

Typical families: canonical practice among conflicting patterns; formatter /
analyzer policy vs. established variants (no semantic reorder); local module
boundaries and exceptions; allowed document types, paths, and indexes;
blocking vs. advisory verification and which existing checker owns it; which
optional roles and tool integrations materially help; handling of existing
edits, replacements, retirements, and unresolved conflicts.

Record each outcome as accepted / rejected / deferred in the proposal.
Deferred blocks its dependent change. Zero open decisions is a result — report
it and proceed. In headless runs produce analysis and proposal only.

## 4. Diff, apply, verify

1. Show the concrete candidate diff preserving unrelated content, with the
   recorded decisions reflected. Honor prior authorization; re-check bytes if
   the repo moved since preview.
2. Classify each target file with `classifyProjectFile` (unchanged,
   local-edit, source-update, conflict, unknown/deleted) and act per the
   update contract: no-op stays byte-identical; local edits are preserved;
   source updates and conflicts need review and explicit reconciliation —
   never an automatic three-way merge; unknown files are adopted explicitly.
3. Write accepted content with `applyAcceptedProjectFiles` (or the equivalent
   reviewed write path), then update the sidecar only for files successfully
   written and re-read. Preserve / skip never changes `appliedHash`. A
   stale preview or interrupted apply is reported, never counted as success.
4. Settings handoff — the skill shows the CLI diff; the CLI performs the
   write. Preview first (zero writes):

   ```sh
   agent-fleet configure --rules .ai/rules --docs docs/README.md --dry-run --workspace <project>
   ```

   Review `before`, `after`, and `expectedHash`, then apply exactly the
   previewed roots:

   ```sh
   agent-fleet configure --rules .ai/rules --docs docs/README.md --expect-hash <expectedHash> --yes --workspace <project>
   ```

   Omit a key to leave it byte-identical. Repeat the preview to confirm a
   no-op. Missing configured paths warn and continue; they never fail setup.

## 5. Verification checklist

- Links resolve to real target files; no catalogue paths leak into `.ai/`.
- Triggers fire on the intended task intents; no empty rules block when the
  index is absent.
- No stale placeholders, no invented paths, checks, or commands.
- Overrides contain the accepted roots and nothing else changed; unknown
  sections, comments, and unrelated settings intact.
- Target-local slash adapters resolve their canonical `.ai/commands` source;
  agent prompts resolve by reference; no global registration, no automatic
  personas.
- Clean-session check: the configured policy loads for planning before edit
  without repeating any instruction.
- Unchanged rerun regenerates nothing and changes no bytes or metadata.
