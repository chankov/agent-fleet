---
name: designing-sub-agents
description: Designs and writes a new agent persona under agents/ or a new workflow skill under skills/. Use when authoring a focused artifact that another agent will delegate to — a reviewer, auditor, specialist persona, or a repeatable process skill — or when rewriting one that is under-specified, overlapping, or being ignored.
---

# Designing Sub-Agents

## Overview

This repo has two kinds of focused artifacts that a calling agent delegates to:

- **Agent personas** live in `agents/<name>.md`. They define a *role* another agent adopts when it needs specialized review, audit, or analysis. Example: `code-reviewer`, `security-auditor`, `test-engineer`.
- **Skills** live in `skills/<name>/SKILL.md`. They define a *workflow* — a repeatable process with gated steps, anti-rationalization guardrails, and verification. Example: `spec-driven-development`, `test-driven-development`, `context-engineering`.

Both exist for the same reason: to encode senior judgment in a form that survives across sessions and changes behavior when invoked. Both fail in the same way: if they read like general advice, they get cited but ignored. This skill is the workflow for authoring either kind so it will measurably change behavior.

## When to Use

- Creating a new persona file in `agents/` (reviewer, auditor, domain specialist)
- Creating a new skill directory in `skills/` (a process, checklist, or workflow)
- An existing persona or skill is vague, overlaps another, or is being ignored in practice
- A recurring review, audit, or workflow need has emerged and deserves its own artifact
- Rewriting an older persona or skill to align with current writing standards

**NOT for:**
- One-off prompts — just write the instruction inline.
- Claude Code `.claude/agents/` sub-agents — those use a different frontmatter (`tools`, `model`, `color`). The workflow in this skill still applies; only the frontmatter shape differs.
- Reference material (long checklists, pattern catalogs) — those belong in `references/`, not in skills or personas.

## The Workflow

This workflow is abstracted from the three reference personas (`agents/code-reviewer.md`, `agents/security-auditor.md`, `agents/test-engineer.md`) and from `docs/skill-anatomy.md`. Do not advance to the next step until the current one is settled.

### 1. Choose the target type

Ask: is this a *role* the agent should adopt, or a *process* the agent should follow?

| Target | Choose when | Output file |
|---|---|---|
| Persona | The agent needs to evaluate or review through a specific lens (correctness, security, test strategy, accessibility, migration safety…) | `agents/<name>.md` |
| Skill | The agent needs to follow a repeatable process with gated steps, verification, and anti-rationalization guards | `skills/<name>/SKILL.md` |

If both apply, split them: write a skill for the workflow and a persona for the lens. Do not merge the two formats.

### 2. Clarify intent

Ask the requester for:
- **One-sentence purpose** — what does this artifact do that a general agent cannot?
- **Primary tasks or steps** — 2-4 concrete things it will be invoked to do.
- **Explicit non-goals** — what it should refuse or redirect.
- **Invocation trigger** — when should the calling agent delegate to this vs. handle the task itself?

Do not proceed until the one-sentence purpose is locked. If the requester cannot state it in one sentence, the artifact is not ready to exist yet.

### 3. Scan for overlap

Read every file in the target directory:
- For a persona: every file under `agents/`.
- For a skill: every `skills/*/SKILL.md` (start with the Quick Reference table in `skills/using-agent-skills/SKILL.md`).

If the new artifact overlaps an existing one by more than ~30% (same scope, same framework, same output), choose one of:
- **Extend** the existing artifact with a new section
- **Tighten scope** so the new artifact covers ground the existing one does not
- **Abandon** the new artifact — duplication is worse than absence

Two personas covering similar ground produce inconsistent reviews. Two skills covering similar ground produce conflicting advice. Either way, trust erodes in both.

### 4. Pick a kebab-case name

Follow the existing pattern:
- **Persona**: `<role>` or `<role>-<specialty>` (`code-reviewer`, `security-auditor`, `accessibility-reviewer`)
- **Skill**: verb-phrase or noun-phrase describing the process (`spec-driven-development`, `context-engineering`, `planning-and-task-breakdown`)
- Bad for either: `helper`, `assistant`, `smart-agent`, `codeReviewer`

The name must match across: the directory/file name, the frontmatter `name`, and the H1 title.

### 5. Write the frontmatter description

The description is how agents discover and delegate, so it must be action-oriented and delegation-friendly.

**Personas** — structure: `<Role noun> <that does what>. Use for <concrete trigger>.`
- Good: `Senior code reviewer that evaluates changes across five dimensions — correctness, readability, architecture, security, and performance. Use for thorough code review before merge.`
- Good: `Security engineer focused on vulnerability detection, threat modeling, and secure coding practices. Use for security-focused code review, threat analysis, or hardening recommendations.`

**Skills** — structure: `<Verb phrase describing what the skill does>. Use when <specific trigger conditions>.`
- Good: `Creates specs before coding. Use when starting a new project, feature, or significant change and no specification exists yet. Use when requirements are unclear, ambiguous, or only exist as a vague idea.`
- Good: `Optimizes agent context setup. Use when starting a new session, when agent output quality degrades, when switching between tasks, or when you need to configure rules files and context for a project.`

**Bad for either** (avoid):
- Starts with "Helps with…" or "Assists in…" — vague, not delegation-friendly
- Summarizes the full workflow in the description — the description says *when*, not *how*
- Over 280 characters — gets truncated in discovery

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

### 7. Apply prompting-patterns

Before finalizing, read `references/prompting-patterns.md` and check the artifact against these sections (same for both personas and skills):

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
- The comprehensive version gets skimmed and its rules get skipped.

### 9. Write the file

- Persona → `agents/<name>.md`
- Skill → `skills/<name>/SKILL.md` (create the directory; supporting files only if the skill exceeds ~300 lines or needs separate reference material)

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

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll make it general-purpose so it's reusable everywhere" | General artifacts get cited but never change behavior. Narrow scope creates measurable change. Scope is a feature, not a limit. |
| "I'll skip the Output Format section — the agent will figure it out" (persona) | Without a template, outputs drift across invocations and become uncomparable. Reviewers cannot triage findings that don't share a shape. |
| "I'll skip the Common Rationalizations table — the steps are obvious" (skill) | Every step that gets skipped had an excuse attached. The table is the only place in the skill that directly blocks those excuses. Skipping it is how skills become suggestions. |
| "I'll skip the Verification checklist — the user will know when it's done" (skill) | Without evidence requirements, 'seems right' becomes the completion signal. The checklist is what forces proof. |
| "I'll copy an existing artifact and tweak it" | Copy-paste creates silent duplication and drift. Read existing files first to understand the pattern, then write the new one from scratch or extend the original. |
| "I don't need to read prompting-patterns, I know how to write prompts" | Every author thinks this. The reference exists because recurring, measurable mistakes happen anyway. Spend 3 minutes skimming §2 and §6. |
| "I'll add every tool and capability — flexibility is good" | This repo's `agents/*.md` don't declare tools at all; scope creep happens through the prompt body. Skills that try to cover many domains lose their anti-rationalization force. Bloated artifacts get skimmed. |
| "The purpose is hard to state in one sentence because it covers a lot" | If you cannot state it in one sentence, the artifact covers too much. Split it or scope it down. |
| "I'll leave the rules/steps section light so the artifact can be flexible" | Empty Rules or vague steps become empty behavior. The specifics are what differentiate this artifact from a general agent. |
| "My skill is mostly reference material — I'll inline a 200-line checklist" | Reference material belongs in `references/`. Skills are workflows, not reference docs. Move the long content out and cite it. |

## Red Flags

**Shared (both personas and skills):**
- Description starts with "Helps with…" or "Assists in…" (vague, non-delegating).
- Uses ALL-CAPS or reward/punishment language in the body.
- Name in frontmatter, filename (or directory), and H1 title do not all match.
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

## Verification

### Shared checklist (both types)

- [ ] Frontmatter has `name` and `description`, both present and valid YAML.
- [ ] Name is kebab-case and matches the file/directory and the H1 title.
- [ ] Description is action-oriented and ends with a concrete trigger clause.
- [ ] Cross-checked against `references/prompting-patterns.md` §2.2, §2.3, §2.4, §2.5, §3.1, §6.4 — no prohibitions, no contradictions, no ALL-CAPS, role/overview is specific.
- [ ] Scanned against existing files of the same type — no >30% overlap.
- [ ] Every sentence, if removed, would visibly change the artifact's output.

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
