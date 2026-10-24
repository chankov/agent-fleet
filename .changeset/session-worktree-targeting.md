---
"@chankov/agent-fleet": patch
---

Поправя runtime regression проверките чрез избор на проектния Pi SDK вместо предположен global runtime, актуални lifecycle/status contracts и коректно task binding преди pressure probe.

Добавя сесиен избор на registered Git worktree с отделен Fleet workspace, target-scoped peers/evidence/workflows, immutable resume binding и ново per-consumer System 1 scope approval. Неподдържаните targeted btw/Hermes-conductor комбинации се отказват изрично; изборът не обещава OS или external-service isolation.
