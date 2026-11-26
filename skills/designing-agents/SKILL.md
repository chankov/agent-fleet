---
name: designing-agents
description: Designs and writes a focused artifact another agent runs — a role prompt that replaces one runtime role's prompt or model, a workflow skill in skills/, or a pi session harness in .pi/harnesses/. Use when customizing a role for a project, authoring a repeatable process or review-lens skill, or a pi extension that reshapes a session — or when rewriting one that is under-specified, overlapping, or being ignored.
---

# Designing Agents

## Overview

This repo has three kinds of artifacts that shape how an agent works. Each is authored, versioned, and invoked deliberately:

- **Role prompts** are the three runtime role files: `researcher`, `reviewer` and `editor`. The Agent Hub dispatches only these roles. A file with a role's name in a project's `agents/` replaces that role's prompt or model, while the code-owned ceiling (tools, read-only status) still applies. A file with any other name is not dispatched. See [docs/agents.md](../../docs/agents.md#customizing-a-role).
- **Skills** live in `skills/<name>/SKILL.md`. They define a *workflow* — a repeatable process with gated steps, anti-rationalization guardrails, and verification. Example: `spec-driven-development`, `test-driven-development`, `context-engineering`. An assignment loads skills through its practices, and any skill path its task names, so a new specialist lens (accessibility, migration safety, …) is a skill, not a new agent.
- **pi harnesses** live in `.pi/harnesses/<name>/`. They define a *session environment* — a TypeScript pi extension that reshapes the whole session: setting UI surfaces, gating tool calls, registering new tools or commands, or orchestrating sub-agents. Example: `agent-hub`, `damage-control-continue`, `coms`.

Role prompts and skills are prose that change an agent's *judgment*. A harness is code that changes the agent's *environment* — what it can do and what it sees. All three fail the same way: a role prompt that reads like general advice gets cited but ignored; a skill that skips its guardrails becomes a suggestion; a harness built without studying the existing ones collides with pi's auto-discovery or fights another extension. This skill is the workflow for authoring any of the three so the result measurably changes behavior.

## When to Use

- Changing how one of the three roles works in a project (its prompt, model choices or helpers) through a same-named role file
- Creating a new skill directory in `skills/` (a process, checklist, workflow, or a review lens an existing practice should load)
- Creating a new pi harness in `.pi/harnesses/` (a footer, focus gate, safety check, orchestrator, or messaging layer)
- An existing role prompt, skill, or harness is vague, overlaps another, or is being ignored in practice
- A recurring review, workflow, or session-shaping need has emerged and deserves its own artifact
- Rewriting an older artifact to align with current writing standards

**NOT for:**
- One-off prompts — just write the instruction inline.
- A new persona or specialist agent file — the Hub dispatches only `researcher`, `reviewer` and `editor`. Express the specialty as a skill used through a practice. A new practice is a code change in `.pi/harnesses/agent-hub/config/practices.ts` and needs a maintainer decision.
- Agents for another vendor's runtime — the workflow in this skill still applies, but the frontmatter shape here is pi's, and pi is the only runtime Agent Fleet installs for.
- Reference material (long checklists, pattern catalogs) — those belong in `references/`, not in skills or role prompts.
- An always-on pi *utility* extension under `.pi/extensions/` — this skill covers the selectable, mutually-exclusive *harnesses* under `.pi/harnesses/`. Adding an auto-discovered utility is a different decision; see `docs/pi-extensions.md`.

## The Workflow

This workflow is abstracted from the three role files (`agents/researcher.md`, `agents/reviewer.md`, `agents/editor.md`), from `docs/skill-anatomy.md`, and from the ported harnesses under `.pi/harnesses/` (catalogued in `docs/pi-extensions.md`). Do not advance to the next step until the current one is settled.

### 1. Choose the target type

Ask: does a *role* need a different prompt or model in this project, does the agent need a *process* to follow, or does it need an *environment* to run inside?

| Target | Choose when | Output |
|---|---|---|
| Role prompt | One of the three roles needs project-specific instructions, model choices (`model:`, `models:`, `practice_models:`) or helpers (`subagents:`) | `agents/<role>.md`, where `<role>` is `researcher`, `reviewer` or `editor` |
| Skill | The agent needs to follow a repeatable process with gated steps, verification, and anti-rationalization guards — including a new evaluation lens (accessibility, migration safety…) | `skills/<name>/SKILL.md` |
| pi harness | The session itself must change — footer, status, a blocking gate on tool calls, a new tool or `/command`, or sub-agent orchestration | `.pi/harnesses/<name>/` (a directory) |

If more than one applies, split them: a harness can *enforce* a workflow that a skill *describes*, and a role prompt can point to the lens. Do not merge the formats — each has its own structure and verification. When the lens belongs to an existing practice, add or extend the skill that practice already loads (the practice table in [docs/agents.md](../../docs/agents.md#practices) lists them). Otherwise the operator names the new skill's path in the assignment's task or `artifacts`; making a practice load it by default is a change to `practices.ts`.

### 2. Clarify intent

Ask the requester for:
- **One-sentence purpose** — what does this artifact do that a general agent cannot?
- **Primary tasks or steps** — 2-4 concrete things it will be invoked to do.
- **Explicit non-goals** — what it should refuse or redirect.
- **Invocation trigger** — when should the operator assign this work (which role, which practices) vs. handle the task itself? For a harness: how is it launched, and does it stack with another harness?

Do not proceed until the one-sentence purpose is locked. If the requester cannot state it in one sentence, the artifact is not ready to exist yet.

### 3. Scan for overlap

Read every existing artifact of the target type:
- For a role prompt: the shipped role file for that role (`agents/<role>.md` in this repo, `.pi/agents/personas/<role>.md` in an installed workspace) and the practice methods in `.pi/harnesses/agent-hub/config/practices.ts`, which every assignment already carries.
- For a skill, start with the Quick Reference table in `skills/using-agent-skills/SKILL.md` and resolve names using [native-first discovery](../../docs/UPSTREAM-SKILLS.md#layout-and-precedence).
- For a harness: the catalog table in `docs/pi-extensions.md`, then the `README.md` of each `.pi/harnesses/*` that looks close.

If the new artifact overlaps an existing one by more than ~30% (same scope, same output, same session surface), choose one of:
- **Extend** the existing artifact
- **Tighten scope** so the new artifact covers ground the existing one does not
- **Abandon** the new artifact — duplication is worse than absence

A role prompt that restates a practice's method produces two versions of the same rule. Two skills produce conflicting advice. Two harnesses that both replace the footer, or both register the same CLI flag, collide at load time.

### 4. Pick the name

- **Role prompt**: exactly `researcher`, `reviewer` or `editor`. Any other name is ignored by the Hub, and a retired persona name (`code-reviewer`, `builder`, …) is reported with its role + practice mapping.
- **Skill**: kebab-case verb-phrase or noun-phrase describing the process (`spec-driven-development`, `context-engineering`, `planning-and-task-breakdown`)
- **Harness**: short kebab-case noun describing the session surface (`agent-hub`, `damage-control`, `coms`)
- Bad for any: `helper`, `assistant`, `smart-agent`, `codeReviewer`

The name must match across: the file or directory name, the frontmatter or `package.json` `name`, and the H1 title (role prompt or skill) or README H1 (harness).

### 5. Write the discovery surface

How the artifact is found and delegated to.

**Role prompts & skills** — the frontmatter `description`. Action-oriented; says *when*, not *how*.
- Role structure: `<Role noun> that <does what>. Use for <concrete triggers>.`
  - Good: `Independent read-only reviewer that assesses a named plan, code change or documentation revision against its task, the project rules and the evidence, and returns categorized findings with a verdict scoped to what it inspected. Use for plan review, code review before merge, documentation accuracy checks, and security, performance or coverage assessments.`
- Skill descriptions follow the [frontmatter guide](../../docs/skill-anatomy.md#frontmatter-required).
  - Good: `Creates specs before coding. Use when starting a new project, feature, or significant change and no specification exists yet. Use when requirements are unclear, ambiguous, or only exist as a vague idea.`

**Harnesses** — a harness has no frontmatter. Its discovery surface is the `README.md` (H1 matching the directory name, a one-line subtitle, a "What it does" section) plus the catalog row in `docs/pi-extensions.md`. That row is what an agent actually scans — write it as `| name | Category | one-line what-it-does | run command |`.

**Bad for any** (avoid):
- Starts with "Helps with…" or "Assists in…" — vague, not delegation-friendly.
- Summarizes the full workflow — the description says *when*, not *how*.
- Gives background before the concrete trigger, which may be cut off in a short preview.

### 6. Draft the body

This step branches by target type.

#### 6a. Role prompt body

Start from the shipped role file you are replacing, and keep the sections the runtime and the operator rely on. See the Role Prompt Structure below.

- **Opening paragraph** — the role and what it returns.
- **`## Assignment and practices`** — read the skill paths the dispatch's `## Assignment` block lists; a practice adds method, never authority.
- **Scope and boundaries** — what the role may change (an editor: only its authorized scope; readers: nothing) and when to stop and report.
- **Project rules and docs** — how to resolve `rules:` and `docs:` from `.ai/agent-fleet-overrides.md`.
- **Return format** — the concrete template the operator parses. The reviewer's verdict line (`APPROVE` or `REQUEST CHANGES`) and the structured-return schema are read by the runtime; keep them.

Put method that applies to every assignment of a kind into the practice's skill, not into the role prompt, so researchers, reviewers and editors share it.

#### 6b. Skill body

Use the [skill authoring guide](../../docs/skill-anatomy.md) for the template and distribution rules. Write the steps as concrete actions, explain why likely shortcuts skip necessary work, and describe the evidence needed to finish.

#### 6c. Harness body (a TypeScript pi extension)

A harness is code, not prose. It is a directory with three files:

- `index.ts` — the extension: `export default function (pi: ExtensionAPI) { … }`
- `package.json` — four fields: `name`, `private: true`, `type: "module"`, `main: "index.ts"`
- `README.md` — the discovery surface (see step 5)

The `index.ts` hooks pi session events (`session_start`, `tool_call`, `agent_end`, `input`, `before_agent_start`, …) and may register tools, commands, footers, widgets, and status text. **Read `pi-harness-authoring.md` in this skill's directory before writing any harness** — it documents the `ExtensionAPI` surface, the directory anatomy, the `index.ts` and `README.md` templates, and which existing harness to copy the closest pattern from. Do not write a harness from memory of this section alone.

A harness also has wiring steps that role prompts and skills do not — step 9 covers them: a `just ext-<name>` recipe in the `justfile` and a row in the `docs/pi-extensions.md` catalog.

### 7. Apply prompting-patterns

Before finalizing, read `../../references/prompting-patterns.md` and check the artifact against these sections. This applies to all three types — for a harness, to the prose it injects (system-prompt text, tool descriptions, block reasons), not the TypeScript itself.

- **§2.2** — Positive instructions, not prohibitions. Rewrite every "don't do X" as "do Y".
- **§2.3** — Explain *why* for any non-obvious rule. One short clause is enough.
- **§2.4** — Scan for contradictions. "Be thorough" + "be concise" must be resolved.
- **§2.5** — Remove ALL-CAPS and reward/punishment language ("CRITICAL", "you MUST", "never ever").
- **§3.1** — First sentence sets the role (role prompt) or the overview (skill). Make it specific, not generic.
- **§6.4** — Include anti-overengineering guards if the artifact produces or modifies code.

### 8. Minimize surface area

Cut every sentence that does not change behavior. Read each rule and ask: "If I removed this, would an invocation of this artifact produce different output?" If no, remove it.

- A focused role prompt under 150 lines beats a 300-line comprehensive one.
- A 150-line focused skill beats a 300-line exhaustive one.
- A harness that does one thing beats one that does five — stack two harnesses instead of merging them.
- The comprehensive version gets skimmed and its rules get skipped.

### 9. Write the file(s)

- Role prompt → `agents/<role>.md` in the project (in this repo, `agents/<role>.md` is the shipped role). The Hub reads `agents/` before the installed copies, so the project file wins; [docs/agents.md](../../docs/agents.md#customizing-a-role) describes the precedence.
- Skill → `skills/<name>/SKILL.md` (create the directory; supporting files only if the skill exceeds ~300 lines or needs separate reference material).
- Harness → `.pi/harnesses/<name>/` with `index.ts`, `package.json`, and `README.md`. Then add a `just ext-<name>` recipe to the `justfile` under the matching category header, add a catalog row to `docs/pi-extensions.md`, and add any new runtime dependency to `.pi/harnesses/package.json`. Never place a harness under `.pi/extensions/` — pi auto-discovers that directory and would load every harness at once.

### 10. Verify

Walk the Verification section below. Use the shared checklist plus the target-specific checklist. Do not ship an artifact that fails any item.

## Role Prompt Structure

Skeleton of a role file — keep placeholders in angle brackets until the content is concrete, and keep every section the shipped file for that role has.

```markdown
---
name: <researcher | reviewer | editor>
description: <Role noun> that <what it does>. Use for <concrete triggers>.
tools: <the role's tools; code caps them at the role ceiling>
model: <provider/model>
models:
  - <candidates /af-agent-model offers>
thinking: <thinking level>
practice_models:            # optional per-practice defaults
  <practice>: { model: <provider/model>, thinking: <level> }
---

# <Role Title>

You are <the role> focused on <scope>. Your job is to <primary tasks>. <What you return.>

## Assignment and practices

- Read the skill paths the dispatch's `## Assignment` block lists before you begin.
- A practice supplies method and expected evidence; it never adds authority.

## <Scope and boundaries>

- <What you may change and when you stop and report>

## Project rules and docs

- <How to resolve rules: and docs: from .ai/agent-fleet-overrides.md>

## <Return / Output Format>

\`\`\`markdown
<Concrete template the operator parses>
\`\`\`
```

## Harness Structure

A harness is a directory, not a single file. The `ExtensionAPI` surface, the `index.ts` skeleton, the `package.json` shape, the `README.md` template, and the `justfile` / catalog wiring are all in `pi-harness-authoring.md` alongside this skill — that file is the harness equivalent of `docs/skill-anatomy.md`. Do not start a harness without reading it; copy the closest existing harness it points you to rather than writing `index.ts` from memory.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll write a new `accessibility-reviewer.md` persona" | The Hub dispatches only `researcher`, `reviewer` and `editor`; any other file is ignored. Write the lens as a skill and assign a `reviewer` that is told to read it. |
| "I'll make it general-purpose so it's reusable everywhere" | General artifacts get cited but never change behavior. Narrow scope creates measurable change. Scope is a feature, not a limit. |
| "I'll skip the Return section — the agent will figure it out" (role prompt) | The operator and the runtime parse that template, including the reviewer's verdict line. Without it, outputs drift and evidence cannot be checked. |
| "I'll skip the Common Rationalizations table — the steps are obvious" (skill) | Every step that gets skipped had an excuse attached. The table is the only place in the skill that directly blocks those excuses. Skipping it is how skills become suggestions. |
| "I'll skip the Verification checklist — the user will know when it's done" (skill) | Without evidence requirements, 'seems right' becomes the completion signal. The checklist is what forces proof. |
| "I'll drop the harness in `.pi/extensions/` so it loads automatically" | pi auto-discovers `.pi/extensions/` and loads everything there at once. Most harnesses are mutually exclusive — footers fight, duplicate CLI flags abort startup. Harnesses live in `.pi/harnesses/` and load explicitly; the supported stack loads `damage-control-continue` before `agent-hub`. |
| "I'll write the harness `index.ts` from memory — I've seen the pattern" | The `ExtensionAPI` surface is specific and unforgiving; a misspelled event name fails silently. Read `pi-harness-authoring.md` and copy the closest existing harness. |
| "I'll skip the harness README and catalog row — `index.ts` is the real artifact" | A harness with no row in `docs/pi-extensions.md` is undiscoverable; no agent will load it. The README is its discovery surface — the same role frontmatter plays for a skill. |
| "I'll copy an existing artifact and tweak it" | For a skill, copy-paste creates silent duplication and drift — read the existing files to learn the pattern, then write fresh. For a role prompt or a harness, starting from the shipped file *is* the recommended start; cut what you don't need and keep the sections the runtime parses. |
| "I don't need to read prompting-patterns, I know how to write prompts" | Every author thinks this. The reference exists because recurring, measurable mistakes happen anyway. Spend 3 minutes skimming §2 and §6. |
| "I'll give the role more tools so it can do more" | The role ceiling is code (`.pi/harnesses/agent-hub/config/roles.ts`); a reader stays read-only whatever the file declares. Work that needs writes belongs to an editor. |
| "I'll put the security method in the reviewer prompt" | Method for a kind of work belongs to the practice's skill, so every role with that practice uses it. A role prompt that restates it drifts from the skill. |
| "The purpose is hard to state in one sentence because it covers a lot" | If you cannot state it in one sentence, the artifact covers too much. Split it or scope it down. |
| "I'll leave the rules/steps section light so the artifact can be flexible" | Empty Rules or vague steps become empty behavior. The specifics are what differentiate this artifact from a general agent. |
| "My skill is mostly reference material — I'll inline a 200-line checklist" | Reference material belongs in `references/`. Skills are workflows, not reference docs. Move the long content out and cite it. |

## Red Flags

**Shared (all three types):**
- Description or README subtitle starts with "Helps with…" or "Assists in…" (vague, non-delegating).
- Uses ALL-CAPS or reward/punishment language in the body or injected prompt text.
- Name in frontmatter / `package.json`, filename (or directory), and H1 title do not all match.
- Overlaps more than ~30% with an existing artifact of the same type.
- First sentence is a generic "You are a helpful assistant that…" or "This skill helps you…".

**Role-prompt-specific:**
- The file name is not `researcher`, `reviewer` or `editor` — the Hub will not dispatch it.
- The Return / Output Format section is missing, or the reviewer's verdict line or structured-return reference was removed.
- The body repeats a practice's method instead of pointing to the practice's skills.
- File exceeds 150 lines — scope is probably too broad.

**Skill-specific:**
- No Common Rationalizations table, or the table contains rationalizations that are too generic to block real excuses.
- No Verification checklist, or checkboxes that cannot be verified with evidence.
- Steps are vague ("make sure the tests pass") instead of specific ("run `npm test` and verify exit code 0").
- Section headings obscure where to find the workflow or its verification.
- The skill is a reference catalog with no workflow — the body is bullets of facts, not steps.

**Harness-specific:**
- Placed under `.pi/extensions/` instead of `.pi/harnesses/` — it would load on every plain `pi` run and collide with other harnesses.
- No `README.md`, or no row added to the `docs/pi-extensions.md` catalog — the harness is undiscoverable.
- `index.ts` uses invented `ExtensionAPI` method or event names — written without reading `pi-harness-authoring.md` or studying an existing harness.
- Registers a footer, status, or CLI flag without checking whether another loaded harness already owns it.
- No `just ext-<name>` recipe, so the harness can only be launched by typing the full `pi -e` path.

## Verification

### Shared checklist (all three types)

- [ ] Name matches the file/directory, the `name` field (frontmatter or `package.json`), and the H1 title.
- [ ] The discovery surface (description, or README + catalog row) is action-oriented and ends with a concrete trigger.
- [ ] Cross-checked against `../../references/prompting-patterns.md` §2.2, §2.3, §2.4, §2.5, §3.1, §6.4 — no prohibitions, no contradictions, no ALL-CAPS, role/overview is specific.
- [ ] Scanned against existing files of the same type — no >30% overlap.
- [ ] Every sentence, if removed, would visibly change the artifact's behavior.

### Role-prompt-specific checklist

- [ ] File exists at `agents/<role>.md` with `<role>` one of `researcher`, `reviewer`, `editor`.
- [ ] Body keeps the shipped role's sections: opening paragraph, Assignment and practices, scope and boundaries, project rules and docs, Return / Output Format.
- [ ] Return / Output Format contains a concrete markdown template, not a description of one.
- [ ] Hub startup shows no "Not dispatched" or "Missing role definition" notice for the file.
- [ ] Under 150 lines total.

### Skill-specific checklist

- [ ] File exists at `skills/<name>/SKILL.md`.
- [ ] The skill covers the purposes in the [recommended section pattern](../../docs/skill-anatomy.md#standard-sections-recommended-pattern).
- [ ] `When to Use` includes at least one explicit **NOT for** exclusion.
- [ ] `Common Rationalizations` table has at least three rows, each blocking a specific excuse.
- [ ] `Verification` checklist has at least three items, each verifiable with evidence (command output, file existence, passing test).
- [ ] Steps are specific enough to execute (commands, concrete questions, file paths) — not vague advice.
- [ ] Under ~300 lines total; if longer, long reference material has been moved to `references/`.

### Harness-specific checklist

- [ ] Directory exists at `.pi/harnesses/<name>/` with `index.ts`, `package.json`, and `README.md`.
- [ ] `package.json` has `name`, `private: true`, `type: "module"`, and `main: "index.ts"`.
- [ ] `index.ts` exports `default function (pi: ExtensionAPI)` and uses only real `ExtensionAPI` events and methods, cross-checked against `pi-harness-authoring.md` or an existing harness.
- [ ] `README.md` has an H1 matching the directory name, a one-line subtitle, and "What it does", "Commands & tools", and "Usage" sections.
- [ ] A `just ext-<name>` recipe is added to the `justfile` under the matching category header.
- [ ] A catalog row is added to the table in `docs/pi-extensions.md`.
- [ ] Any new runtime dependency is added to `.pi/harnesses/package.json`.
- [ ] `pi -e .pi/harnesses/<name>/index.ts` launches without error.
