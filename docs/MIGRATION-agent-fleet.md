# Migration record: agent-skills fork → standalone agent-fleet

One-time record of the July 2026 split of `chankov/agent-skills` (a fork of
`addyosmani/agent-skills`) into the standalone, non-fork repository
`chankov/agent-fleet`. Requirements: [prd-agent-fleet-split.md](prd-agent-fleet-split.md).

## What was done

1. **Freeze and backup** (in the old fork working copy):
   - Pending work committed on `main` (Hermes bridge, `ask-user-remote`
     harness, split PRD).
   - Tag `pre-agent-fleet-filter-migration` created.
   - Full-history backup: `git bundle create ../agent-skills-full-history.bundle --all`.

2. **Filtered history.** A fresh clone was filtered with
   `git filter-repo 2.47.0` using an **inverted path filter**: instead of an
   explicit keep-list, only the upstream-derived skill directories that were
   byte-identical to upstream were dropped, preserving all fleet history plus
   repo plumbing (CHANGELOG, .github, .gitignore, plugin metadata).

   ```bash
   git clone --no-local <old-fork> agent-fleet-migration
   cd agent-fleet-migration
   git filter-repo --invert-paths \
     --path skills/api-and-interface-design/ \
     --path skills/ci-cd-and-automation/ \
     --path skills/code-simplification/ \
     --path skills/debugging-and-error-recovery/ \
     --path skills/documentation-and-adrs/ \
     --path skills/doubt-driven-development/ \
     --path skills/observability-and-instrumentation/ \
     --path skills/shipping-and-launch/ \
     --path skills/source-driven-development/ \
     --path skills/test-driven-development/
   ```

   Result: 414 commits → 396 commits.

   The other 14 upstream-named skill directories were **kept with history**
   because they carry deliberate fork-local policy edits (agent operating
   rules, review gates, `_internal` grilling helper references); they now
   shadow their vendored originals — see
   [UPSTREAM-SKILLS.md](UPSTREAM-SKILLS.md). The diff of each kept directory
   against upstream `c1974de` was reviewed before the drop-list was final.

3. **Adopted in `chankov/agent-fleet`.** The filtered history was fetched into
   the new repo's clone and `main` was hard-reset to it, replacing the
   repo-creation LICENSE-only initial commit. The GitHub repo was created
   fresh (not via the fork flow), so no "forked from" banner exists.

4. **Vendored upstream.** Upstream `skills/` + `LICENSE` imported at
   `addyosmani/agent-skills@c1974de476a39cb002a3b8e51e6a7e8e57b808c6` into
   `vendor/agent-skills-upstream/`, wired into skill discovery
   (`package.json` `pi.skills`/`files`, guided setup, doctor, plugin
   manifest). Policy and update procedure: [UPSTREAM-SKILLS.md](UPSTREAM-SKILLS.md).

5. **Rebranded.** `@chankov/agent-skills` → `@chankov/agent-fleet`; bin
   `agent-skills` → `agent-fleet` (no alias); commands `/setup-agent-skills` →
   `/setup-agent-fleet`, `/doctor-agent-skills` → `/doctor-agent-fleet`;
   OpenCode prefix `as-*` → `af-*`; install record `.ai/agent-skills-setup.md`
   → `.ai/agent-fleet-setup.md`; overrides `.ai/agent-skills-overrides.md` →
   `.ai/agent-fleet-overrides.md`; extension `agent-skills-update-check` →
   `agent-fleet-update-check`; `FORK.md` retired in favour of
   [ARCHITECTURE.md](ARCHITECTURE.md), [UPSTREAM-SKILLS.md](UPSTREAM-SKILLS.md),
   and this file.

## Compatibility notes (clean break, no aliases)

- Workspaces installed by `@chankov/agent-skills` are **not auto-detected** by
  `agent-fleet update` (the install record filename changed). Re-run
  `npx @chankov/agent-fleet init` in those workspaces.
- The npm package `@chankov/agent-skills` should receive a deprecation notice
  pointing at `@chankov/agent-fleet`.
- The old fork repo should get a README migration notice and be archived only
  after Agent Fleet workflows are confirmed in real use.

## Validation checklist

- [x] `npm test` green (206 tests + CLI smoke)
- [x] `npm run pack:dry` — tarball `chankov-agent-fleet-*`, vendor/ included
- [x] `node bin/cli.js --version` / `--help` show agent-fleet branding
- [x] repo-wide grep: `agent-skills` remains only in vendor paths, upstream
      attribution, the PRD, and CHANGELOG history
- [x] fleet history preserved (`git log -- .pi/ scripts/ hermes/`)
- [x] `claude plugin validate .` passes
- [ ] Real-workspace `init` + guided setup exercised end-to-end
- [ ] Old fork archived with migration notice
