# Prompting Patterns Reference

Consolidated prompt-engineering best practices for authoring instructions that coding agents will follow. Use alongside the `designing-sub-agents`, `context-engineering`, and `using-agent-skills` skills, and consult this file before finalizing any agent persona, slash command, skill, or rule file.

## How to Use This Reference

Three primary audiences:

1. **Persona authors** writing files under `agents/` — check sections 1-3, 6, 7, 12 before writing.
2. **Skill authors** writing files under `skills/` — check sections 1, 2, 4, 6.4, 7, 12 before writing.
3. **Rule-file authors** writing project rules (CLAUDE.md, AGENTS.md, or supplementary rule files) — check sections 1.4, 2, 9, 11, 12.

Source attribution key: **[A]** = Anthropic, **[O]** = OpenAI, **[A+O]** = both vendors agree.

## Table of Contents

1. [Structural Foundations](#1-structural-foundations)
2. [Clarity and Specificity](#2-clarity-and-specificity)
3. [Role and Identity](#3-role-and-identity)
4. [Examples (Few-Shot Prompting)](#4-examples-few-shot-prompting)
5. [Tool Use and Function Calling](#5-tool-use-and-function-calling)
6. [Agentic Behavior](#6-agentic-behavior)
7. [Output Control](#7-output-control)
8. [Thinking and Reasoning](#8-thinking-and-reasoning)
9. [Layered Configuration Architecture](#9-layered-configuration-architecture)
10. [Long-Horizon and Multi-Session Workflows](#10-long-horizon-and-multi-session-workflows)
11. [Prompt Maintenance and Iteration](#11-prompt-maintenance-and-iteration)
12. [Anti-Patterns to Avoid](#12-anti-patterns-to-avoid)
13. [Sources](#sources)

---

## 1. Structural Foundations

### 1.1 Use a Clear, Hierarchical Section Layout [A+O]

Structure prompts and rules with labeled sections using Markdown headers or XML tags. A recommended template:

```
# Role and Objective
# Instructions
## Sub-categories
# Constraints
# Output Format
# Examples
```

- **[O]** Models trained on instruction-following (GPT-4.1+, Claude 4+) follow instructions more literally. Clear section labels help the model locate and apply the right rules at the right time.
- **[A]** Use numbered lists or bullet points when order or completeness matters.

### 1.2 Use XML Tags for Structured Sections [A+O]

- **[A]** XML tags are the preferred delimiter for separating instructions, context, examples, and variable inputs. Use consistent, descriptive tag names (`<instructions>`, `<context>`, `<constraints>`). Nest tags when content has natural hierarchy.
- **[O]** Use XML tags for nested examples and metadata-tagged documents. Use Markdown for prose sections.
- **[A+O]** Avoid JSON for large document collections — both vendors report performance degradation.

### 1.3 Instruction Placement Strategy [O]

For long-context prompts (20K+ tokens), place critical instructions at both the beginning **and** end of the prompt (the "sandwich" approach). This yields the best retrieval and adherence rates.

### 1.4 Put Data Above Instructions [A]

Place longform data (documents, code, reference material) at the top of the prompt, with instructions and queries at the end. Anthropic testing showed up to 30% improved response quality.

### 1.5 Later Instructions Take Priority [O]

In GPT-4.1+, when instructions conflict, the model prioritizes instructions appearing later. Use this to create a natural override hierarchy — put the most specific or important rules last.

---

## 2. Clarity and Specificity

### 2.1 Be Explicit, Not Implicit [A+O]

Treat the model like a brilliant but new team member who lacks context on your norms. Specify everything explicitly.

- **[A]** Golden rule: show your prompt to a colleague with minimal context. If they would be confused, the model will be too.
- **[O]** Newer models do exactly what you say. A single clarifying sentence can redirect behavior, but omissions lead to undesired output.
- **[A+O]** Instead of "write clean code," specify: "Use descriptive variable names. Extract repeated logic into helpers. Add JSDoc to exported functions."

### 2.2 Tell the Model What TO DO, Not What NOT to Do [A]

Positive instructions are more effective than prohibitions.

- Instead of: "Do not use markdown"
- Write: "Your response should be composed of smoothly flowing prose paragraphs."

### 2.3 Explain WHY Behind Rules [A]

Providing motivation behind instructions helps the model generalize correctly and handle edge cases better.

- Instead of: "NEVER use ellipses"
- Write: "Never use ellipses because the response will be read aloud by a text-to-speech engine that cannot pronounce them."
- Instead of: "Always use absolute paths"
- Write: "Use absolute paths because the working directory resets between shell calls, so relative paths will break."

### 2.4 Eliminate Contradictions [O]

Thoroughly review prompts for ambiguities and contradictions. Reasoning models (o1/o3, Claude extended thinking) expend tokens trying to reconcile conflicting directives rather than ignoring them.

- Example conflict: "Be concise" + "Err on the side of completeness."
- Resolution: "Default to concise responses (2-5 sentences). Provide detailed responses only when the change spans more than 3 files or the user explicitly requests detail."

### 2.5 Remove Unnecessary Emphasis Patterns [A+O]

- **[O]** Avoid ALL-CAPS emphasis and reward/punishment language. These are unnecessary for modern models (GPT-4.1+) and can be counterproductive.
- **[A]** Replace "CRITICAL: You MUST use this tool when..." with normal language like "Use this tool when..." Claude 4+ models are significantly more responsive to the system prompt; aggressive language causes overtriggering.

---

## 3. Role and Identity

### 3.1 Set a Role [A+O]

- **[A]** Set a role in the system prompt to focus behavior and tone. Even a single sentence makes a difference.
- **[O]** Frame coding agents as an autonomous senior pair-programmer who gathers context, plans, implements, tests, and refines without waiting for intermediate prompts.

### 3.2 Scale Role Complexity to Task [A]

For simple tasks, a one-line role suffices. For complex agent systems, describe the persona's expertise, priorities, and behavioral constraints in detail.

---

## 4. Examples (Few-Shot Prompting)

### 4.1 Include Relevant Examples [A+O]

- **[A]** Include 3-5 well-crafted examples to steer output format, tone, and structure. Wrap examples in `<example>` tags so the model distinguishes them from instructions.
- **[O]** Combine few-shot examples into a concise YAML-style or bulleted block. Place them in a dedicated `# Examples` section.

### 4.2 Example Quality Requirements [A]

Good examples must be:
- **Relevant** — mirror your actual use case closely.
- **Diverse** — cover edge cases to prevent unintended pattern-matching.
- **Structured** — wrapped in tags to distinguish from instructions.

### 4.3 Reasoning Models Need Fewer Examples [O]

For reasoning models (o1/o3), use zero-shot or at most one example. Multiple examples constrain internal reasoning rather than helping it.

### 4.4 Show Reasoning Patterns in Examples [A]

Include `<thinking>` tags inside few-shot examples to demonstrate desired reasoning patterns. The model will generalize that reasoning style.

---

## 5. Tool Use and Function Calling

### 5.1 Use Native API Tool Definitions [O]

Use the API-native `tools` field rather than manually injecting tool descriptions into prompt text. OpenAI testing showed 2% performance gain.

### 5.2 Tool Description Best Practices [A+O]

- **[A+O]** Use clear, semantically meaningful tool names.
- **[O]** Include "when to use" and "when not to use" guidance.
- **[O]** Add a safety valve: "If insufficient information to call the tool, ask the user."
- **[A]** Use normal language instead of aggressive prompting. Replace "Default to using [tool]" with "Use [tool] when it would enhance your understanding of the problem."

### 5.3 Enable Parallel Tool Calls [A+O]

- **[A+O]** Explicitly prompt for parallel tool execution when calls are independent.
- **[A]** Recommended phrasing: "If you intend to call multiple tools and there are no dependencies between the tool calls, make all independent calls in parallel. If some calls depend on previous results, do NOT call them in parallel."
- **[O]** "Think first before any tool call and decide all needed files upfront. Batch everything together."

### 5.4 Prefer Dedicated Tools Over Shell [A+O]

- **[A]** Use Read instead of cat, Edit instead of sed, Grep instead of grep.
- **[O]** Use apply_patch, read_file, semantic_search as defaults. Only invoke the shell when no specialized tool exists.

### 5.5 Add Tools Incrementally [O]

Start with 1-2 tools that eliminate current manual loops. Adding too many tools at once confuses tool selection and increases incorrect calls.

---

## 6. Agentic Behavior

### 6.1 The Three Critical Agent Instructions [O]

Anchor every coding agent prompt with:

1. **Persistence:** "Keep going until the user's query is completely resolved. Only terminate when you are sure the problem is solved."
2. **Tool utilization:** "If you are not sure about file content or codebase structure, use your tools to read files. Do NOT guess or make up an answer."
3. **Planning:** Require explicit reasoning steps before tool calls rather than silent tool-call chains.

OpenAI testing showed these three instructions boosted SWE-bench scores by ~20%.

### 6.2 Provide Clear Completion Criteria [O]

Every task prompt should include a "Done When" section. Example: "Done when: all existing tests pass, the new endpoint returns the correct schema, and no TypeScript errors remain."

### 6.3 Investigate Before Answering [A]

Never speculate about code you have not opened. If the user references a specific file, read it before answering. Give grounded, hallucination-free answers.

### 6.4 Prevent Overengineering [A]

Explicitly instruct:
- Do not add features, refactor code, or make "improvements" beyond what was asked.
- Do not add docstrings, comments, or type annotations to code you did not change.
- Do not add error handling for scenarios that cannot happen. Only validate at system boundaries.
- Do not create helpers or utilities for one-time operations.

### 6.5 Prevent Test-Focused Hard-Coding [A]

"Implement solutions that work correctly for all valid inputs, not just the test cases. Do not hard-code values. Tests verify correctness — they do not define the solution."

### 6.6 Balance Autonomy and Safety [A+O]

- **[A]** Consider reversibility and blast radius. Take local, reversible actions freely. Confirm before destructive operations (deleting files, force-pushing, dropping tables).
- **[O]** Start restrictive, widen permissions based on observed needs. Do not grant full permissions before understanding workflows.

### 6.7 Subagent Orchestration [A]

Use subagents when tasks can run in parallel, require isolated context, or involve independent workstreams. For simple tasks, single-file edits, or tasks requiring context continuity, work directly.

### 6.8 Require Verification Loop [O]

Include a verification loop in agent workflows:
1. Write or update tests for changes.
2. Run relevant test suites.
3. Execute lint, formatting, and type checks.
4. Confirm final behavior matches requirements.
5. Review diffs for bugs, regressions, or risky patterns.

---

## 7. Output Control

### 7.1 Scale Output to Change Size [O]

- Tiny changes (10 lines or fewer): 2-5 sentences, 0-1 short snippet.
- Medium changes: 6 bullets or fewer, 1-2 snippets (8 lines max each).
- Large changes: Summarize per file with 1-2 bullets; avoid inlining code.

### 7.2 Reference Files, Don't Reproduce Code [O]

Reference file paths instead of showing large code blocks. Show code only when necessary to clarify intent.

### 7.3 Suppress Unnecessary Output [O]

Omit build/lint/test logs unless explicitly requested or they reveal blocking errors. Report outcomes, not processes.

### 7.4 Control Format via Prompt Style [A]

Match your prompt formatting to desired output formatting. If your prompt is markdown-heavy, the output will be too. Remove markdown from your prompt if you want prose output.

### 7.5 Eliminate Preambles [A]

Use direct instructions: "Respond directly without preamble. Do not start with phrases like 'Here is...', 'Based on...', etc."

---

## 8. Thinking and Reasoning

### 8.1 Use Adaptive Thinking [A]

Prefer adaptive thinking (`thinking: {type: "adaptive"}`) with the `effort` parameter instead of manual `budget_tokens`. Claude dynamically decides when and how much to think.

### 8.2 Reasoning Effort as a Tuning Knob [A+O]

- **[A]** `low` for high-volume, `medium` for most apps, `high` for complex coding, `max` for hardest problems.
- **[O]** Lower reasoning effort with better prompts can match higher reasoning effort with poor prompts.

### 8.3 Prefer General Instructions Over Prescriptive Steps [A]

"Think thoroughly" often produces better reasoning than a hand-written step-by-step plan. Let the model organize its own thinking.

### 8.4 Ask the Model to Self-Check [A]

"Before you finish, verify your answer against [test criteria]." This catches errors reliably, especially for coding and math.

### 8.5 Reasoning Models Need Simpler Prompts [O]

Do NOT use chain-of-thought instructions ("think step by step") with reasoning models (o1/o3). They generate internal CoT; external prompting conflicts with it and can degrade performance.

---

## 9. Layered Configuration Architecture

### 9.1 Structure Guidance in Layers [O]

Build a layered configuration system:
1. **Task prompt** — immediate goal, context, constraints, done-when.
2. **Rules files** (CLAUDE.md / AGENTS.md) — durable, reusable rules for the repository.
3. **Configuration files** — model choice, reasoning effort, sandbox mode.
4. **Tools** — external system integrations.
5. **Skills** — packaged repeatable workflows.

### 9.2 Keep Rules Files Concise [A+O]

- **[O]** "A short, accurate rules file is more useful than a long file full of vague rules." Add rules only after noticing repeated mistakes.
- **[A]** Keep the always-loaded core small. Load domain and task rules only when the current task needs them.

### 9.3 Hierarchical Override Strategy [O]

Use a three-layer override hierarchy (global → repository → subdirectory). General rules are inherited; specific directories can override them.

---

## 10. Long-Horizon and Multi-Session Workflows

### 10.1 Context Persistence [A]

Tell the model about context compaction: "Your context window will be automatically compacted as it approaches its limit. Do not stop tasks early due to token budget concerns. Save progress and state to memory before the context window refreshes."

### 10.2 State Management [A]

- Use structured JSON for state data (test results, task status).
- Use freeform text for progress notes.
- Use git for state tracking across sessions.
- Create setup scripts to prevent repeated work when continuing from a fresh context.

### 10.3 Resuming Fresh Context Windows [A]

Be prescriptive about how the model should resume: "Review progress files, test status, and git logs. Run a fundamental integration test before implementing new features."

---

## 11. Prompt Maintenance and Iteration

### 11.1 Start Minimal, Add Rules for Observed Failures [A+O]

- **[O]** Start with the smallest prompt that passes evaluations. Add blocks only when they fix a measured failure mode.
- **[A]** Dial back anti-laziness prompting. Prompts designed for older models may cause overtriggering on newer ones.

### 11.2 Use the Model as Its Own Optimizer [O]

When a prompt underperforms, ask the model to diagnose root causes and propose surgical revisions. Focus on clarifying conflicts and tightening vague rules rather than full rewrites.

### 11.3 Build Evaluations Before Changing Prompts [O]

Build evaluation systems to measure prompt behavior before deploying changes. Pin production applications to specific model snapshots. Run evaluations every time you publish prompt changes.

### 11.4 Audit for Model Generation Changes [A]

When upgrading to a new model generation:
- Replace blanket defaults with targeted instructions.
- Remove aggressive "If in doubt, use [tool]" prompting.
- Test for overtriggering and overengineering.
- Adjust emphasis patterns (remove ALL-CAPS, reward/punishment language).

---

## 12. Anti-Patterns to Avoid [A+O]

| Anti-Pattern | Source | Fix |
|---|---|---|
| Overloading prompts with durable rules | O | Move to rules files or repository docs |
| No build/test feedback to agent | O | Include verification loop |
| Skipping planning on complex tasks | O | Use plan mode or require explicit planning |
| ALL-CAPS and reward language | A+O | Use structured formatting instead |
| Contradictory instructions | O | Audit and resolve before deployment |
| Aggressive tool prompting ("MUST use") | A | Use normal language ("Use this when...") |
| Many few-shot examples for reasoning models | O | Use zero-shot or one example max |
| Not explaining WHY behind rules | A | Add motivation to help generalization |
| Telling model what NOT to do | A | Reframe as positive instructions |
| One thread per project instead of per task | O | One thread per coherent unit of work |
| Forcing tool calls without sufficient info | O | Add "ask the user" safety valve |
| Sample phrases repeated verbatim | O | Instruct variation explicitly |

---

## Sources

### Anthropic
- [Claude Prompting Best Practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview) (consolidated guide)
- [Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [Extended Thinking](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)

### OpenAI
- [GPT-4.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide/)
- [GPT-5 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide/)
- [GPT-5.1 Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-1_prompting_guide/)
- [Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide/)
- [Codex Best Practices](https://developers.openai.com/codex/learn/best-practices/)
- [Prompt Engineering Guide](https://developers.openai.com/api/docs/guides/prompt-engineering/)
- [Reasoning Models Guide](https://platform.openai.com/docs/guides/reasoning)
