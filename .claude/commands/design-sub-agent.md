---
description: Design and write a new agent persona (agents/) or workflow skill (skills/)
---

Invoke the agent-skills:designing-sub-agents skill.

Begin by understanding what the user wants to author:
1. Is this a **persona** (a role/lens the agent adopts, e.g. a reviewer or auditor) or a **skill** (a repeatable workflow with gated steps and verification)?
2. The one-sentence purpose and when it should be invoked
3. The framework or steps — dimensions evaluated (persona) or ordered workflow (skill)
4. Explicit non-goals and scope limits
5. Output shape — what a typical invocation should produce

Then scan the target directory (`agents/` or `skills/`) for overlap, draft the artifact using the matching template (four-block persona structure or the section order from `docs/skill-anatomy.md`), verify the draft against `references/prompting-patterns.md`, and confirm with the user before writing to `agents/<name>.md` or `skills/<name>/SKILL.md`.
