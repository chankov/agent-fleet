---
"@chankov/agent-fleet": patch
---

Поправя CI portability при macOS `/var` aliases: canonical temp fixtures, безопасна physical trace containment и canonical scout roots. Launch fixture използва проектния SDK и само root dependencies; целият fast suite се проверява и със symlink-нат TMPDIR.

Поправя runtime regression проверките чрез избор на проектния Pi SDK вместо предположен global runtime, актуални lifecycle/status contracts и коректно task binding преди pressure probe.

Добавя сесиен избор на registered Git worktree с отделен Fleet workspace, target-scoped peers/evidence/workflows, immutable resume binding и ново per-consumer System 1 scope approval. Неподдържаните targeted btw/Hermes-conductor комбинации се отказват изрично; изборът не обещава OS или external-service isolation.
