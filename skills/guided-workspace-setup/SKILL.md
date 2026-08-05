---
name: guided-workspace-setup
description: Guides installation of agent-fleet artifacts into a target workspace. Use when onboarding a project to agent-fleet, when installing skills, commands, prompts, personas, or pi extensions for a chosen coding agent, or when a workspace needs its setup files configured.
---

# Guided Workspace Setup

## Overview

A conversational front-end over the `agent-fleet` CLI's deterministic installer. The CLI decides
paths, states, merges, ownership, and writes — this skill asks the questions a program cannot
answer: which artifacts this project wants, what belongs in its overrides file, and which speech
provider to configure. Everything else is `agent-fleet <verb> --json`.

**You never write an install target yourself.** No copying, no symlinking, no path tables, no
merge rules. If you find yourself about to write into `.claude/`, `.pi/`, or the
`justfile`, you are in the wrong place — call the CLI.

## When to Use

- Onboarding a project to agent-fleet, or changing which artifacts it uses
- Re-running setup to add, upgrade, repair, or remove artifacts
- Authoring or revising `.ai/agent-fleet-overrides.md`

**NOT for:** authoring new skills or personas (`designing-agents`); editing artifacts inside the
agent-fleet repo itself; general rules-file tuning (`context-engineering`).

## Process

### 1. Resolve the source root and agent

Run the CLI from the agent-fleet package the user actually installed:

1. `<workspace>/.ai/.agent-fleet-bootstrap.json` → its `sourceRoot`. Authoritative; written by
   `npx @chankov/agent-fleet init`. If the path no longer exists, say so and go to 3.
2. This `SKILL.md`'s realpath, if it is a symlink. Never its *workspace* location — bootstrap
   copies the file into `.pi/skills/…`, so that path is the target, not the source.
3. Ask. **Never scan the filesystem for agent-fleet clones** — it finds forks and stale checkouts,
   not the package the user installed from.

Confirm the workspace path exists. The agent (`claude-code` / `pi`) comes from the
recorded state; pass `--agent` only to override it.

### 2. Read the workspace's current state

```
node <source-root>/bin/cli.js verify --workspace <workspace> [--agent <agent>] --json
```

One command, everything you need: `groups` (menu headings, agent-filtered), `profiles` (the
shortcuts), and `items` — each with `id`, `group`, `subcategory`, `title`, `summary`,
`recommended`, `consent`, `owned`, and `state`. Plus `findings`, `recordedVersion`, and
`summary.versionDrift`.

The states are the CLI's, not yours: `absent`, `up-to-date`, `linked`, `outdated`, `modified`,
`conflict`, `missing`, `broken-link`, `foreign-link`, `partial`, `gone`, `not-applicable`.
Do not compute, guess, or re-derive them.

If `findings` is non-empty or any item is broken, offer `doctor --fix` before the menu — a broken
workspace makes the menu lie about what is installed.

### 3. Ask what to install

Present the `items` grouped by `group`, chunked by `subcategory`. Interaction mode:

- **pi** → the `ask_user` widget from the external `pi-ask-user` package. If it is missing, offer
  to install it (`pi install -l npm:pi-ask-user`), then **stop the pass** and ask the user to
  reload and re-run — the widget is not callable until then. If they decline, use the text
  fallback.
- **claude-code** → `AskUserQuestion` (max 4 options per call).
- **anything else** → print a compact table and take a text reply.

Screen budget: ≤ 8 context lines, ≤ 9 options per call (≤ 4 on `AskUserQuestion`). Options carry
the data — `{title, description}`, never a table pasted into `context`. Titles are
`<title> ★ [state]`; descriptions say what picking it does in plain words ("update available",
"locally modified — installing overwrites your edits"). Long material (diffs, changelog, the plan)
prints as agent text *before* the call, with `displayMode: "inline"` so it stays visible.

Open with one Express single-select that can resolve the whole menu — the `profiles` map supplies
the shortcuts (`recommended`, `full`, `minimal`, `pi-fleet-core`, …). Group screens run only on
`Custom`. Cancel is a no-op everywhere except the final confirmation.

**Selection never removes.** Leaving an installed item unpicked keeps it. Removal is its own
explicit screen, and it runs `uninstall --items`.

### 4. Offer project overrides *(this is genuinely yours)*

Scan the workspace — language, framework, test runner, dev server, rule-file trees, doc entry
points — and propose draft sections for `.ai/agent-fleet-overrides.md`:
`spec-driven-development`, `planning-and-task-breakdown`, `browser-testing-with-devtools`,
`git-workflow-and-versioning`, and for `pi` with `agent-hub` selected, `## agent-hub` (a legacy
`## agent-team` section keeps its name — preserve, never duplicate).

In `## agent-hub`, offer `language:` (default `English`, preserving any existing value) and the
project-knowledge keys **only when the scan finds matching material** — `rules:` for a rule-file
tree (`.ai/rules/`, `docs/rules/`, `.cursor/rules/`; point at the tree root, which resolves
index-first), `docs:` for canonical WHAT/WHY entry points. An empty guess sends every specialist
hunting for files that are not there.

Terse `key: value` lines only — the lifecycle skills and `agent-hub` parse this file on every run.
Reference env-var *names*; secrets stay in a gitignored `.env`. When any section names env vars,
offer an `## env` section with `required: <NAME>[, <NAME>]`. Schema: `docs/agent-fleet-setup.md`.

Print each draft as agent text, then ask `Accept` / `Edit` / `Skip` per section (or one
multi-select when there are more than two). This file is yours to write directly — it is not an
install target.

### 5. Configure `pi-voice-stt`, if selected *(also genuinely yours)*

The extension is a no-op until a provider is configured, and the CLI reports it as an operator
step rather than inventing one. Offer — never force — the Q&A:

- **Azure Speech** (`type: azure`) — resource endpoint, optional `locales` for per-phrase language
  ID (e.g. `["bg-BG","en-US"]`). Env: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_ENDPOINT`.
- **Azure OpenAI Whisper** (`type: azure-openai`) — best for mixed-language speech. `endpoint`,
  Whisper `deployment`, `apiVersion` (default `2024-10-21`). Use the legacy data-plane host
  `https://<resource>.openai.azure.com` (or `…cognitiveservices.azure.com`) — transcription 404s
  on the Foundry `…services.ai.azure.com` host. Env: `AZURE_OPENAI_API_KEY`,
  `AZURE_OPENAI_ENDPOINT`; offer `apiKeyEnv: AZURE_SPEECH_KEY` when the key is shared.
- **OpenAI-compatible** (`type: openai`) — `baseUrl` (default `https://api.openai.com/v1`; a
  `http://127.0.0.1:*/v1` loopback is fine for local whisper), `model` (default `whisper-1`).
  Env: `OPENAI_API_KEY`.

Write `<workspace>/.ai/stt.json` with the non-secret config and `apiKeyEnv` — **never a key
value** — and append the referenced names to the repo-root `.env` as empty placeholders only if
absent, never overwriting. Ensure `.env` is gitignored. On removal, delete `stt.json` only if
unedited; never touch `.env`.

### 6. Apply

```
node <source-root>/bin/cli.js install --workspace <ws> --agent <a> \
  --profile <name> | --items <id,…> [--allow-exec] --yes --json
```

`upgrade` for a version bump (three-way merge, preserves local edits, `--accept-theirs` /
`--accept-ours` for conflicts), `uninstall --items <id,…>` for removals, `doctor --fix` for
repairs. Add `--dry-run` first when the user wants to see the plan; `--json` requires `--yes`.

Print the plan as compact action-grouped lines before the confirm — `Add (N): …`,
`Refresh (N): …` (append *overwrites local edits* when the plan reports `overwrites`),
`Remove (N): …`, `Keep (N)` as a count, `Method:`. When `versionDrift` is set, lead with
**"Changes since v<recorded> → v<current>"** and short bullets from `CHANGELOG.md`. Then one
`inline` single-select: `Apply — and remove the installer commands` (default) /
`Apply — keep the installer commands` / `Adjust picks` / `Cancel`.

Exit codes are the contract: `0` done, `1` error, `2` findings, `3` conflicts. On `3`, the CLI
wrote `<file>.new` beside each conflicted file and touched nothing else — show the list and let
the user resolve, or re-run with `--accept-theirs` / `--accept-ours`.

Artifacts install as copies. There is no copy-vs-symlink question to ask — symlinks exist only
inside an agent-fleet checkout, and a workspace that recorded them before that is migrated to
copies by the CLI on this run. Never offer the choice, and never pass `--method`.

`--allow-exec` covers the `npm ci` steps for `.pi/extensions` and `.pi/harnesses`; ask before
passing it. `external` and `operator` actions carry their own instructions in the plan output —
relay them verbatim; the CLI performs none of them, and neither do you.

### 7. Clean up and report

Unless the user chose to keep them:

```
node <source-root>/bin/cli.js cleanup-installer --agent <agent> --workspace <workspace>
```

Then `verify` once more and report what changed, plus the one-line cleanup outcome
("Installer slash commands removed — `npx @chankov/agent-fleet init` restores them", or the
retained command names). Point the user at `.ai/agent-fleet-overrides.md` and suggest loading
`using-agent-skills` first next session.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll copy this one file myself — calling the CLI for it is overkill." | Then it is not recorded in `.ai/agent-fleet-state.json`, so `verify` calls it unowned, `upgrade` skips it, and `uninstall` refuses to remove it. The state file is what makes any of this reversible. |
| "The installed file looks different from the source, so it's modified." | `modified`, `outdated`, and `conflict` are three different answers with three different consequences, and they need the recorded hash and the version snapshot to tell apart. Read `state` from `verify --json`. |
| "The user picked a narrower profile, so I'll remove what's no longer in it." | Selection never removes. Removal is `uninstall` with named items, and only after an explicit remove screen. |
| "The plan says `conflict` — I'll take the new version, it's newer." | Exit `3` means both sides changed. The `.new` file exists so a human decides. `--accept-theirs` is the user's call to make, not yours. |
| "I'll run `npm ci` for the extensions — it's obviously needed." | It is an `exec` item, gated on `--allow-exec`. Running commands in someone's repo is a consent boundary, not a formality. |
| "The Hermes plugin just needs a symlink into the profile directory — I can do that." | Operator items exist because their targets are outside the workspace: a Hermes profile, a user systemd unit, a running gateway. Relay the declared steps; perform none of them. |
| "The user is on `pi` and `pi-ask-user` is missing — I'll use the text fallback." | Offer the install-then-reload bootstrap first. A ~50-row menu through plain text is the experience that widget exists to replace. Fall back only if they decline. |
| "I installed `pi-ask-user`, so I'll keep going in the same pass." | It is not callable until pi reloads. Stop, ask them to reload and re-run. |
| "The user didn't tick that installed item in the drill-in, so remove it." | Not selecting means keep as-is. An accidental non-pick must never delete anything. |
| "They pressed `esc` — I'll take the defaults and continue." | Cancel is skip/no-op on every screen except the final confirm, where it means do not apply. |
| "I'll write the install detail into the overrides file too — one place is simpler." | Every skill and every `agent-hub` session loads the overrides file. Install detail lives in the state file, which nothing loads at runtime. |
| "There's no rule-file tree, but `rules:` looks incomplete without a value." | An invented path sends every specialist hunting for files that do not exist. Skip the key. |
| "The user asked for symlinks so `git pull` updates everything." | Symlinks are checkout-only now: outside one, the link target has to stay put forever, an npx cache clean breaks every link at once, and a source `git pull` rewrites artifacts nobody agreed to change. `agent-fleet upgrade` gives the same freshness with a real three-way merge. Say that, don't pass `--method`. |
| "I'll put the Azure key in `stt.json` — it's in `.ai/`, that's fine." | `.ai/` is committed. The config names an env var; the value lives in a gitignored `.env`. |

## Red Flags

- Any write by this skill into `.claude/`, `.pi/`, `agents/`, or the `justfile` —
  those are the CLI's, exclusively. Only `.ai/agent-fleet-overrides.md` and `.ai/stt.json` are yours.
- An item state computed by eye instead of read from `verify --json`.
- A path table, merge rule, or removal-ownership rule restated in the conversation — all three
  live in code, and a second copy will drift from it.
- `--json` used without `--yes`, or a plan applied without printing it first.
- A markdown table pasted into a widget call's `question` or `context`, or a screen over budget.
- The `pi-ask-user` bootstrap skipped on `pi`, or the pass continued after installing it.
- An artifact removed without an explicit remove screen, or `esc` treated as consent.
- Exit `3` handled by picking a side instead of showing the `.new` files.
- `operator` or `external` steps performed instead of relayed.
- A key value written into `.ai/stt.json`, or `.env` overwritten rather than appended to.
- Source root found by scanning the filesystem, or taken from `SKILL.md`'s workspace location.

## Verification

- [ ] Source root came from the bootstrap marker, `SKILL.md`'s realpath, or the user — never a scan.
- [ ] Every item state, group, and profile came from `verify --json`.
- [ ] Broken items and findings were offered `doctor --fix` before the menu.
- [ ] The menu opened with the Express question; group screens ran only on `Custom`; every screen
      stayed within budget, with options carrying the data.
- [ ] On `pi`, `pi-ask-user` was present or its install-then-reload bootstrap was offered, and the
      pass stopped after installing it.
- [ ] Nothing was written to an install target except by the CLI, and the plan was printed before
      the single confirmation.
- [ ] `--allow-exec` was passed only after asking; `operator` / `external` steps were relayed verbatim.
- [ ] No copy-vs-symlink question was asked and no `--method` flag was passed.
- [ ] A `3` exit was surfaced as conflicts with their `.new` files, not resolved by guessing.
- [ ] `.ai/agent-fleet-overrides.md` holds terse `key: value` sections and nothing else; `rules:` /
      `docs:` were offered only when the scan found matching material.
- [ ] `.ai/stt.json` names env vars and holds no key values; `.env` was appended to, gitignored,
      and never overwritten.
- [ ] `cleanup-installer` ran unless the user kept the installer commands, and the report says which.
- [ ] The final `verify` exited `0`.
