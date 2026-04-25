---
description: Design and write a new agent persona or workflow skill
---

Use the `designing-sub-agents` skill.

Begin by understanding what the user wants to author:

1. Is this a persona, meaning a role or lens the agent adopts, or a skill, meaning a repeatable workflow with gated steps and verification?
2. What is the one-sentence purpose and when should it be invoked?
3. What framework or steps should it follow?
4. What are the explicit non-goals and scope limits?
5. What output shape should a typical invocation produce?

Then scan the target directory, usually `agents/` or `skills/`, for overlap. Draft the artifact using the matching template, verify the draft against prompting guidance when available, and confirm with the user before writing to `agents/<name>.md` or `skills/<name>/SKILL.md`.
