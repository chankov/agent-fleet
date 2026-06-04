---
"@chankov/agent-skills": patch
---

**guided-workspace-setup:** refresh the pi `justfile` and harness support files when harnesses change.

The guided setup installed and removed pi harness *directories* but never touched the `justfile` that launches them, so upgrading a workspace whose harness set had changed left a stale `justfile` — `just --list` still showed recipes for retired harnesses (pointing at deleted `.pi/harnesses/<name>/` dirs) and had no recipes for newly added ones (e.g. `hub`, `team-up` after the `agent-team` → `agent-hub` consolidation).

The `justfile` and the harness support files (`scripts/team-up.ts`, `scripts/coms-net-server.ts`, the peer/team YAML and personas, `.pi/damage-control-rules.yaml`, `.pi/harnesses/package.json`) are now companions of the pi harnesses group: installing, refreshing, or removing any harness refreshes them in the same pass. The `justfile` is refreshed from the **current** source — which prunes retired-harness recipes and adds new ones — and is subject to the same status/diff rules as every other artifact, so a user-edited `justfile` gets the three-way diff instead of a silent clobber. User-authored recipes are protected by an `agent-skills:harnesses` managed-region sentinel: only that region is rewritten. The `justfile` is now also captured in the per-version `.versions/` snapshot so the upgrade three-way diff has a recorded baseline.
