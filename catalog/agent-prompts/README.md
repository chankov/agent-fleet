# Reusable project-task prompt index

Prompts supplement existing Fleet skills and target policy, and are used by reference from target rules or commands. They are not automatically personas or independent slash entries. Adapt only prompts relevant to the requested task.

| When | Template | Target use |
| --- | --- | --- |
| A repository-specific requirements document is requested | [requirements-author.md](requirements-author.md) | Bind to an existing local document policy/template or discuss the missing governance before writing. |
| An architectural decision needs recording | [architecture-decision-author.md](architecture-decision-author.md) | Assess significance first; bind to the actual diff, local template, and governance. |

## Admission gate

A prompt ships only with a useful portable contract: bounded scope, rules references, and output/done-when — without duplicating a Fleet skill and without persona-router, fixed-timeout, or model-default behavior. Decided exclusions (generate target-local on explicit request instead): standalone PRD creator (covered by `requirements-author.md`), meta-agent and orchestrator prompts (covered by Fleet agent-design and orchestration skills; project prompts never route or spawn), operations decision/runbook/playbook prompts (bound to the target docs policy; select the types in `docs-maintenance.md` first).
