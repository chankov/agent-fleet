# Agent Fleet — Project Files

agent-fleet keeps a few small files in a project's `.ai/` directory. They have
different readers and different lifetimes, so they are kept separate.

| File | Read by | When |
|------|---------|------|
| `.ai/agent-fleet-overrides.md` | `spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`, `git-workflow-and-versioning`, `compound-learning` (the `rules:`/`docs:` keys of `## agent-hub`), `agent-hub` pi harness | Every run of those skills / every session start of the harness |
| `.ai/agent-fleet.json` | the deterministic `agent-fleet` lifecycle (`setup`) — human-owned desired state (preset/features); intended to be committed | Every setup plan; created/updated when setup persists desired state or migrates legacy installs |
| `.ai/agent-fleet-state.json` | the deterministic `agent-fleet` lifecycle (`setup`, `doctor`, `uninstall`) | Every lifecycle plan and apply |
| `.ai/agent-fleet-setup.md` | humans — rendered from the state file, never parsed back | Rewritten on every setup apply |
| `.ai/agent-fleet-transaction.json` | the deterministic lifecycle (`setup`, `doctor --fix`) — crash-recovery journal for in-flight file transactions | Written during apply; recovered or discarded by setup/doctor; removed when the transaction commits or is cleaned up |
| `.ai/stt.json` *(optional)* | `pi-voice-stt` extension | Every pi session start, when the extension is installed |

The `.ai/stt.json` file is present only when the optional `pi-voice-stt` voice-dictation
extension has been configured (by deterministic setup or by hand). Like the overrides file it holds
**no secrets** — it names the env vars (`apiKeyEnv`, plus the Azure endpoint var) whose values
live in a gitignored root `.env`. See [pi-voice-stt config](#ai-sttjson) below.

Keep them split: the overrides file is loaded into context constantly, so it
must stay minimal; the install record is read only by the CLI, so it can be
large.

## Unified Fleet runtime configuration

A Pi workspace has one public runtime entry point. Bare Fleet loads Fleet Core
plus Agent Hub in **operator** work mode, in the current terminal, with no native
specialists active:

```bash
just fleet
just fleet --project af
```

Work mode, native roster, and peer topology are separate controls:

```bash
# Direct tools plus an available native roster.
just fleet --work-mode operator --agents frontend --project af

# A roster implies orchestrator when work mode is not explicit.
just fleet --agents frontend --project af

# Herdr Hub-only and Hub-plus-peer topologies.
just fleet --herdr --project af
just fleet --agents frontend --peers frontend --project af
```

Startup precedence is deterministic: explicit `--work-mode` wins; otherwise an
explicit `--agents` roster implies `orchestrator`; otherwise work mode is
`operator`. An orchestrator startup must name a roster. `--herdr` affects only
placement, while `--peers <preset>` implies Herdr and starts the selected peer
preset. Neither topology option selects a native roster.

`--project <name>` selects one coms namespace for the Hub and every standing or
dynamically spawned peer. Dynamic peer tools deliberately expose no project
override, so an agent cannot cross that boundary. The default project is
`default`; use an explicit project when multiple fleets share a machine.

The configuration files have distinct ownership:

| File | Controls |
| --- | --- |
| `.pi/agents/teams.yaml` | Named **native rosters** of Pi personas available to `dispatch_agent`. Bare Fleet ignores YAML ordering and starts empty; select one with `--agents`, `/af-agents-team`, or add individuals with `/af-agents-add`. |
| `.pi/agents/peers.yaml` | Named **standing peer presets** and each peer's runner (`pi` or `claude-code`), persona, model, extensions, and optional declared `env_file`. Select a preset with `--peers`; dynamic `herdr_spawn_peer` uses the same declaration resolver. |
| `.pi/agents/dispatch-policy.yaml` | Routing used only when `dispatch_agent.backend` is `auto`: native/coms preference, fallback, grace period, and peer reply timeout. |
| `.ai/agent-fleet-overrides.md` (`## agent-hub`) | Project-specific Hub language, model overrides, rule/doc roots, budget ceilings, watchdog, and related execution policy. It does not choose startup work mode or topology. |

For deterministic routing, `backend: "native"` always starts the local Pi
specialist even if a same-name peer is visible. `backend: "coms"` requires a
visible same-name peer and refuses without native fallback. The default
`backend: "auto"` follows `dispatch-policy.yaml` and preserves its configured
fallback behavior.

Capability packs load automatically—do not run an activation command. Explicit task intent activates the matching ready surface; readiness alone never exposes coms or Herdr tools to the model. Ambiguous fleet/peer/workspace intent gets one confirmation before its first side effect, and active task packs persist until the explicit `set_task_tier(new_task: true)` reset.

Capability flags and runtime gates fail closed:

- `--no-coms` keeps operator direct tools and native dispatch available, but
  peer dispatch, `coms_send`/`coms_await`, and `/af-handoff` refuse actionably.
- `--herdr` and `--peers` require a running [Herdr](https://herdr.dev) server.
  Without Herdr, bare Fleet still works and dynamic pane tools stay inactive.
- `--browser` adds the browser extension surface and `--all-extensions` opts
  into the complete approved extension set. Missing optional dependencies do
  not grant tools merely because a flag was supplied.
- Hub-owned slash commands remain registered in both work modes. A missing coms
  runtime, Herdr connection, target peer, or native roster produces a
  capability refusal rather than a missing command.

During the migration release, `just fleet hub`, `just fleet team <preset>`,
`just fleet team <preset> --no-hub`, and `--solo` remain accepted and print a
canonical replacement. New automation should use `just fleet` with
`--agents`, `--peers`, `--herdr`, and `--no-coms`; compatibility does not imply
that the deprecated grammar will remain indefinitely.

### Resume and recovery

The Hub distinguishes the **pre-turn surface** (stable replacement prompt, volatile state capsule,
and active tool schemas) from **intra-turn pressure** (conversation and tool results accumulated in
the live model window). `/af-context` shows both. At 80% live usage the Hub warns and transiently makes
compaction support available; at 90% it blocks the next provider continuation and requests a
single automatic compaction after the current result is persisted. A prompt submitted during
startup/recovery is retained in memory and replayed once after success.

If automatic recovery fails, the prompt remains retained. Pi's built-in command is the bare-runtime
fallback:

```text
/compact Preserve the current goal, decisions, modified files, pending operations, blockers, and next step.
```

You can also switch to a larger-context model. Do not try to make room by editing the session file.
The JSONL shown by `/session` under `~/.pi/agent/sessions/` is Pi's authoritative append-only record;
resume with `/resume`, `pi -c`, or `pi --session <path|id>`. Never edit, truncate, reorder, or add
synthetic entries to recover from context pressure.

A resumed orchestrator session may instead be blocked because its persisted team name no longer
resolves against the current `.pi/agents/teams.yaml` and persona files. This is a fail-closed roster
recovery gate: orchestrator work mode and its direct-tool restrictions remain in force. Choose a valid
team with `/af-agents-team`, restart publicly with `just fleet --agents <name>`, or explicitly choose
operator work mode with `/af-work-mode operator` / `just fleet --work-mode operator`. Direct Pi launches
use `--agent-team <name>` or `--work-mode operator`. Explicit startup flags win over persisted state;
fix missing or renamed team/persona declarations before selecting them.

## The overrides file — `.ai/agent-fleet-overrides.md`

Some skills and pi harnesses need facts specific to each project — where specs
and plans are saved, how to start a dev server, whether the agent may create
branches, or which user-facing language a dispatcher should use. Each reader
ships a sensible **default**; a project that needs something different declares
it here, and the reader picks it up.

- **Location:** `.ai/agent-fleet-overrides.md` at the project root.
- **Format:** Markdown. One `## <section-name>` section per skill or harness reader, with terse
  `key: value` lines. Block values use the `key: |` multi-line form. No prose
  and no install detail — readers parse it by key and load it on every run/session start.
- **Commit it.** Shared project configuration belongs in version control. Make
  sure no `.gitignore` rule (for example a broad `.env*` pattern) excludes it.
- **No secrets.** For anything sensitive (test-account credentials), reference
  the **name** of an environment variable; the real value lives in a gitignored
  `.env`.
- If the file is absent, or a reader has no section in it, that reader uses its
  built-in default.
- **Validation.** Because an unknown section or key silently falls back to the
  default, typos are invisible at runtime. `agent-fleet doctor` (and the
  runtime's Agent Fleet doctor command) validates the file — unknown sections,
  unknown keys in known sections, invalid values for the mechanically parsed
  `agent-hub` keys, missing `rules:` folders, missing `append-prompt:` files,
  unknown `poll-panel:` names, and unset `## env` vars — as
  **advisory, warn-only findings**; it never edits the file.

### `spec-driven-development`

| Key | Default | Meaning |
|-----|---------|---------|
| `spec-dir` | `docs/prds/{area}` | Directory specs are written to |
| `naming` | `PRD{n}-{topic}` | File name pattern; `{n}` = next free PRD number, `{topic}` = kebab-case slug |

Default output: `docs/prds/{area}/PRD{n}-{topic}.md`.

### `planning-and-task-breakdown`

| Key | Default | Meaning |
|-----|---------|---------|
| `plan-dir` | `docs/plans/{area}` | Directory plans are written to |
| `naming` | `PLAN-{prd-name}-{phase}` | File name pattern; `{phase}` suffix only when a plan spans multiple files |
| `todo` | `embedded` | `embedded` keeps the task list inside the plan; `separate` writes a standalone `todo.md` |

Default output: `docs/plans/{area}/PLAN-{prd-name}-{phase}.md`, task list embedded.

### `browser-testing-with-devtools`

This skill has **no default** — the section is required for browser testing,
because dev-server commands and login flows cannot be guessed.

| Key | Meaning |
|-----|---------|
| `dev-server` | Command to start the local dev server |
| `ready-check` | How to confirm the server is up |
| `base-url` | Root URL for navigation |
| `auth-flow` | Steps to log in (multi-line `|` block) |
| `roles` | Test account per privilege level, referenced by env-var name |
| `notes` | Anything else the agent should know (certs, seed data, ...) |

### `git-workflow-and-versioning`

| Key | Default | Meaning |
|-----|---------|---------|
| `branching` | `never` | `never` = agent works in the current branch and never creates or switches branches; `allow` = agent may create feature branches |

### `agent-hub`

Read by the `.pi/harnesses/agent-hub/` pi harness on every session start. The canonical
section name is `## agent-hub`; the harness also accepts the legacy `## agent-team` name
(from before the standalone `agent-team` harness was retired), so existing project
override files keep working unchanged. When both sections are present their keys merge,
with later lines winning.

The `rules:` and `docs:` keys are also read outside the harness: the `compound-learning`
skill (and the `/af-compound` agent-hub command built on it) resolves them as the
targets an end-of-session compound pass writes lessons to.

| Key | Default | Meaning |
|-----|---------|---------|
| `language` | `English` | User-facing language the dispatcher uses for every `ask_user` question, every `context` field, and every summary. Specialist task strings always stay in English regardless. |
| `persona-gate` | — | **Removed.** Ignored with a doctor warning; dispatcher flavor is no longer selectable. Use `/af-work-mode` for operator vs orchestrator. Delete the key. |
| `model.<persona>` | persona frontmatter `model:` | Replaces the named persona's default model for this project (a full pi model spec). If the override reports a model/provider error or aborted request before producing text or starting a tool (including a local-model memory-limit failure), agent-hub restores the child session and retries once with the original frontmatter model; it does not fallback after work starts, cancellation, timeout, drift stop, or process-spawn failure. |
| `models.<persona>` | persona frontmatter `models:` | Replaces the named persona's model-candidate list for `/af-agent-model` and `/af-models` profiles (comma-separated pi model specs). |
| `thinking.<persona>` | persona frontmatter `thinking:` | Replaces the named persona's pi `--thinking` reasoning level for this project: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Switchable at runtime with `/af-agent-model-thinking <persona>`. An invalid value is ignored with a session-start warning. |
| `subagents.<persona>.<role>` | persona frontmatter `subagents:` | Replaces or adds one delegate sub-role for this project: `<model>[, tools=<caps>]`. Other declared roles keep their frontmatter values. Existing roles retain their original frontmatter model as the same one-shot, pre-work-only runtime fallback; model-only overrides retain the declared tool cap. |
| `delegate-depth.<persona>` | persona frontmatter `delegate_depth:` (default/max 1) | Replaces the persona's delegation depth budget: `0` makes its delegate tool refuse (delegation off for this project), `1` lets it spawn terminal children. Values above 1 are clamped to 1; children at remaining depth 0 do not receive delegate tooling. |
| `rules` | none | Comma-separated repo-relative folders holding the project's own rule files (HOW — implementation patterns the work must comply with). Resolution is **index-first**: when a folder has a top-level `README.md`/`index.md`, personas read it first and follow its loading manifest (session bundles, conditional-load lists) instead of bulk-reading the tree; a folder without an index is searched **recursively** through all subfolders. The harness tells every dispatched specialist where the rules live and how to resolve them; the planner and code-reviewer personas read the relevant rules, validate their subject against them, and pass them on (cited in plan acceptance criteria / handed to delegate sub-reviewers). Missing folders produce a session-start warning. |
| `docs` | none | Comma-separated repo-relative documentation **entry points** (WHAT/WHY — architecture, standards, decisions): canonical files (e.g. `Docs/AGENTS.md`) or doc folders (personas start from a folder's `README.md`/index). Unlike `rules`, docs orient rather than bind: every dispatched specialist and research helper is told to read the entry points relevant to its task and follow their links instead of bulk-reading doc trees; the code-reviewer flags changes that alter documented behavior without a doc update; the documenter treats the entry points and the trees they link as the docs it maintains. Missing paths produce a session-start warning. |
| `research-keep` | `4` | How many **finished** durable/persona research helpers the hub retains (LRU by finish time) for dashboard inspection or a fresh `/af-agents-restart rN`; older ones are pruned along with their session files. `all` disables the cap. Auto-research pipe helpers (spawned for `NEEDS_RESEARCH:` pauses) are always pruned as soon as they finish — their findings persist as files under `.pi/agent-sessions/findings/`. Running helpers are never pruned. An invalid value is ignored with a session-start warning. |
| `recon-search-timeout-s` | `120` | Parent-side deadline, in seconds, for each `read`, `grep`, `find`, or `ls` call made by a native research helper or nested delegate child. Accepts an integer `1`–`3600` or `off`; invalid input warns and falls back to `120`. This is **not** an agent/turn deadline: non-tool work can run indefinitely. On timeout the hub returns `tool_timeout` with call metadata, sends SIGTERM to its owned process group, escalates to SIGKILL after a finite grace period, and settles even if the child never closes or a descendant holds a pipe. If that bounded cleanup cannot confirm child/process-group death, the metadata reports `terminationConfirmed: false`; this prevents a parent hang but may indicate an uninterruptible OS-level process needing operator attention. |
| `mode` | — | **Removed.** Ignored with a warning; budgets follow task tier. Delete the key. |
| `max-dispatches-per-turn` | tier default (1/2/8/12) | Ceiling on `dispatch_agent` calls per user turn (`min` with the task-tier envelope). Positive integer or `off` (stays at the tier). |
| `max-research-per-turn` | tier default (1/2/4/6) | Ceiling on dispatcher-initiated `spawn_research` calls per user turn. The automatic `NEEDS_RESEARCH:` pipe is exempt from the turn budget but still counts against the task research envelope. Positive integer or `off` (stays at the tier). |
| `turn-wall-time-s` | tier default (900/900/3600/5400) | Active-time ceiling, in seconds, per user turn; time blocked in `ask_user` is excluded. Once exceeded, further dispatch/research calls refuse until the one-click continuation is accepted or a new user turn begins. Positive integer or `off` (stays at the tier). |
| `agent-turn-timeout-s` | tier default (600/600/1800/1800) | Whole-run deadline, in seconds, for each spawned specialist, research helper, and nested delegate child (unlike `recon-search-timeout-s`, this bounds the entire run). On expiry the run terminates as `turn_timeout` (exit 124) with partial output preserved. Positive integer or `off` (stays at the tier). |
| `session-recycle-runs` | tier default (3/3/5/5) | Recycle a specialist's accumulated session (fresh spawn instead of `-c` resume) after this many resumed runs. Context is also always recycled at ≥60% measured context (input + cacheRead + cacheWrite). Positive integer or `off` (stays at the tier recycle count; context threshold still applies). |
| `watchdog` | `auto` | Drift watchdog default for dispatched specialists: `auto`/`on` arm the in-flight rules (out-of-scope writes, tool-call loops, repeated failures, tool-call cap) with LLM-judge escalation; `off` disarms. Orchestrator work mode auto-arms when the setting is `auto`/`on` and ignores a dispatch `watchdog: false`. Overridable live per hub (`/af-watchdog on\|off\|auto`) and per agent (`/af-watchdog <agent> on\|off\|clear`). A DRIFTING/STUCK verdict terminates the run as `drift_stop` (exit 125) with partial output preserved. |
| `watchdog-judge-model` | researcher persona's model | pi model spec for the one-shot drift judge (e.g. `openai-codex/gpt-5.3-codex-spark`). Falls back to the researcher persona's resolved model, then the dispatcher's. |
| `poll-panel` | none | Default panel name for `/af-poll` when `--panel` is omitted. Must match a panel in `.pi/agents/voices.yaml` when that file exists. Missing `--panel` and missing this key is a refusal. |
| `append-prompt` | none | Comma-separated repo-relative files appended to the system prompt of every dispatched persona. Listed files must exist. Enable the communication contract with `append-prompt: references/communication-contract.md`. |

Example — switch the dispatcher to Bulgarian, pin the builder to sonnet, raise the
code-reviewer's thinking level, move the code-reviewer's docs sub-reviewer to a
different model, and point the team at the project's rule folders and doc entry
points:

```markdown
## agent-hub
language: Bulgarian
model.builder: github-copilot/claude-sonnet-4.6
models.builder: github-copilot/claude-sonnet-4.6, github-copilot/claude-haiku-4.5
thinking.code-reviewer: xhigh
subagents.code-reviewer.docs: github-copilot/claude-sonnet-4.6, tools=read,grep
delegate-depth.code-reviewer: 1
recon-search-timeout-s: 120 # or off to disable the per-tool watchdog
poll-panel: default
append-prompt: references/communication-contract.md
rules: docs/rules, .ai/rules
docs: Docs/AGENTS.md, Docs/architecture/ARCHITECTURE_OVERVIEW.md
```

### `env` (optional, read by the doctor)

The overrides file references environment variables by **name** — test-account
credentials for `browser-testing-with-devtools`, the `pi-voice-stt` API key —
while the values live in a gitignored root `.env`. The optional `## env`
section declares which names the project's readers expect, so a fresh clone
can find out what's missing *before* a skill fails mid-run:

| Key | Meaning |
|-----|---------|
| `required` | Comma-separated env-var **names** (never values) the project's sections reference |

```markdown
## env
required: APP_TEST_ADMIN_USER, APP_TEST_ADMIN_PASS, AZURE_SPEECH_KEY
```

No skill or harness loads this section. Its only reader is `agent-fleet doctor`
(and the runtime's Agent Fleet doctor command), which warns when a declared name is neither set in
the environment nor declared in the workspace root `.env`.

### Per-peer env files (`env_file:` in peers.yaml)

Fleet peers spawned through `--peers`, `just fleet peer`, or the Hub's
constrained dynamic peer tool can carry their own environment: an `env_file:`
entry in `.pi/agents/peers.yaml` names a
**repo-relative** KEY=VALUE file (same format as `.env`, no shell evaluation)
that herdr injects into the peer's pane before the command runs — no `source`,
no leaking into sibling panes. The file must exist at spawn (team-up refuses
otherwise, never mid-run), and its **values never appear in `--dry-run`
output** — only the path. Keep these files gitignored exactly like the root
`.env` this section describes.

## The install record — `.ai/agent-fleet-state.json` and `.ai/agent-fleet-setup.md`

Two files, one source of truth. `.ai/agent-fleet-state.json` is what the
installer writes and the only thing it reads back: agent, method, package
version, source root, and one entry per installed item with a per-file sha256
(or, in symlink mode, the resolved link target). `.ai/agent-fleet-setup.md` is
**rendered from it** on every apply and never parsed back, so the two cannot
disagree — it exists for humans and for older readers that still look for
`version:` and `agent:`.

Ownership is the point of the state file. An entry means "agent-fleet installed
this"; anything not listed is never removed or overwritten. That lookup is what
replaced the prose ownership rule the setup skill used to carry.

| State-file field | Meaning |
|---|---|
| `agent`, `method`, `sourceRoot` | How and from where this workspace was installed |
| `packageVersion` | The version that performed the last apply — provenance for reconciliation and legacy three-way compatibility |
| `items` | One entry per installed artifact: strategy, method, files with hashes, JSON key paths |
| `externalPackages` | Packages the user was told to install; recorded, never installed for them |
| `events` | Last few applies (verb, version, action count, conflicts) |

**No secrets, ever.** Only env-var *names* may appear — for example in the
`pi-voice-stt` record. A test asserts nothing value-shaped is persisted.

### The recorded version and the three-way merge

The recorded `packageVersion` gives every comparison a baseline. For each
recorded artifact, the engine compares *source@recorded* from the package's
`.versions/<x.y.z>/` snapshot tree, the installed copy on disk, and
*source@current*. Deterministic `setup` is the public reconciliation command.

| Outcome | What `setup` does |
|---|---|
| Neither moved | Kept |
| Only the source moved | Clean refresh |
| Only your copy moved | **Refreshed — your edit is overwritten.** Reported in the plan as *"locally modified — selecting it overwrites your edits"*, so `--dry-run` shows it before it happens |
| Both moved, to different content | **Conflict**: the run exits `3` before writing anything. Resolve with `--on-conflict theirs` or `--on-conflict ours` |
| Retired upstream | Kept by `setup`; the deprecated `upgrade` proposes removal by name, subject to the ownership rule |

Reconciling toward the package is the point of `setup`: the workspace is meant
to match the version it records. That is why editing a shipped artifact in place
is not a supported customization route — use `.ai/agent-fleet-overrides.md`, add
artifacts under names Agent Fleet does not ship, or leave the item out of the
selection (`setup` never removes what it does not select, so an unselected item
stays installed and frozen). The deprecated `upgrade` verb preserves local edits
instead of overwriting them; if you have relied on that, it is the behavioural
difference to plan for.

If the snapshot is missing (an unpublished local build, or a version older than
`.versions/` retention), the comparison degrades to two-way, the installed copy
is treated as canonical, and the read-only auxiliary `verify` command reports it
as an advisory finding rather than pretending a diff exists.

### Pre-engine workspaces

A workspace with only `.ai/agent-fleet-setup.md` and no state file predates the
installer engine. `setup --migrate --dry-run` previews what it can infer from
that markdown (`agent:`, `version:`) without adopting unrecorded paths. To
mutate a legacy workspace, use `setup --migrate` with an explicit preset,
features, and `--yes`. A workspace with no `version:` at all has no recorded
baseline, so no three-way merge is attempted.

Commit these files if the team should share install state — keep paths relative
so they stay portable. A self-referencing checkout (agent-fleet itself) may
instead `.gitignore` them, since their recorded paths are local to one machine.

## Coms-backed team members

A team member the `agent-hub` harness dispatches (`.pi/agents/teams.yaml`) can be
served by a live coms peer of the same name instead of a freshly spawned native
subagent. With the default `backend: "auto"`,
`.pi/agents/dispatch-policy.yaml` decides that per member at dispatch time;
explicit `native` bypasses substitution, while explicit `coms` requires the
peer and never falls back. `.pi/agents/peers.yaml` decides *how* each peer runs.
A peer with `runner: claude-code` is an interactive Claude Code pane plus its
bridge — the one way Claude Code takes part in a fleet. See
[claude-code-coms-bridge.md](claude-code-coms-bridge.md).

Installing `skill:peer-coms` pulls `hook:coms-stop-hook` in as a companion, which
is what gives a bridged pane exact turn text instead of scraped output.
Registering that hook in `.claude/settings.json` stays the user's step — the
installer writes files, and another tool's settings file is not its to merge.

## Templates

### `.ai/agent-fleet-overrides.md`

Copy this in and delete the sections you don't need — anything absent falls
back to that reader's default.

```markdown
# Agent Fleet — Project Overrides
#
# Each section is applied ON TOP of the skill's built-in defaults.
# Keys not listed keep the default. Absent file/section → pure defaults.

## spec-driven-development
spec-dir: docs/prds/{area}
naming:   PRD{n}-{topic}

## planning-and-task-breakdown
plan-dir: docs/plans/{area}
naming:   PLAN-{prd-name}-{phase}
todo:     embedded

## browser-testing-with-devtools
dev-server:  <command to start the local dev server>
ready-check: <url or check that confirms the server is up>
base-url:    <root url>
auth-flow: |
  1. Navigate to <login url>
  2. Submit credentials for the role needed by the screen under test
roles:
  admin:  env APP_TEST_ADMIN_USER / APP_TEST_ADMIN_PASS
  player: env APP_TEST_PLAYER_USER / APP_TEST_PLAYER_PASS
notes: |
  <anything else: self-signed certs, required seed data, ...>

## git-workflow-and-versioning
branching: never

# Optional for pi agent-hub; omit this section to keep default English.
# (`## agent-team` is still accepted as a legacy alias for this section.)
## agent-hub
language: <language name>
rules: <repo-relative rule folder>[, <another folder>]
docs: <repo-relative doc entry point>[, <another file or folder>]

# Optional; names (never values) of env vars the sections above reference.
# Only `agent-fleet doctor` reads this — it warns when one is unset.
## env
required: <ENV_VAR_NAME>[, <ANOTHER_NAME>]
```

### `.ai/agent-fleet-setup.md`

Rendered from `.ai/agent-fleet-state.json` by every apply, for humans to read.
Edit the workspace, not this file — the next apply overwrites it.

```markdown
# Agent Fleet — Workspace Setup
#
# Generated from .ai/agent-fleet-state.json by `agent-fleet setup`.
# Edit the workspace, not this file: it is rewritten on every apply.

## workspace-summary
agent:   pi
method:  copy
version: 1.4.2
source:  /home/you/.npm/_npx/<hash>/node_modules/@chankov/agent-fleet

## install-status
skills:     [spec-driven-development, test-driven-development, code-review-and-quality]
commands:   [spec, plan, build]
personas:   [code-reviewer]
extensions: []
harnesses:  []
companions: [skills-internal-grilling]
external:   []
updated:    2026-05-22

## verification
- 21 item(s) recorded; run `agent-fleet doctor` for diagnostics.
- No secrets are stored in this file or in .ai/agent-fleet-state.json.
```

### `.ai/stt.json`

Optional. Present only when the `pi-voice-stt` extension is installed and configured. Read by
the extension on every pi session start, ahead of the global `~/.pi/agent/stt.json`. Holds the
non-secret provider config; the API key (and Azure endpoint) live in a gitignored root `.env`
as named env vars, which the `justfile`'s `dotenv-load` exposes to the session.

```json
{
  "language": "bg-BG",
  "provider": {
    "type": "azure",
    "apiKeyEnv": "AZURE_SPEECH_KEY",
    "locales": ["bg-BG", "en-US"]
  }
}
```

Corresponding gitignored `.env` at the repo root:

```sh
AZURE_SPEECH_ENDPOINT=https://<resource>.cognitiveservices.azure.com
AZURE_SPEECH_KEY=<your-resource-key>
```

For the OpenAI-compatible backend, `provider.type` is `openai` with `baseUrl` / `model` and an
`OPENAI_API_KEY` env var instead. Full schema: [.pi/extensions/pi-voice-stt/README.md](../.pi/extensions/pi-voice-stt/README.md).
