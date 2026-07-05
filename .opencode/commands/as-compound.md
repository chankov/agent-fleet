---
description: Capture this session's lessons into the project's rules and docs — compound engineering pass
---

Invoke the `compound-learning` skill via the `skill` tool.

Capture this session's lessons into the project's own rules (HOW) and docs (WHAT/WHY), optionally focused on `$ARGUMENTS`:

1. Resolve the targets: read `.ai/agent-skills-overrides.md` — the `## agent-hub` (legacy `## agent-team`) section's `rules:` and `docs:` keys name the rule folders and documentation entry points. If absent, locate an existing rules/docs tree and confirm it with the user; never invent a new tree.
2. Gather the evidence: this conversation (user corrections, decisions, rejected approaches), the session's `git diff` / `git log`, and any review findings produced during the session.
3. Extract at most 5 candidate lessons — each one imperative sentence plus a one-line Why (the failure it prevents) and a one-line Evidence (what happened this session). Classify each as rule, doc, or neither; the default verdict is neither.
4. Dedupe index-first: read the rules tree's `README.md`/`index.md` manifest, grep for existing coverage, and prefer sharpening an existing rule in place over adding a new one.
5. Propose the surviving lessons — target file, Why, Evidence, and the exact diff — and wait for approval. The user filters preferences-of-the-moment from durable policy.
6. Apply the approved diffs as minimal edits to existing files (at most 1 new file, registered in the tree's index), verify links and indexes still resolve, and report the changes file by file.

Run this at the end of a session, before the context is gone. If nothing rises to a lesson, say so and stop — compounding a smooth session produces filler.
