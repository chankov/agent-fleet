---
"@chankov/agent-fleet": patch
---

Put the Hermes Desktop fleet panel on the front page, and say plainly which subscriptions the fleet runs on.

`agent-fleet-herdr` had a thorough runbook and no way in. It is now a first-page section of the README with its own install how-to, a `mermaid` diagram of what it reads, and screenshots of the panel and the session modal — plus the same install path in `docs/getting-started.md`, a two-integration table at the top of `hermes/README.md` (the Desktop panel reads the fleet; the question bridge lets the fleet ask you — easy to conflate, independent to run), and a runtime-layer row in `docs/ARCHITECTURE.md`.

`docs/hermes-desktop-plugins.md` gains the part the runbook never had: **how it connects to Agent Fleet**. Four sources, each named with what it contributes and which module writes it — the coms registry (who exists, and the filter), herdr pane presence (what state), the agent's own transcript (what it is doing), the agent-hub monitor (which subagents are running) — and the two consequences that matter to an operator: nothing about launching a fleet changes, and the only write doors are `focus` and subagent `cancel`, both re-derived server-side. The Install section now leads with a prerequisites table, because "an empty panel" is the shared symptom of a missing prerequisite and of a correctly idle fleet.

**Bring your own subscriptions — and your own GPUs** is a new README section. Mixing providers inside one fleet is the normal configuration here, not an edge case, and the README never said so: Codex/ChatGPT and GitHub Copilot subscriptions, a real Claude Code pane bridged in as a coms peer, Ollama cloud or local, and locally hosted weights for the always-on cheap roles. It is also the argument for cross-model review — a `builder` and a `code-reviewer` on different labs' models catch what one model rationalizes past — and for the three-tier ladder, where recon runs on your own hardware and only synthesis spends the expensive tier.
