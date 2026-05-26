---
description: Design and write a new agent persona (agents/), workflow skill (skills/), or pi harness (.pi/harnesses/)
---

Invoke the agent-skills:designing-agents skill.

Begin by understanding what the user wants to author:
1. Is this a **persona** (a role/lens the agent adopts, e.g. a reviewer or auditor), a **skill** (a repeatable workflow with gated steps and verification), or a **pi harness** (a TypeScript pi extension that reshapes the session — footer, tool-call gate, new command, or orchestrator)?
2. The one-sentence purpose and when it should be invoked
3. The framework or steps — dimensions evaluated (persona), ordered workflow (skill), or session surface and events hooked (harness)
4. Explicit non-goals and scope limits
5. Output shape — what a typical invocation should produce

Then scan the target location (`agents/`, `skills/`, or `.pi/harnesses/`) for overlap, draft the artifact using the matching template — four-block persona structure, the section order from `docs/skill-anatomy.md`, or the harness pattern in `skills/designing-agents/pi-harness-authoring.md` — verify the draft against `references/prompting-patterns.md`, and confirm with the user before writing the file(s).
