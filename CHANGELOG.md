# Agent Fleet changelog

All notable changes to `@chankov/agent-fleet` are documented here. Agent Fleet
starts at 0.0.1; earlier `@chankov/agent-skills` releases remain available in
git history. This file is generated from [changesets](https://github.com/changesets/changesets).

## 0.0.1

### Patch Changes

- 1b864df: Agent Fleet split: standalone repository, vendored upstream skills, full rebrand.

  - Repository split from the `agent-skills` fork into standalone `chankov/agent-fleet` with filtered history; upstream `addyosmani/agent-skills` is now consumed as manually vendored content in `vendor/agent-skills-upstream/` at a pinned SHA (see `docs/UPSTREAM-SKILLS.md`).
  - Package renamed `@chankov/agent-skills` → `@chankov/agent-fleet`; CLI bin `agent-skills` → `agent-fleet` (no alias); commands `/setup-agent-skills` → `/setup-agent-fleet`, `/doctor-agent-skills` → `/doctor-agent-fleet`; OpenCode prefix `as-*` → `af-*`; install record `.ai/agent-skills-setup.md` → `.ai/agent-fleet-setup.md`; overrides file `.ai/agent-skills-overrides.md` → `.ai/agent-fleet-overrides.md`; update-check extension renamed `agent-fleet-update-check`.
  - Skill discovery now spans two roots (native `skills/` wins over the vendored import on name collisions) across pi packaging, the guided setup, the doctor scan, and the Claude Code plugin manifest.
  - `FORK.md` retired; replaced by `docs/ARCHITECTURE.md`, `docs/UPSTREAM-SKILLS.md`, and `docs/MIGRATION-agent-fleet.md`.
  - Workspaces installed by `@chankov/agent-skills` are not auto-detected — re-run `npx @chankov/agent-fleet init`.

- 7d41b14: Fix the `bowser` browser-automation persona/skill so it actually resolves and document its external CLI dependency.

  - **Naming fixed** — `agents/bowser.md` referenced a skill named `playwright-bowser`, but the runtime skill is `.pi/skills/bowser/` (`name: bowser`), so the persona's skill hook never resolved. The persona now references the `bowser` skill, and its workflow runs `playwright-cli` commands (not the non-existent `playwright-bowser` command). The `transform-persona.js` pi-only comment is updated to match.
  - **External dependency documented** — the skill drives the external **Playwright Agent CLI** (`playwright-cli`), which is not bundled. `.pi/skills/bowser/SKILL.md` gains a Requirements section with the install commands (`npm install -g @playwright/cli@latest`) and a link to <https://playwright.dev/agent-cli/installation>; `docs/pi-extensions.md` notes the same.
  - **Guided setup maintains it** — when the `bowser` runtime-skill is selected, `guided-workspace-setup` now checks for `playwright-cli` on PATH and offers the install (treated as an external dependency, like `pi-ask-user`), with matching Red Flag and Verification entries.
  - **Broken link removed** — `SKILL.md` no longer points at a non-existent `docs/playwright-cli.md`; workflow step numbering corrected.

- 39b8bf4: Polish the browser-persona division:

  - `test-engineer` now states it owns test _code_ and hands off live-browser runtime-UI proof to `bowser` (headless) or `web-debugger` (interactive).
  - `bowser` gains an explicit `tools: read,bash` whitelist (it only needs Bash for `playwright-cli` plus read for outputs).
  - `guided-workspace-setup` notes that `bowser` and `chrome-devtools-mcp` are two complementary browser stacks and recommends both for full coverage.

- d9a4e3e: Document the division between the two pi browser stacks and align the orchestrator's runtime-UI guidance.

  - New "Two browser stacks — when to use which" decision section in `docs/pi-extensions.md` (policy + why `web-debugger` is a coms peer, not a subagent).
  - The `orchestrator` persona now routes `runtime-ui` proof by mode: delegate a `bowser` subagent for headless evidence, or hand off to the `web-debugger` coms peer for interactive headful Chrome.
  - Cross-reference notes added between `.pi/skills/bowser/SKILL.md`, `skills/browser-testing-with-devtools/SKILL.md`, and the `chrome-devtools-mcp` extension README.

- dbb3661: Make the `chrome-devtools-mcp` pi extension mode-configurable via env vars, so the always-on browser stack covers both headless and headful use:

  - `PI_CHROME_DEVTOOLS_MODE=headless|headed` (default headed) — adds `--headless` for background/CI runs.
  - `PI_CHROME_DEVTOOLS_BROWSER_URL` — attach to an already-running Chrome via `--browserUrl` instead of launching one.
  - `PI_CHROME_DEVTOOLS_USER_DATA_DIR` — use a persistent Chrome profile (`--userDataDir`), mutually exclusive with the default ephemeral `--isolated` profile.

  The default launch is unchanged (headed, isolated). Because the MCP server starts once at extension load, changing these requires a pi restart / `/reload`. Documented in the extension README and `docs/pi-extensions.md`.

- 0cb88c2: agent-hub: dashboard cards now list running delegate children ahead of finished ones. Previously children rendered in spawn order and the `MAX_CHILD_ROWS` cap could hide live sub-agents behind already-completed ones; running delegates now sort first (spawn order breaks ties within each group) so an in-progress child is never the row that gets dropped.
- 0cb88c2: release tooling: every version bump is now forced to a patch (x.y.Z+1). A new `bin/force-patch-changesets.js` rewrites any pending `minor`/`major` changeset to `patch` and runs ahead of `changeset version` in both the local `version:changeset` npm script and the CI release workflow, so local and CI releases agree. The release command also synchronizes `package-lock.json` and writes the bumped version's tracked `.versions/<version>/` snapshot. Run releases with `npm run version:changeset` (not `npm version patch`, which bypasses the changeset flow).
- 67cb274: Add the **Verification Contract** to the agent-hub orchestration flow, so a clearly stated requirement (e.g. "Retired/Disqualified behave like Walkover") cannot be silently dropped across a multi-agent run. The dispatcher now owns checkable acceptance assertions and refuses "done" until each is proven with evidence.

  - **New skill `orchestration-verification`** — the single canonical source for the acceptance-assertion format (numbered `A1…`, tagged `test` / `runtime-ui` / `code-grep` / `manual`), the parity/touchpoint inventory for "make X behave like Y" requests, the structured upward-return schema, and the requirement-regression reset. Added to the `using-agent-skills` discovery tree.
  - **One orchestrator persona (breaking).** `orchestrator` and `orchestrator-careful` are consolidated into a single `orchestrator` that carries the careful (correctness-first) posture as its default and layers the Verification Contract on top — it builds the assertion list first, commissions a deep-researcher parity inventory, gates vertical micro-slices, requires runtime proof for UI/visibility/placement assertions, accepts only structured returns, and resets assertions on "wrong again". `orchestrator-careful` is **retired** (the pi-only persona roster drops from 14 to 13); its review-first behaviour is preserved in the surviving persona.
  - **Specialists report assertion status, not a verdict.** `builder`, `test-engineer`, and `code-reviewer` adopt the structured return; the reviewer gains a parity/generalisation review axis plus a runtime-proof-required rule for UI findings; the test-engineer gains a parity-coverage rule; the delegate children (`recon`, `verifier`, coverage scouts, `quality`/`perf`) are aligned to consume the dispatcher's parity inventory and report in assertion terms (frontmatter, budgets, and `delegate_depth` unchanged).
  - **agent-hub harness** — new always-on `set_assertions` / `update_assertion` / `get_assertions` dispatcher tools persist the ledger to `.pi/agent-sessions/assertions.json` (wiped at session start like `findings/`) and render a one-line status, keeping the contract out of the dispatcher LLM context. `get_assertions` is the bounded read-only recovery path: after a compaction the status line shows only counts, so the dispatcher reads the full ledger (ids, tags, pass conditions, evidence) back before re-dispatching. Advisory in this phase: status is surfaced and "proven" requires named evidence, but a dispatch is never hard-refused on an unproven assertion.
  - **claude-code & opencode `/orchestrate`** — both commands now carry the instruction-level Verification Contract (assertions built first, parity inventory for "behave like X", runtime proof for UI assertions, structured assertion-status returns, regression reset on "wrong again") and report proven/unproven assertions rather than a bare "verified", closing the gap where the non-pi flows could report done on the old acceptance behaviour.
  - **Guided setup now offers `orchestration-verification`.** The skill ships in the npm tarball (covered by the `skills/` allowlist) but was missing from the `guided-workspace-setup` install menu, so it was never installed even on "Everything" — it is now an `★`-recommended row in a new _Orchestrate_ sub-group, recommended whenever a persona that reads it (`builder`/`test-engineer`/`code-reviewer`) or the `orchestrate` command is selected. Documented in the README ("All 21 Skills" + an _Orchestrate_ section) and the CLAUDE.md Skills-by-Phase map.
  - **`just hub` loads the `orchestrator` persona by default.** Both `hub` and `hub-solo` now append `agents/orchestrator.md` as the dispatcher system prompt (only when the file is installed, so the hub still launches without it); override with your own `--system-prompt <persona>.md`.
  - **Verification/comms hardening phases 1-2.** agent-hub now machine-parses structured returns, persists assertion-carrying raw outputs under `.pi/agent-sessions/artifacts/returns/`, reports compact `structuredReturn`/`returnPath`/`contractNotices` digests, and adds an artifact bus (`returns`, `plans`, `reviews`, `inventories`, `evidence`) with validated path-only handoffs for `dispatch_agent` and `spawn_research`.
  - **Verification/comms hardening phases 3-4.** `dispatch_agent` can now carry advisory `scope` globs for writable specialists, reporting out-of-scope git changes without blocking or reverting, and delegate child results now write full output to result files while returning only compact `DIGEST:` summaries plus paths to the parent.
  - **Verification/comms hardening phases 5-7.** `update_assertion(status: "proven")` now validates tag-specific evidence (including runtime-ui artifact paths), `/handoff` machine-appends the verbatim verification ledger plus artifact index after the LLM brief, and team specialist context pressure now renders at 70% with a restart hint but no automatic restart.
  - **Verification/comms hardening fixes.** Align artifact write paths with session artifact resolution, restrict runtime-ui proof to session evidence artifacts, guard handoff machine appendices with a matching token, and harden structured-return parsing so assertion IDs inside evidence or non-assertion lists do not corrupt parsed entries.

- 57078cd: Add a `web-debugger` agent persona for interactive headful Chrome debugging via the `chrome-devtools-mcp` extension, plus the coms-peer plumbing to run it.

  - **New persona** `agents/web-debugger.md` — drives the live `chrome_devtools__*` tools (DOM snapshot, console, network, performance traces) for runtime-UI verification with a human in the loop. It is the interactive counterpart to `bowser` (headless `playwright-cli` automation): `bowser` is delegatable to a `--no-extensions` subagent, while `web-debugger` runs as a coms peer that loads the extension. Reads the `browser-testing-with-devtools` skill. Marked pi-only.
  - **Peer plumbing** — `peers.yaml` peer entries gain an optional `extensions:` field; `team-up.ts` routes such peers through a new `just _peer-plus <extensions> …` recipe that loads the named `.pi/extensions/` into the peer process alongside coms + compact-and-continue. The `web-debugger` peer is wired into the `full` and `web` teams.
