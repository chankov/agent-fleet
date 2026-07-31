---
description: Design and write a new agent persona, workflow skill, or pi harness
---

Invoke the `designing-agents` skill via the `skill` tool.

Begin by understanding what the user wants to author:

1. Is this a persona (a role or lens the agent adopts), a skill (a repeatable workflow with gated steps and verification), or a pi harness (a TypeScript pi extension that reshapes the session)?
2. What is the one-sentence purpose and when should it be invoked?
3. What framework or steps should it follow?
4. What are the explicit non-goals and scope limits?
5. What output shape should a typical invocation produce?

Then scan the target location — `agents/`, `skills/`, or `.pi/harnesses/` — for overlap. Draft the artifact using the matching template, verify the draft against prompting guidance when available, and confirm with the user before writing the file(s).
