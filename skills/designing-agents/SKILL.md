---
name: designing-agents
description: Designs and writes a focused artifact another agent runs — an agent persona in agents/, a workflow skill in skills/, or a pi session harness in .pi/harnesses/. Use when authoring a reviewer or specialist persona, a repeatable process skill, or a pi extension that reshapes a session — or when rewriting one that is under-specified, overlapping, or being ignored.
---

# Designing Agents

## Overview

This repo has three kinds of artifacts that shape how an agent works. Each is authored, versioned, and invoked deliberately:

- **Agent personas** live in `agents/<name>.md`. They define a *role* another agent adopts when it needs specialized review, audit, or analysis. Example: `code-reviewer`, `security-auditor`, `test-engineer`.
- **Skills** live in `skills/<name>/SKILL.md`. They define a *workflow* — a repeatable process with gated steps, anti-rationalization guardrails, and verification. Example: `spec-driven-development`, `test-driven-development`, `context-engineering`.
- **pi harnesses** live in `.pi/harnesses/<name>/`. They define a *session environment* — a TypeScript pi extension that reshapes the whole session: setting UI surfaces, gating tool calls, registering new tools or commands, or orchestrating sub-agents. Example: `agent-hub`, `damage-control`, `coms`.

Personas and skills are prose that change an agent's *judgment*. A harness is code that changes the agent's *environment* — what it can do and what it sees. All three fail the same way: a persona that reads like general advice gets cited but ignored; a skill that skips its guardrails becomes a suggestion; a harness built without studying the existing ones collides with pi's auto-discovery or fights another extension. This skill is the workflow for authoring any of the three so the result measurably changes behavior.

## When to Use

- Creating a new persona file in `agents/` (reviewer, auditor, domain specialist)
- Creating a new skill directory in `skills/` (a process, checklist, or workflow)
- Creating a new pi harness in `.pi/harnesses/` (a footer, focus gate, safety check, orchestrator, or messaging layer)
- An existing persona, skill, or harness is vague, overlaps another, or is being ignored in practice
- A recurring review, workflow, or session-shaping need has emerged and deserves its own artifact
- Rewriting an older artifact to align with current writing standards

**NOT for:**
- One-off prompts — just write the instruction inline.
- Claude Code `.claude/agents/` sub-agents — those use a different frontmatter (`tools`, `model`, `color`). The persona workflow in this skill still applies; only the frontmatter shape differs.
- Reference material (long checklists, pattern catalogs) — those belong in `references/`, not in skills or personas.
- An always-on pi *utility* extension under `.pi/extensions/` — this skill covers the selectable, mutually-exclusive *harnesses* under `.pi/harnesses/`. Adding an auto-discovered utility is a different decision; see `docs/pi-extensions.md`.

## The Workflow

This workflow is abstracted from the three reference personas (`agents/code-reviewer.md`, `agents/security-auditor.md`, `agents/test-engineer.md`), from `docs/skill-anatomy.md`, and from the ported harnesses under `.pi/harnesses/` (catalogued in `docs/pi-extensions.md`). Do not advance to the next step until the current one is settled.

### 1. Choose the target type

Ask: is this a *role* the agent should adopt, a *process* it should follow, or an *environment* it should run inside?

| Target | Choose when | Output |
|---|---|---|
| Persona | The agent needs to evaluate or review through a specific lens (correctness, security, test strategy, accessibility, migration safety…) | `agents/<name>.md` |
| Skill | The agent needs to follow a repeatable process with gated steps, verification, and anti-rationalization guards | `skills/<name>/SKILL.md` |
| pi harness | The session itself must change — footer, status, a blocking gate on tool calls, a new tool or `/command`, or sub-agent orchestration | `.pi/harnesses/<name>/` (a directory) |

If more than one applies, split them: a harness can *enforce* a workflow that a skill *describes*, and a persona can supply the lens. Do not merge the formats — each has its own structure and verification.

### 2. Clarify intent

Ask the requester for:
- **One-sentence purpose** — what does this artifact do that a general agent cannot?
- **Primary tasks or steps** — 2-4 concrete things it will be invoked to do.
- **Explicit non-goals** — what it should refuse or redirect.
- **Invocation trigger** — when should the calling agent delegate to this vs. handle the task itself? For a harness: how is it launched, and does it stack with another harness?

Do not proceed until the one-sentence purpose is locked. If the requester cannot state it in one sentence, the artifact is not ready to exist yet.

### 3. Scan for overlap

Read every existing artifact of the target type:
- For a persona: every file under `agents/`.
- For a skill: every `skills/*/SKILL.md` (start with the Quick Reference table in `skills/using-agent-skills/SKILL.md`).
- For a harness: the catalog table in `docs/pi-extensions.md`, then the `README.md` of each `.pi/harnesses/*` that looks close.

If the new artifact overlaps an existing one by more than ~30% (same scope, same output, same session surface), choose one of:
- **Extend** the existing artifact
- **Tighten scope** so the new artifact covers ground the existing one does not
- **Abandon** the new artifact — duplication is worse than absence

Two personas covering similar ground produce inconsistent reviews. Two skills produce conflicting advice. Two harnesses that both replace the footer, or both register the same CLI flag, collide at load time.

### 4. Pick a kebab-case name

Follow the existing pattern:
- **Persona**: `<role>` or `<role>-<specialty>` (`code-reviewer`, `security-auditor`, `accessibility-reviewer`)
- **Skill**: verb-phrase or noun-phrase describing the process (`spec-driven-development`, `context-engineering`, `planning-and-task-breakdown`)
- **Harness**: short noun describing the session surface (`agent-hub`, `damage-control`, `coms`)
- Bad for any: `helper`, `assistant`, `smart-agent`, `codeReviewer`

The name must match across: the directory/file name, the frontmatter or `package.json` `name`, and the H1 title (persona/skill) or README H1 (harness).

### 5. Write the discovery surface

How the artifact is found and delegated to.

**Personas & skills** — the frontmatter `description`. Action-oriented; says *when*, not *how*.
- Persona structure: `<Role noun> <that does what>. Use for <concrete trigger>.`
  - Good: `Senior code reviewer that evaluates changes across five dimensions — correctness, readability, architecture, security, and performance. Use for thorough code review before merge.`
- Skill structure: `<Verb phrase describing what the skill does>. Use when <specific trigger conditions>.`
  - Good: `Creates specs before coding. Use when starting a new project, feature, or significant change and no specification exists yet. Use when requirements are unclear, ambiguous, or only exist as a vague idea.`

**Harnesses** — a harness has no frontmatter. Its discovery surface is the `README.md` (H1 matching the directory name, a one-line subtitle, a "What it does" section) plus the catalog row in `docs/pi-extensions.md`. That row is what an agent actually scans — write it as `| name | Category | one-line what-it-does | run command |`.

**Bad for any** (avoid):
- Starts with "Helps with…" or "Assists in…" — vague, not delegation-friendly.
- Summarizes the full workflow — the description says *when*, not *how*.
- Over 280 characters — gets truncated in discovery.

### 6. Draft the body

This step branches by target type.

#### 6a. Persona body (four-block structure)

Used by every persona in `agents/`. See the Persona Template below.

```markdown
# <Role Heading>

You are a <experienced | senior | staff> <role title> focused on <scope>. Your role is to <primary tasks>. <One-sentence differentiator — what you prioritize vs. what you ignore.>

## <Framework / Review Dimensions / Approach>
<Numbered sections, each with 3-6 concrete questions this persona asks.>

## Output Format
<Concrete markdown template showing how findings are reported.>

## Rules
1. <Non-negotiable behavior>
```

#### 6b. Skill body (per `docs/skill-anatomy.md`)

Every skill in this repo follows the same section order. Do not invent new section names. See the Skill Template below.

```markdown
# <Skill Title>

## Overview
<One-two sentences on what the skill does and why it matters.>

## When to Use
- <Triggering conditions>
- NOT for: <Exclusions>

## The Workflow (or Core Process / Steps)
<Numbered steps or phases. Specific and actionable — run commands, not vague advice.>

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| <Excuse to skip a step> | <Factual rebuttal> |

## Red Flags
- <Observable sign the skill is being violated>

## Verification
- [ ] <Checklist of exit criteria with evidence requirements>
```

Skills have one mandatory section personas don't: **Common Rationalizations**. This table is the anti-rationalization lever that prevents the agent from talking itself out of following the process. Personas don't need it because a persona is a lens, not a workflow with skippable steps.

#### 6c. Harness body (a TypeScript pi extension)

A harness is code, not prose. It is a directory with three files:

- `index.ts` — the extension: `export default function (pi: ExtensionAPI) { … }`
- `package.json` — four fields: `name`, `private: true`, `type: "module"`, `main: "index.ts"`
- `README.md` — the discovery surface (see step 5)

The `index.ts` hooks pi session events (`session_start`, `tool_call`, `agent_end`, `input`, `before_agent_start`, …) and may register tools, commands, footers, widgets, and status text. **Read `pi-harness-authoring.md` in this skill's directory before writing any harness** — it documents the `ExtensionAPI` surface, the directory anatomy, the `index.ts` and `README.md` templates, and which existing harness to copy the closest pattern from. Do not write a harness from memory of this section alone.

A harness also has wiring steps that personas and skills do not — step 9 covers them: a `just ext-<name>` recipe in the `justfile` and a row in the `docs/pi-extensions.md` catalog.

### 7. Apply prompting-patterns

Before finalizing, read `references/prompting-patterns.md` and check the artifact against these sections. This applies to all three types — for a harness, to the prose it injects (system-prompt text, tool descriptions, block reasons), not the TypeScript itself.

- **§2.2** — Positive instructions, not prohibitions. Rewrite every "don't do X" as "do Y".
- **§2.3** — Explain *why* for any non-obvious rule. One short clause is enough.
- **§2.4** — Scan for contradictions. "Be thorough" + "be concise" must be resolved.
- **§2.5** — Remove ALL-CAPS and reward/punishment language ("CRITICAL", "you MUST", "never ever").
- **§3.1** — First sentence sets the role (persona) or the overview (skill). Make it specific, not generic.
- **§6.4** — Include anti-overengineering guards if the artifact produces or modifies code.

### 8. Minimize surface area

Cut every sentence that does not change behavior. Read each rule and ask: "If I removed this, would an invocation of this artifact produce different output?" If no, remove it.

- A 90-line focused persona beats a 200-line comprehensive one.
- A 150-line focused skill beats a 300-line exhaustive one.
- A harness that does one thing beats one that does five — stack two harnesses instead of merging them.
- The comprehensive version gets skimmed and its rules get skipped.

### 9. Write the file(s)

- Persona → `agents/<name>.md`.
- Skill → `skills/<name>/SKILL.md` (create the directory; supporting files only if the skill exceeds ~300 lines or needs separate reference material).
- Harness → `.pi/harnesses/<name>/` with `index.ts`, `package.json`, and `README.md`. Then add a `just ext-<name>` recipe to the `justfile` under the matching category header, add a catalog row to `docs/pi-extensions.md`, and add any new runtime dependency to `.pi/harnesses/package.json`. Never place a harness under `.pi/extensions/` — pi auto-discovers that directory and would load every harness at once.

### 10. Verify

Walk the Verification section below. Use the shared checklist plus the target-specific checklist. Do not ship an artifact that fails any item.

## Persona Template

Minimal skeleton — keep placeholders in angle brackets until the content is concrete.

```markdown
---
name: <kebab-case-name>
description: <Role noun> that <what it does>. Use for <concrete trigger>.
---

# <Role Title>

You are a <seniority level> <role> focused on <narrow scope>. Your role is to <2-3 primary tasks>. <What you prioritize vs. what you intentionally ignore.>

## <Framework Section Title>

### 1. <Dimension>
- <Concrete question>
- <Concrete question>

### 2. <Dimension>
- <Concrete question>

### 3. <Dimension>
- <Concrete question>

## <Severity or Classification — if applicable>

| Severity | Criteria | Action |
|---|---|---|
| Critical | <What makes it critical> | <Required response> |
| Important | <What makes it important> | <Required response> |
| Suggestion | <What makes it optional> | <Required response> |

## Output Format

\`\`\`markdown
## <Report Title>

**Verdict:** <APPROVE | REQUEST CHANGES | whatever fits>

### <Category 1>
- [file:line] <Finding and recommendation>

### <Category 2>
- [file:line] <Finding and recommendation>

### What's Done Well
- <At least one positive observation>
\`\`\`

## Rules

1. <Behavior this persona must always follow>
2. <Behavior this persona must always follow>
3. <Behavior this persona must always follow>
```

## Skill Template

Minimal skeleton — the canonical format is documented in `docs/skill-anatomy.md`; do not deviate from its section order.

```markdown
---
name: <kebab-case-name>
description: <What the skill does>. Use when <specific trigger conditions, ideally 2-4 clauses>.
---

# <Skill Title>

## Overview
<One-two sentences: what does this skill do, and why does it matter?>

## When to Use
- <Triggering condition>
- <Triggering condition>

**NOT for:** <Clear exclusion so the skill isn't over-triggered.>

## The Workflow

### 1. <First step>
<Specific, actionable. Include commands or concrete questions. No vague advice.>

### 2. <Second step>
<...>

### 3. <Third step>
<...>

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "<Excuse an agent might use to skip a step>" | <Factual rebuttal grounded in why the step exists> |
| "<Another excuse>" | <Another rebuttal> |

## Red Flags

- <Observable sign the skill is being violated>
- <Observable sign the skill is being violated>

## Verification

After completing the workflow, confirm:

- [ ] <Exit criterion with evidence requirement>
- [ ] <Exit criterion with evidence requirement>
- [ ] <Exit criterion with evidence requirement>
```

## Harness Structure

A harness is a directory, not a single file. The `ExtensionAPI` surface, the `index.ts` skeleton, the `package.json` shape, the `README.md` template, and the `justfile` / catalog wiring are all in `pi-harness-authoring.md` alongside this skill — that file is the harness equivalent of `docs/skill-anatomy.md`. Do not start a harness without reading it; copy the closest existing harness it points you to rather than writing `index.ts` from memory.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll make it general-purpose so it's reusable everywhere" | General artifacts get cited but never change behavior. Narrow scope creates measurable change. Scope is a feature, not a limit. |
| "I'll skip the Output Format section — the agent will figure it out" (persona) | Without a template, outputs drift across invocations and become uncomparable. Reviewers cannot triage findings that don't share a shape. |
| "I'll skip the Common Rationalizations table — the steps are obvious" (skill) | Every step that gets skipped had an excuse attached. The table is the only place in the skill that directly blocks those excuses. Skipping it is how skills become suggestions. |
| "I'll skip the Verification checklist — the user will know when it's done" (skill) | Without evidence requirements, 'seems right' becomes the completion signal. The checklist is what forces proof. |
| "I'll drop the harness in `.pi/extensions/` so it loads automatically" | pi auto-discovers `.pi/extensions/` and loads everything there at once. Most harnesses are mutually exclusive — footers fight, duplicate CLI flags abort startup. Harnesses live in `.pi/harnesses/` and load explicitly; the supported stack is `damage-control` before `agent-hub`. |
| "I'll write the harness `index.ts` from memory — I've seen the pattern" | The `ExtensionAPI` surface is specific and unforgiving; a misspelled event name fails silently. Read `pi-harness-authoring.md` and copy the closest existing harness. |
| "I'll skip the harness README and catalog row — `index.ts` is the real artifact" | A harness with no row in `docs/pi-extensions.md` is undiscoverable; no agent will load it. The README is its discovery surface — the same role frontmatter plays for a skill. |
| "I'll copy an existing artifact and tweak it" | For prose artifacts, copy-paste creates silent duplication and drift — read the existing files to learn the pattern, then write fresh. For a harness, copying the nearest `index.ts` *is* the recommended start; just rename it cleanly and cut what you don't use. |
| "I don't need to read prompting-patterns, I know how to write prompts" | Every author thinks this. The reference exists because recurring, measurable mistakes happen anyway. Spend 3 minutes skimming §2 and §6. |
| "I'll add every tool and capability — flexibility is good" | This repo's `agents/*.md` don't declare tools at all; scope creep happens through the prompt body. Skills and harnesses that try to cover many domains lose their force. Bloated artifacts get skimmed. |
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

**Persona-specific:**
- No Output Format section (no comparability across runs).
- Rules section is empty, contains only platitudes, or repeats content from the Framework section.
- File exceeds 150 lines — scope is probably too broad.

**Skill-specific:**
- No Common Rationalizations table, or the table contains rationalizations that are too generic to block real excuses.
- No Verification checklist, or checkboxes that cannot be verified with evidence.
- Steps are vague ("make sure the tests pass") instead of specific ("run `npm test` and verify exit code 0").
- Sections appear in a different order from `docs/skill-anatomy.md`.
- The skill is a reference catalog with no workflow — the body is bullets of facts, not steps.

**Harness-specific:**
- Placed under `.pi/extensions/` instead of `.pi/harnesses/` — it would load on every plain `pi` run and collide with other harnesses.
- No `README.md`, or no row added to the `docs/pi-extensions.md` catalog — the harness is undiscoverable.
- `index.ts` uses invented `ExtensionAPI` method or event names — written without reading `pi-harness-authoring.md` or studying an existing harness.
- Registers a footer, status, or CLI flag without checking whether another loaded harness already owns it.
- No `just ext-<name>` recipe, so the harness can only be launched by typing the full `pi -e` path.

## Verification

### Shared checklist (all three types)

- [ ] Name is kebab-case and matches the file/directory, the `name` field (frontmatter or `package.json`), and the H1 title.
- [ ] The discovery surface (description, or README + catalog row) is action-oriented and ends with a concrete trigger.
- [ ] Cross-checked against `references/prompting-patterns.md` §2.2, §2.3, §2.4, §2.5, §3.1, §6.4 — no prohibitions, no contradictions, no ALL-CAPS, role/overview is specific.
- [ ] Scanned against existing files of the same type — no >30% overlap.
- [ ] Every sentence, if removed, would visibly change the artifact's behavior.

### Persona-specific checklist

- [ ] File exists at `agents/<name>.md`.
- [ ] Body has: Role opening paragraph, Framework/Approach, Output Format, Rules.
- [ ] Output Format contains a concrete markdown template, not a description of one.
- [ ] If the persona classifies findings (Critical / High / etc.), the severity table is present with explicit criteria and required action.
- [ ] Under 150 lines total.

### Skill-specific checklist

- [ ] File exists at `skills/<name>/SKILL.md`.
- [ ] Section order follows `docs/skill-anatomy.md`: Overview → When to Use → Workflow/Process → Common Rationalizations → Red Flags → Verification.
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
