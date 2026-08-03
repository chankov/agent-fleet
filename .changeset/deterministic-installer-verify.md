---
"@chankov/agent-fleet": minor
---

Add the deterministic installer's catalogue and read-only inspection pass (Phases 0–2 of `plans/deterministic-installer.md`).

- **`install-manifest.json`** — a generated catalogue of every installable artifact: source candidates, per-agent target and strategy, group, recommendation, consent class, and companion wiring. Built from the repository tree by `node bin/build-manifest.js`; `--check` fails when the committed copy is stale, so an artifact landing without a menu row is a test failure rather than a silent omission. Only judgement (grouping, recommendations, consent, companions) is hand-edited, in `manifest-meta.json`.
- **`agent-fleet verify`** — a read-only report of a workspace against the manifest: what the new `.ai/agent-fleet-state.json` records, what is on disk, and what the current package ships, including the three-way comparison against the `.versions/<recorded>` snapshot. Writes nothing. Supports `--agent`, `--workspace`, `--json`, `--no-doctor`, and exits `0`/`1`/`2`. The existing doctor findings are folded into the same report; findings are split into `problem` and `advisory`, and only problems affect the exit code.

No existing behaviour changes: `init`, `doctor`, `update`, and the guided setup skill are untouched.
