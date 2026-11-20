---
description: Set up or extend repository AI rules from the Fleet catalogue — discovery, proposal, grilling, diff, apply, verify. Pass an optional change request, e.g. /af-setup-rules add API compatibility rules.
---

Load and follow the `repository-ai-setup` skill before proceeding.

The argument ($ARGUMENTS) is an optional free-text change request (for example
"add API compatibility rules" or "adapt the translation command to the new
storage"). With no argument, discover gaps and propose applicable
additions or updates; an unchanged accepted state stays a byte-identical no-op.

Run only with a live user; the grilling interview is not valid in CI, a
headless `just flow` run, or any autonomous loop. In those contexts produce the
discovery analysis and proposal, say that you did, and leave decisions and
apply for a human. Never simulate questions or answers, never auto-accept
undecided policy, and never apply a change whose decisions are still open.

Hand accepted `rules:` / `docs:` roots to `agent-fleet configure`
(preview with `--dry-run`, apply with `--expect-hash <expectedHash> --yes`);
never edit `.ai/agent-fleet-overrides.md` directly.
