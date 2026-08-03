---
"@chankov/agent-fleet": minor
---

`guided-workspace-setup` becomes a front-end over the installer instead of the installer (Phase 7 of `plans/deterministic-installer.md`).

The skill is 544 lines shorter than it was — 220 down from 544 — because everything it used to describe now runs as code. Gone: the per-agent path table, the item-state table, the merge rules, the removal-ownership rules, the harness companion closure, and the `af-` migration procedure. What remains is what a program cannot do: ask which artifacts a project wants, draft `.ai/agent-fleet-overrides.md` from a scan of the workspace, and run the `pi-voice-stt` provider Q&A.

- **One command builds the menu.** `verify --json` now carries `groups` (agent-filtered), `profiles`, and per-item `subcategory`, `title`, `summary`, `recommended`, `owned`, and `state` — so the selection screen comes from a single call, and no front-end recomputes an item's state by eye.
- **The five setup/doctor slash commands were rewritten the same way.** They had each accumulated their own copy of the same rules.

Three rules that had only ever existed as prose are now encoded, and tested as behaviour:

- **Fleet Core** — the set `just fleet` loads into every session — is `requires` plus `pinnedBy` in the manifest. Installing any pi harness pulls the whole closure; uninstalling a member while a harness is installed is refused. A test parses `fleet_core_extensions` out of the `justfile` and fails if the manifest disagrees.
- **The `af-` prompt migration.** A workspace set up before the namespace still has `.pi/prompts/spec.md`, and pi keeps offering `/spec` from it. Commands now declare the unprefixed path they replaced; installing retires it under the ownership rule (a same-named prompt you wrote yourself is kept), and `verify` reports a surviving one as an advisory finding.
- **Stripping the `justfile` region.** Removing the last pi harness used to leave the managed block behind, so `just --list` kept advertising recipes for deleted harness directories.

Docs updated: `docs/npm-install.md` (the `doctor`, `uninstall`, and consent-class sections; CI usage is now the no-LLM install), and `docs/agent-fleet-setup.md` (the state file and the three-way merge, replacing the prose status table).
