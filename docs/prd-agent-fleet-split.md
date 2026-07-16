# PRD: Agent Fleet Repository Split and Upstream Skills Vendoring

## Status

Draft requirements for migrating this repository from an `agent-skills` fork into a standalone **Agent Fleet** repository.

## Decision Summary

The chosen direction combines:

1. **Filtered/split-history repository** — create a new GitHub repository that is not a fork and carries only the history relevant to Agent Fleet, Pi orchestration, Herdr, coms, Hermes, and fleet-native skills/docs.
2. **Manual vendored upstream skills** — keep the original `addyosmani/agent-skills` content as an explicitly imported vendor source, not as the project identity or fork base.

## Problem Statement

The current repository started as a fork of `addyosmani/agent-skills`, but its strategic direction has shifted toward a Pi-centered multi-agent orchestration system:

- Pi Coding Agent as the primary runtime.
- Herdr as the visible fleet/workspace control plane.
- coms as the peer communication data plane.
- Claude Code and future command-line agents as external runnable peers.
- Hermes as a future remote-control, conductor, and Kanban/tracking layer.
- A future dashboard combining Kanban state, Herdr workspaces, peer status, and active orchestration runs.

Keeping the repository as a visible GitHub fork makes `agent-skills` appear to be the center of the product. The new repository should instead be centered on **Agent Fleet** while still being able to consume and update all upstream agent skills manually.

## Goals

- Create a new GitHub repository, likely `chankov/agent-fleet`, that does **not** appear as a fork of `addyosmani/agent-skills`.
- Preserve relevant Git history for fleet/orchestration code using a filtered-history migration.
- Rebrand the product around Agent Fleet and multi-agent orchestration.
- Keep upstream agent skills available as manually vendored content.
- Make upstream skill updates repeatable and auditable.
- Support all existing local fleet/orchestration capabilities after migration.
- Prepare the repository structure for future Hermes/Kanban/dashboard work.

## Non-Goals

- Do not maintain a long-lived fork identity for the new repository.
- Do not continue treating upstream `agent-skills` as the root product.
- Do not require upstream changes to be merged through normal fork sync.
- Do not implement the Hermes/Kanban dashboard as part of this migration.
- Do not remove attribution to upstream `agent-skills`.
- Do not rewrite unrelated upstream history into the new repository unless needed for Agent Fleet provenance.

## Users and Stakeholders

- **Maintainer/operator**: manages Agent Fleet, updates vendored skills, and operates Pi/Herdr/Hermes workflows.
- **Pi agent users**: install and use the Agent Fleet package, skills, prompts, harnesses, and extensions.
- **Fleet participants**: Pi peers, Claude Code peers, and future CLI agents coordinated through Herdr/coms.
- **Future dashboard users**: monitor Kanban state, peer execution, and orchestration progress.

## Current-State Assumptions

The current repository contains both upstream-derived skill content and fork-local orchestration work. The migration should assume the following local areas are first-class Agent Fleet assets:

- `.pi/harnesses/`
- `.pi/extensions/`
- `.pi/agents/`
- `.pi/prompts/`
- `agents/`
- fleet-native `skills/` such as orchestration, peer communication, setup, and compound-learning skills
- `scripts/team-up.ts`, `scripts/team-snapshot.ts`, Herdr/coms/Hermes bridge scripts, and shared script libraries
- `hermes/`
- `docs/coms-hermes-bridge.md`, `docs/claude-code-coms-bridge.md`, `references/fleet-coordination-patterns.md`, and Pi/fleet documentation
- packaging, CLI, update, and setup tooling needed to install and operate Agent Fleet

## Product Requirements

### R1. New Repository Identity

The migration must create a new GitHub repository that is not created through GitHub's fork flow.

Requirements:

- Repository name should be `agent-fleet` unless superseded by a later naming decision.
- GitHub must not display "forked from addyosmani/agent-skills" on the new repository.
- The old `agent-skills` fork may remain as an archive, redirect, or historical source.
- The new repository must have its own README, package metadata, install docs, and release identity.

### R2. Filtered Relevant History

The new repository should preserve useful history for Agent Fleet while dropping most upstream-only history.

Requirements:

- Use `git filter-repo` or an equivalent auditable process.
- Keep history for fleet/orchestration paths.
- Exclude upstream-only paths that are not part of Agent Fleet's product surface.
- Keep a full-history backup tag or archive before filtering.
- Document the exact filtering command and path list in a migration note.

Candidate keep paths:

```text
.pi/
agents/
hermes/
scripts/
bin/
docs/
references/
hooks/
.claude/commands/
.opencode/commands/
.changeset/
.versions/
package.json
package-lock.json
justfile
AGENTS.md
CLAUDE.md
CONTRIBUTING.md
LICENSE
README.md
```

Candidate skill paths to keep as first-class Agent Fleet content:

```text
skills/orchestration-verification/
skills/peer-coms/
skills/compound-learning/
skills/guided-workspace-setup/
skills/designing-agents/
```

The final path list must be reviewed before running the destructive filter operation.

### R3. Manual Vendored Upstream Skills

The new repository must consume upstream `agent-skills` as vendored content.

Requirements:

- Add a vendor directory, for example:

```text
vendor/agent-skills-upstream/
```

- Import the upstream repository content manually from a recorded upstream commit SHA.
- Add `docs/UPSTREAM-SKILLS.md` documenting:
  - upstream repository URL;
  - imported commit SHA;
  - import date;
  - included paths;
  - local modification policy;
  - update procedure;
  - attribution and license notes.
- Prefer no direct edits inside `vendor/agent-skills-upstream/`.
- If a local patch is needed, record it separately in an overlay, patch file, or Agent Fleet-native skill.
- Upstream skill updates should be explicit maintainer actions, not automatic fork merges.

### R4. Unified Skill Discovery

Agent Fleet must continue to expose both fleet-native skills and vendored upstream skills.

Requirements:

- Fleet-native skills remain first-class project content.
- Vendored upstream skills remain available to supported agents.
- Install/setup tooling must know how to include both sources.
- If duplicate skill names exist, Agent Fleet-native skills must take precedence unless documented otherwise.
- The system must report which upstream commit a vendored skill came from.

Expected logical model:

```text
skills/                         # Agent Fleet-native skills
vendor/agent-skills-upstream/    # upstream imported skills and references
```

Optional generated/install output:

```text
.pi/skills/                      # generated or installed Pi-facing skill set
.claude/commands/                # Claude Code command surface
.opencode/commands/              # OpenCode command surface
```

### R5. Rebranding

The new repository must be rebranded from `agent-skills` to `agent-fleet`.

Requirements:

- Rename package metadata from `@chankov/agent-skills` to an Agent Fleet package name, likely `@chankov/agent-fleet`.
- Rename CLI branding from `agent-skills` to `agent-fleet` where appropriate.
- Keep backward-compatible aliases only if they reduce migration friction.
- Replace `FORK.md` with documents such as:
  - `docs/UPSTREAM-SKILLS.md`
  - `docs/MIGRATION-agent-fleet.md`
  - `docs/ARCHITECTURE.md`
- README must present Agent Fleet as the product and upstream skills as one dependency/input.
- Marketplace/plugin metadata must stop identifying the package primarily as an `agent-skills` fork.

### R6. Fleet-Orchestration Architecture

The repository should be organized around Agent Fleet's runtime responsibilities.

Requirements:

- Pi Coding Agent remains the primary local runtime.
- Herdr remains the fleet/workspace control plane.
- coms remains the peer communication protocol/data plane.
- Claude Code and other CLI agents must be supportable as peers through bridge/adaptor layers.
- Hermes integration must remain compatible with remote human control and future conductor use.
- The architecture must allow future Kanban/task-tracking and dashboard modules without another repository rename.

Target conceptual modules:

```text
.pi/                         # Pi runtime harnesses, extensions, agents, prompts
skills/                      # Agent Fleet-native skills
agents/                      # Personas/subagents used by Agent Fleet
scripts/                     # CLI helpers, bridges, team launchers
hermes/                      # Hermes-facing skills/integration assets
vendor/agent-skills-upstream/ # manually imported upstream skills
apps/dashboard/              # future dashboard app
packages/fleet-core/         # future extracted core orchestration library
packages/herdr-bridge/       # future Herdr integration package
packages/hermes-bridge/      # future Hermes integration package
```

The migration does not need to create all future directories immediately, but the PRD should guide naming and future placement.

### R7. GitHub Migration Safety

The migration must be reversible until the new repository is verified.

Requirements:

- Create a local branch/tag before filtering.
- Keep the current fork remote available as `old-origin` or another explicit name during migration.
- Create the new GitHub repo empty, not initialized with README/LICENSE.
- Push the filtered repository to the new non-fork repo.
- Do not delete or archive the old repo until the new repo is validated.
- Document commands used during migration.

### R8. Attribution and License Compliance

The new repository must preserve proper attribution.

Requirements:

- Keep the upstream license where required.
- Document that upstream skills originate from `addyosmani/agent-skills`.
- Record imported upstream SHAs.
- Avoid implying upstream endorsement of Agent Fleet.
- Keep license notices in vendored content.

### R9. Validation

The migrated repository must pass a minimum validation checklist before the old fork is archived.

Required validation:

- Package install succeeds.
- CLI smoke test succeeds.
- Pi setup path works.
- Existing fleet recipes still launch or fail with expected dependency messages.
- Herdr-dependent commands still detect missing Herdr cleanly.
- coms and Hermes bridge tests pass if present.
- Vendored upstream skills are discoverable by the install/setup process.
- README and docs no longer frame the repo as a fork.

### R10. Documentation Deliverables

The migration must produce or update documentation.

Required docs:

- `README.md` — Agent Fleet product overview.
- `docs/ARCHITECTURE.md` — high-level Agent Fleet architecture.
- `docs/UPSTREAM-SKILLS.md` — upstream vendoring policy and update procedure.
- `docs/MIGRATION-agent-fleet.md` — one-time migration commands and verification checklist.
- `docs/getting-started.md` or equivalent install docs — updated package and CLI names.

## Suggested Migration Plan

### Phase 0: Freeze and backup

- Confirm all local work is committed or intentionally excluded.
- Tag the current state.
- Export a full bundle backup.

Example:

```bash
git status
git tag pre-agent-fleet-filter-migration
git bundle create ../agent-skills-full-history.bundle --all
```

### Phase 1: Create filtered repository locally

- Clone a fresh local migration copy.
- Run `git filter-repo` with the reviewed keep-path list.
- Verify retained history and retained files.

Example shape:

```bash
git clone /path/to/current/agent-skills ../agent-fleet-migration
cd ../agent-fleet-migration
git filter-repo \
  --path .pi/ \
  --path agents/ \
  --path hermes/ \
  --path scripts/ \
  --path bin/ \
  --path docs/ \
  --path references/ \
  --path hooks/ \
  --path .claude/commands/ \
  --path .opencode/commands/ \
  --path .changeset/ \
  --path .versions/ \
  --path skills/orchestration-verification/ \
  --path skills/peer-coms/ \
  --path skills/compound-learning/ \
  --path skills/guided-workspace-setup/ \
  --path skills/designing-agents/ \
  --path package.json \
  --path package-lock.json \
  --path justfile \
  --path AGENTS.md \
  --path CLAUDE.md \
  --path CONTRIBUTING.md \
  --path LICENSE \
  --path README.md
```

The exact command must be reviewed and adjusted before use.

### Phase 2: Vendor upstream skills manually

- Add `vendor/agent-skills-upstream/`.
- Copy/import upstream content from a selected commit.
- Record source metadata in `docs/UPSTREAM-SKILLS.md`.
- Ensure install/setup tooling can include vendored skills.

### Phase 3: Rebrand

- Update package name, binary names, repository URLs, plugin metadata, and docs.
- Replace fork language with upstream-vendor language.
- Keep compatibility aliases only where useful.

### Phase 4: Push to new GitHub repo

- Create `chankov/agent-fleet` as an empty non-fork repository.
- Add it as `origin`.
- Push branches/tags that are part of the new project.

### Phase 5: Validate and archive old fork

- Run validation checklist.
- Update old repo README with migration notice.
- Archive old repo only after install and orchestration workflows are confirmed.

## Acceptance Criteria

The migration is successful when:

- `chankov/agent-fleet` exists and GitHub does not mark it as a fork.
- Relevant Agent Fleet history is preserved after filtering.
- Upstream `agent-skills` content exists only as documented vendored content or install input.
- Agent Fleet-native orchestration code remains first-class.
- All supported skills are installable/discoverable.
- Package/docs/CLI no longer present the product as `agent-skills`.
- A documented manual upstream skill update process exists.
- Validation checklist passes.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Filtering drops useful history or files | Review keep-path list, work in a clone, keep full bundle backup |
| Vendored upstream diverges silently | Record upstream SHA and import date; require explicit update docs |
| Duplicate skill names cause ambiguity | Define precedence: Agent Fleet-native skills override vendored skills |
| Rebranding breaks install/update tooling | Keep temporary aliases and run package/CLI smoke tests |
| Old fork and new repo confuse users | Add clear archival notice and migration link in old repo |
| License/attribution issues | Preserve upstream license files and add `UPSTREAM-SKILLS.md` |

## Open Questions

- Final package name: `@chankov/agent-fleet` or another scope/name?
- Final CLI name: `agent-fleet`, `fleet`, or both?
- Should vendored upstream include the full repository or only `skills/`, `agents/`, `references/`, and commands?
- Should generated install artifacts copy vendored skills, symlink them, or resolve them dynamically?
- Should the old `agent-skills` fork be archived immediately or kept active temporarily as a compatibility channel?
